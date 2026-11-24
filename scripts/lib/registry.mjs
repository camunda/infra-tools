// Minimal OCI distribution client: token exchange as on ghcr.io (any user name) or Artifact Registry (oauth2accesstoken), or Basic
// auth on every request as on ECR (AWS, with the password of GetAuthorizationToken).
import { duration } from './log.mjs';
import { manifestBytes, MEDIA_TYPES, sha256 } from './oci.mjs';

const ACCEPT = [
  MEDIA_TYPES.index,
  MEDIA_TYPES.manifest,
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Waits before each retry of a transient error (ADR 0012): a step fails only when its error persists.
const RETRY_DELAYS = [2000, 4000, 8000];
// Statuses of a transient error: a rate limit, a server or gateway error.
const transient = (status) => status === 429 || status >= 500;

// fetch, retrying network errors and transient statuses after each of delays; the last response or error stands. Logs each
// retry with the URL's origin and path only, never a header: a query, such as a pre-signed URL's, can hold a credential.
async function fetchRetrying(url, options, delays, log) {
  const { origin, pathname } = new URL(url);
  for (let retry = 0; ; retry++) {
    let res;
    let error;
    try {
      res = await fetch(url, options);
    } catch (err) {
      if (retry >= delays.length) throw err;
      error = err.cause?.message ?? err.message;
    }
    if (res && (!transient(res.status) || retry >= delays.length)) return res;
    await res?.body?.cancel();
    log(`retry ${retry + 1}/${delays.length} in ${duration(delays[retry])}: ${options.method ?? 'GET'} ${origin}${pathname}: ${error ?? `HTTP ${res.status}`}`);
    await sleep(delays[retry]);
  }
}

// tagExists(tag) of checkCatalogTags against the tags of registry (Registry.exists).
export const tagExists = (registry) => (tag) => registry.exists(tag);

export class Registry {
  // repository: <registry>/<name>, e.g. ghcr.io/camunda/infra-tools.
  // user: token exchange user name. scheme: http for tests only. retryDelays: the waits before each retry of a transient error.
  // log: called with a line per retry, on stderr by default.
  constructor(repository, { token = process.env.GITHUB_TOKEN, user = 'token', scheme = 'https', retryDelays = RETRY_DELAYS, log = (line) => console.error(line) } = {}) {
    const slash = repository.indexOf('/');
    this.repository = repository;
    this.host = repository.slice(0, slash);
    this.name = repository.slice(slash + 1);
    this.base = `${scheme}://${this.host}/v2/${this.name}`;
    this.token = token;
    this.user = user;
    this.bearer = {};
    this.basic = null; // Authorization header of a registry that asked for Basic auth
    this.retryDelays = retryDelays;
    this.log = log;
  }

  // Retries network errors, rate limits and server errors with backoff; any status outside `ok` throws, so an outage never
  // reads as "missing".
  async request(path, { method = 'GET', headers = {}, body, push = false, ok = [200] } = {}) {
    const scope = push ? 'pull,push' : 'pull';
    const url = /^https?:\/\//.test(path) ? path : `${this.base}${path}`;
    for (;;) {
      const authorization = this.authorization(scope);
      const res = await fetchRetrying(url, { method, headers: { ...headers, ...(authorization && { Authorization: authorization }) }, body }, this.retryDelays, this.log);
      if (res.status === 401 && !authorization) {
        await this.login(res.headers.get('www-authenticate'), scope);
        continue;
      }
      if (!ok.includes(res.status)) throw new Error(`${method} ${url}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
      return res;
    }
  }

  // The Authorization header for scope once logged in, else undefined.
  authorization(scope) {
    return this.basic ?? (this.bearer[scope] && `Bearer ${this.bearer[scope]}`);
  }

  async login(challenge, scope) {
    if (/^Basic\b/i.test(challenge ?? '')) {
      if (!this.token) throw new Error(`${this.host}: Basic auth asked, without a token`);
      this.basic = `Basic ${Buffer.from(`${this.user}:${this.token}`).toString('base64')}`;
      return;
    }
    const params = Object.fromEntries([...(challenge ?? '').matchAll(/(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    if (!params.realm) throw new Error(`${this.host}: unsupported auth challenge: ${challenge}`);
    const url = new URL(params.realm);
    if (params.service) url.searchParams.set('service', params.service);
    url.searchParams.set('scope', `repository:${this.name}:${scope}`);
    const headers = this.token ? { Authorization: `Basic ${Buffer.from(`${this.user}:${this.token}`).toString('base64')}` } : {};
    const res = await fetchRetrying(url, { headers }, this.retryDelays, this.log);
    if (!res.ok) throw new Error(`${this.host}: token request failed: HTTP ${res.status}`);
    const json = await res.json();
    this.bearer[scope] = json.token ?? json.access_token;
  }

  // true when the reference exists, false on 404.
  async exists(reference) {
    const res = await this.request(`/manifests/${reference}`, { method: 'HEAD', headers: { Accept: ACCEPT }, ok: [200, 404] });
    return res.status === 200;
  }

  // Every tag of the repository, following the pages of the tag listing.
  async tags() {
    const tags = [];
    for (let path = '/tags/list?n=1000'; path; ) {
      const res = await this.request(path);
      tags.push(...((await res.json()).tags ?? []));
      const next = res.headers.get('link')?.match(/<([^>]+)>;\s*rel="next"/)?.[1];
      path = next && new URL(next, `${this.base}/`).toString();
    }
    return tags;
  }

  async manifest(reference) {
    const res = await this.request(`/manifests/${reference}`, { headers: { Accept: ACCEPT } });
    return res.json();
  }

  // The manifest as served ({ bytes, mediaType }), so a copy keeps its digest.
  async manifestBytes(reference) {
    const res = await this.request(`/manifests/${reference}`, { headers: { Accept: ACCEPT } });
    return { bytes: Buffer.from(await res.arrayBuffer()), mediaType: res.headers.get('content-type') };
  }

  // Checked against its digest.
  async blob(digest) {
    const res = await this.request(`/blobs/${digest}`);
    const bytes = Buffer.from(await res.arrayBuffer());
    if (sha256(bytes) !== digest) throw new Error(`${this.repository}: blob ${digest} does not match its digest`);
    return bytes;
  }

  async hasBlob(digest) {
    const res = await this.request(`/blobs/${digest}`, { method: 'HEAD', push: true, ok: [200, 404] });
    return res.status === 200;
  }

  // Digest of the manifest at a reference, from the bytes served.
  async digest(reference) {
    const res = await this.request(`/manifests/${reference}`, { headers: { Accept: ACCEPT } });
    return sha256(Buffer.from(await res.arrayBuffer()));
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
    return (await this.hasBlob(digest)) ? digest : this.uploadBlob(bytes);
  }

  async uploadBlob(bytes) {
    const digest = sha256(bytes);
    const start = await this.request('/blobs/uploads/', { method: 'POST', push: true, ok: [202] });
    const location = new URL(start.headers.get('location'), this.base);
    location.searchParams.set('digest', digest);
    await this.request(location.toString(), { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes, push: true, ok: [201] });
    return digest;
  }

  // The platforms of a tool image (['linux/amd64', 'linux/arm64']), from its index alone.
  async toolImagePlatforms(tag) {
    const index = await this.manifest(tag);
    return (index.manifests ?? []).filter(({ platform }) => platform?.os === 'linux' && platform.architecture !== 'unknown').map(({ platform }) => `linux/${platform.architecture}`);
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
