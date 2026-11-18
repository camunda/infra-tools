// Minimal OCI distribution client for the source registry: token exchange as on ghcr.io (any user name with a GitHub token).
import { createHash } from 'node:crypto';
import { manifestBytes, MEDIA_TYPES } from './oci-index.mjs';

const ACCEPT = [
  MEDIA_TYPES.index,
  MEDIA_TYPES.manifest,
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class Registry {
  // repository: <registry>/<name>, e.g. ghcr.io/camunda/infra-tools.
  // scheme: http for tests only.
  constructor(repository, { token = process.env.GITHUB_TOKEN, scheme = 'https' } = {}) {
    const slash = repository.indexOf('/');
    this.repository = repository;
    this.host = repository.slice(0, slash);
    this.name = repository.slice(slash + 1);
    this.base = `${scheme}://${this.host}/v2/${this.name}`;
    this.token = token;
    this.bearer = {};
  }

  // Retries network errors and 5xx; any status outside `ok` throws, so an outage never reads as "missing".
  async request(path, { method = 'GET', headers = {}, body, push = false, ok = [200] } = {}) {
    const scope = push ? 'pull,push' : 'pull';
    const url = /^https?:\/\//.test(path) ? path : `${this.base}${path}`;
    for (let attempt = 1; ; attempt++) {
      const auth = this.bearer[scope] ? { Authorization: `Bearer ${this.bearer[scope]}` } : {};
      let res;
      try {
        res = await fetch(url, { method, headers: { ...headers, ...auth }, body });
      } catch (err) {
        if (attempt < 3) {
          await sleep(attempt * 1000);
          continue;
        }
        throw err;
      }
      if (res.status === 401 && !this.bearer[scope]) {
        await this.login(res.headers.get('www-authenticate'), scope);
        continue;
      }
      if (res.status >= 500 && attempt < 3) {
        await sleep(attempt * 1000);
        continue;
      }
      if (!ok.includes(res.status)) throw new Error(`${method} ${url}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
      return res;
    }
  }

  async login(challenge, scope) {
    const params = Object.fromEntries([...(challenge ?? '').matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    if (!params.realm) throw new Error(`${this.host}: unsupported auth challenge: ${challenge}`);
    const url = new URL(params.realm);
    if (params.service) url.searchParams.set('service', params.service);
    url.searchParams.set('scope', `repository:${this.name}:${scope}`);
    const headers = this.token ? { Authorization: `Basic ${Buffer.from(`token:${this.token}`).toString('base64')}` } : {};
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`${this.host}: token request failed: HTTP ${res.status}`);
    const json = await res.json();
    this.bearer[scope] = json.token ?? json.access_token;
  }

  // true when the reference exists, false on 404.
  async exists(reference) {
    const res = await this.request(`/manifests/${reference}`, { method: 'HEAD', headers: { Accept: ACCEPT }, ok: [200, 404] });
    return res.status === 200;
  }

  async manifest(reference) {
    const res = await this.request(`/manifests/${reference}`, { headers: { Accept: ACCEPT } });
    return res.json();
  }

  // Pushes a manifest by tag, or by its digest without one.
  async putManifest(manifest, tag) {
    const bytes = manifestBytes(manifest);
    return this.putManifestBytes(bytes, manifest.mediaType, tag ?? sha256(bytes));
  }

  // Pushes manifest bytes as they are, under a tag or their digest.
  async putManifestBytes(bytes, mediaType, reference) {
    await this.request(`/manifests/${reference}`, { method: 'PUT', headers: { 'Content-Type': mediaType }, body: bytes, push: true, ok: [201] });
    return sha256(bytes);
  }

  async ensureBlob(bytes) {
    const digest = sha256(bytes);
    const head = await this.request(`/blobs/${digest}`, { method: 'HEAD', push: true, ok: [200, 404] });
    if (head.status === 200) return digest;
    const start = await this.request('/blobs/uploads/', { method: 'POST', push: true, ok: [202] });
    const location = new URL(start.headers.get('location'), this.base);
    location.searchParams.set('digest', digest);
    await this.request(location.toString(), { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes, push: true, ok: [201] });
    return digest;
  }

  // The single layer of a tool image per platform ({ 'linux/amd64': { digest, size, mediaType } }).
  async toolImageLayers(tag) {
    const index = await this.manifest(tag);
    const layers = {};
    for (const { digest, platform } of index.manifests ?? []) {
      if (platform?.os !== 'linux' || platform.architecture === 'unknown') continue;
      const image = await this.manifest(digest);
      if (image.layers?.length !== 1) throw new Error(`${tag}: expected one layer for linux/${platform.architecture}, got ${image.layers?.length}`);
      const { mediaType, size } = image.layers[0];
      layers[`linux/${platform.architecture}`] = { digest: image.layers[0].digest, size, mediaType };
    }
    return layers;
  }
}
