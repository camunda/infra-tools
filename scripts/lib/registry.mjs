import { createHash } from 'node:crypto';

export const MEDIA = {
  ociIndex: 'application/vnd.oci.image.index.v1+json',
  ociManifest: 'application/vnd.oci.image.manifest.v1+json',
  dockerList: 'application/vnd.docker.distribution.manifest.list.v2+json',
  dockerManifest: 'application/vnd.docker.distribution.manifest.v2+json',
  empty: 'application/vnd.oci.empty.v1+json',
};
const ACCEPT = [MEDIA.ociIndex, MEDIA.ociManifest, MEDIA.dockerList, MEDIA.dockerManifest].join(', ');
export const EMPTY_DIGEST = 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a';

export const sha256 = (data) => `sha256:${createHash('sha256').update(data).digest('hex')}`;

// Minimal OCI distribution client: anonymous or token auth (GHCR accepts any user name with a GitHub token).
export class Registry {
  constructor(repository, { token = process.env.INFRA_TOOLS_REGISTRY_TOKEN ?? process.env.GITHUB_TOKEN, scheme = process.env.INFRA_TOOLS_REGISTRY_SCHEME ?? 'https' } = {}) {
    const slash = repository.indexOf('/');
    this.host = repository.slice(0, slash);
    this.name = repository.slice(slash + 1);
    this.repository = repository;
    this.base = `${scheme}://${this.host}/v2/${this.name}`;
    this.token = token;
    this.bearer = {};
  }

  async request(path, { method = 'GET', headers = {}, body, push = false, ok = [200] } = {}) {
    const scope = push ? 'pull,push' : 'pull';
    const url = path.startsWith('http') ? path : `${this.base}${path}`;
    for (let attempt = 1; ; attempt++) {
      const auth = this.bearer[scope] ? { Authorization: `Bearer ${this.bearer[scope]}` } : {};
      let res;
      try {
        res = await fetch(url, { method, headers: { ...headers, ...auth }, body, redirect: 'follow' });
      } catch (err) {
        if (attempt < 3) { await sleep(attempt * 1000); continue; }
        throw err;
      }
      if (res.status === 401 && !this.bearer[scope]) {
        await this.authenticate(res.headers.get('www-authenticate'), scope);
        continue;
      }
      if (res.status >= 500 && attempt < 3) { await sleep(attempt * 1000); continue; }
      if (!ok.includes(res.status)) {
        throw new Error(`${method} ${url}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
      }
      return res;
    }
  }

  async authenticate(challenge, scope) {
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

  // true when the manifest exists, false on 404; any other error throws (an outage must never read as "missing").
  async exists(reference) {
    const res = await this.request(`/manifests/${reference}`, { method: 'HEAD', headers: { Accept: ACCEPT }, ok: [200, 404] });
    return res.status === 200;
  }

  async manifest(reference) {
    const res = await this.request(`/manifests/${reference}`, { headers: { Accept: ACCEPT } });
    const body = Buffer.from(await res.arrayBuffer());
    return { digest: res.headers.get('docker-content-digest') ?? sha256(body), json: JSON.parse(body) };
  }

  async tags() {
    const tags = [];
    let next = `/tags/list?n=1000`;
    while (next) {
      const res = await this.request(next, { ok: [200, 404] });
      if (res.status === 404) return tags;
      tags.push(...((await res.json()).tags ?? []));
      const link = res.headers.get('link')?.match(/<([^>]+)>/)?.[1];
      next = link ? new URL(link, this.base).toString() : null;
    }
    return tags;
  }

  // Pushes by tag, or by digest when no tag is given.
  async putManifest(json, mediaType, tag) {
    const body = Buffer.from(JSON.stringify(json));
    const digest = sha256(body);
    await this.request(`/manifests/${tag ?? digest}`, { method: 'PUT', headers: { 'Content-Type': mediaType }, body, push: true, ok: [201, 202] });
    return { digest, size: body.length };
  }

  async ensureBlob(data) {
    const digest = sha256(data);
    const head = await this.request(`/blobs/${digest}`, { method: 'HEAD', push: true, ok: [200, 404] });
    if (head.status === 200) return digest;
    const start = await this.request('/blobs/uploads/', { method: 'POST', push: true, ok: [202] });
    const location = new URL(start.headers.get('location'), this.base);
    location.searchParams.set('digest', digest);
    await this.request(location.toString(), { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: data, push: true, ok: [201] });
    return digest;
  }

  // Platform → single layer of a line image (FROM scratch, one COPY).
  async lineLayers(tag) {
    const { json } = await this.manifest(tag);
    const manifests = json.manifests?.filter((m) => m.platform?.os === 'linux' && m.platform.architecture !== 'unknown') ?? [];
    const layers = {};
    for (const m of manifests) {
      const { json: image } = await this.manifest(m.digest);
      if (image.layers?.length !== 1) throw new Error(`${tag}: expected one layer for linux/${m.platform.architecture}, got ${image.layers?.length}`);
      layers[`linux/${m.platform.architecture}`] = image.layers[0];
    }
    return layers;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
