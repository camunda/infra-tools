// Fake OCI registry for tests, over http on 127.0.0.1: bearer token exchange as on ghcr.io (pull, or pull and push), manifests by
// tag or digest, tag listing (pageSize tags per page), blobs and blob uploads. Records every request.
// With metadataToken, it also plays Artifact Registry and the GKE metadata server.
import { createServer } from 'node:http';
import { MEDIA_TYPES, sha256 } from '../lib/oci.mjs';
import { indexEntries, ociIndex } from '../lib/oci-index.mjs';

export const REPOSITORY = 'camunda/infra-tools';
export const TOKEN = 'job-token';

const body = (req) =>
  new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });

export class FakeRegistry {
  requests = []; // "<method> <url>"
  failures = {}; // blob digest → number of 500 responses before serving it
  rejected = new Set(); // manifest tags whose push answers 500
  corrupt = new Set(); // blob digests served with other bytes
  manifests = new Map(); // tag or digest → { mediaType, bytes }
  blobs = new Map(); // digest → bytes
  uploads = 0;
  pageSize = 100; // tags per page of the tag listing

  constructor({ name = REPOSITORY, metadataToken, user = 'token' } = {}) {
    this.name = name;
    this.metadataToken = metadataToken;
    this.user = user; // oauth2accesstoken on Artifact Registry
  }

  async start() {
    this.server = createServer((req, res) => this.handle(req, res).catch((err) => res.writeHead(500).end(err.message)));
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.host = `127.0.0.1:${this.server.address().port}`;
    this.repository = `${this.host}/${this.name}`;
  }

  stop() {
    return new Promise((resolve) => this.server.close(resolve));
  }

  addBlob(bytes) {
    const digest = sha256(bytes);
    this.blobs.set(digest, bytes);
    return digest;
  }

  addManifest(manifest, tag) {
    return this.addManifestBytes(Buffer.from(JSON.stringify(manifest)), manifest.mediaType, tag);
  }

  addManifestBytes(bytes, mediaType, tag) {
    const digest = sha256(bytes);
    this.manifests.set(digest, { mediaType, bytes });
    if (tag) this.manifests.set(tag, { mediaType, bytes });
    return { digest, size: bytes.length };
  }

  manifest(reference) {
    const stored = this.manifests.get(reference);
    return stored && JSON.parse(stored.bytes);
  }

  // A tool image as Buildx pushes it: an image index with one single-layer manifest per platform ({ 'linux/amd64': bytes }), and
  // the annotations of the index.
  addToolImage(tag, layers, annotations) {
    const config = this.addBlob(Buffer.from('{}'));
    const manifests = Object.entries(layers).map(([platform, bytes]) => {
      const layer = { mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: this.addBlob(bytes), size: bytes.length };
      const manifest = { schemaVersion: 2, mediaType: MEDIA_TYPES.manifest, config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: config, size: 2 }, layers: [layer] };
      const [os, architecture] = platform.split('/');
      return { mediaType: MEDIA_TYPES.manifest, ...this.addManifest(manifest), platform: { os, architecture } };
    });
    return this.addManifest({ schemaVersion: 2, mediaType: MEDIA_TYPES.index, manifests, ...(annotations && { annotations }) }, tag);
  }

  addIndex(tag, entries) {
    const { index, manifests } = ociIndex(entries);
    for (const manifest of Object.values(manifests)) this.addManifest(manifest);
    this.addManifest(index, tag);
  }

  indexEntries(tag) {
    const index = this.manifest(tag);
    return indexEntries(index, Object.fromEntries(index.manifests.map(({ digest }) => [digest, this.manifest(digest)])));
  }

  async handle(req, res) {
    this.requests.push(`${req.method} ${req.url}`);
    const url = new URL(req.url, `http://${this.host}`);
    if (this.metadataToken && url.pathname === '/computeMetadata/v1/instance/service-accounts/default/token') {
      if (req.headers['metadata-flavor'] !== 'Google') return res.writeHead(403).end();
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ access_token: this.metadataToken, token_type: 'Bearer' }));
    }
    if (url.pathname === '/token') {
      const basic = `Basic ${Buffer.from(`${this.user}:${TOKEN}`).toString('base64')}`;
      const scope = url.searchParams.get('scope')?.match(/^repository:(.+):(pull|pull,push)$/);
      if (req.headers.authorization !== basic || scope?.[1] !== this.name) return res.writeHead(401).end();
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ token: `bearer-${scope[2]}` }));
    }
    const write = !['GET', 'HEAD'].includes(req.method);
    const allowed = write ? ['Bearer bearer-pull,push'] : ['Bearer bearer-pull', 'Bearer bearer-pull,push', ...(this.metadataToken ? [`Bearer ${this.metadataToken}`] : [])];
    if (!allowed.includes(req.headers.authorization)) {
      const challenge = `Bearer realm="http://${this.host}/token",service="${this.host}",scope="repository:${this.name}:pull"`;
      return res.writeHead(401, { 'WWW-Authenticate': challenge }).end();
    }
    if (url.pathname === `/v2/${this.name}/tags/list`) return this.listTags(res, url);
    const match = url.pathname.match(/^\/v2\/(.+?)\/(blobs\/uploads|manifests|blobs)\/(.*)$/);
    if (!match || match[1] !== this.name) return res.writeHead(404).end();
    const [, , kind, reference] = match;
    if (kind === 'blobs/uploads') return this.upload(req, res, url, reference);
    if (kind === 'manifests') return this.serveManifest(req, res, reference);
    return this.serveBlob(req, res, reference);
  }

  // Tags in lexical order, a page at a time: the next page is linked with `last`, as on ghcr.io.
  listTags(res, url) {
    const last = url.searchParams.get('last');
    const n = Math.min(Number(url.searchParams.get('n') ?? this.pageSize), this.pageSize);
    const tags = [...this.manifests.keys()].filter((r) => !r.startsWith('sha256:')).sort().filter((t) => !last || t > last);
    const page = tags.slice(0, n);
    const headers = { 'Content-Type': 'application/json' };
    if (tags.length > n) headers.Link = `</v2/${this.name}/tags/list?n=${n}&last=${encodeURIComponent(page.at(-1))}>; rel="next"`;
    return res.writeHead(200, headers).end(JSON.stringify({ name: this.name, tags: page }));
  }

  async serveManifest(req, res, reference) {
    if (req.method === 'PUT') {
      const bytes = await body(req);
      if (this.rejected.has(reference)) return res.writeHead(500).end();
      const mediaType = req.headers['content-type'];
      if (JSON.parse(bytes).mediaType !== mediaType) return res.writeHead(400).end('media type mismatch');
      const byDigest = reference.startsWith('sha256:');
      if (byDigest && reference !== sha256(bytes)) return res.writeHead(400).end('digest mismatch');
      const { digest } = this.addManifestBytes(bytes, mediaType, byDigest ? undefined : reference);
      return res.writeHead(201, { 'Docker-Content-Digest': digest }).end();
    }
    const stored = this.manifests.get(reference);
    if (!stored) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': stored.mediaType, 'Docker-Content-Digest': sha256(stored.bytes) });
    return res.end(req.method === 'HEAD' ? undefined : stored.bytes);
  }

  serveBlob(req, res, digest) {
    if (!this.blobs.has(digest)) return res.writeHead(404).end();
    if (this.failures[digest] > 0) {
      this.failures[digest]--;
      return res.writeHead(500).end();
    }
    const bytes = this.corrupt.has(digest) ? Buffer.concat([this.blobs.get(digest), Buffer.from('x')]) : this.blobs.get(digest);
    res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length });
    return res.end(req.method === 'HEAD' ? undefined : bytes);
  }

  // Monolithic upload: POST starts it, PUT ?digest= sends the bytes.
  async upload(req, res, url, id) {
    if (req.method === 'POST' && id === '') {
      this.uploads++;
      return res.writeHead(202, { Location: `/v2/${this.name}/blobs/uploads/${this.uploads}` }).end();
    }
    if (req.method !== 'PUT' || !id) return res.writeHead(404).end();
    const bytes = await body(req);
    if (sha256(bytes) !== url.searchParams.get('digest')) return res.writeHead(400).end('digest mismatch');
    this.addBlob(bytes);
    return res.writeHead(201).end();
  }
}
