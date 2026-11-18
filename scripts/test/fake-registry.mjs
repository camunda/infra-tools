// Fake OCI registry for tests, over http on 127.0.0.1: bearer token exchange as on ghcr.io (pull, or pull and push), manifests by
// tag or digest, blobs and blob uploads. Records every request.
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
  corrupt = new Set(); // blob digests served with other bytes
  manifests = new Map(); // tag or digest → { mediaType, bytes }
  blobs = new Map(); // digest → bytes
  uploads = 0;

  async start() {
    this.server = createServer((req, res) => this.handle(req, res).catch((err) => res.writeHead(500).end(err.message)));
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.host = `127.0.0.1:${this.server.address().port}`;
    this.repository = `${this.host}/${REPOSITORY}`;
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

  // A tool image as Buildx pushes it: an image index with one single-layer manifest per platform ({ 'linux/amd64': bytes }).
  addToolImage(tag, layers) {
    const config = this.addBlob(Buffer.from('{}'));
    const manifests = Object.entries(layers).map(([platform, bytes]) => {
      const layer = { mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip', digest: this.addBlob(bytes), size: bytes.length };
      const manifest = { schemaVersion: 2, mediaType: MEDIA_TYPES.manifest, config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: config, size: 2 }, layers: [layer] };
      const [os, architecture] = platform.split('/');
      return { mediaType: MEDIA_TYPES.manifest, ...this.addManifest(manifest), platform: { os, architecture } };
    });
    this.addManifest({ schemaVersion: 2, mediaType: MEDIA_TYPES.index, manifests }, tag);
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
    if (url.pathname === '/token') {
      const basic = `Basic ${Buffer.from(`token:${TOKEN}`).toString('base64')}`;
      const scope = url.searchParams.get('scope')?.match(/^repository:(.+):(pull|pull,push)$/);
      if (req.headers.authorization !== basic || scope?.[1] !== REPOSITORY) return res.writeHead(401).end();
      return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ token: `bearer-${scope[2]}` }));
    }
    const write = !['GET', 'HEAD'].includes(req.method);
    const allowed = write ? ['Bearer bearer-pull,push'] : ['Bearer bearer-pull', 'Bearer bearer-pull,push'];
    if (!allowed.includes(req.headers.authorization)) {
      const challenge = `Bearer realm="http://${this.host}/token",service="${this.host}",scope="repository:${REPOSITORY}:pull"`;
      return res.writeHead(401, { 'WWW-Authenticate': challenge }).end();
    }
    const match = url.pathname.match(/^\/v2\/(.+?)\/(blobs\/uploads|manifests|blobs)\/(.*)$/);
    if (!match || match[1] !== REPOSITORY) return res.writeHead(404).end();
    const [, , kind, reference] = match;
    if (kind === 'blobs/uploads') return this.upload(req, res, url, reference);
    if (kind === 'manifests') return this.serveManifest(req, res, reference);
    return this.serveBlob(req, res, reference);
  }

  async serveManifest(req, res, reference) {
    if (req.method === 'PUT') {
      const bytes = await body(req);
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
      return res.writeHead(202, { Location: `/v2/${REPOSITORY}/blobs/uploads/${this.uploads}` }).end();
    }
    if (req.method !== 'PUT' || !id) return res.writeHead(404).end();
    const bytes = await body(req);
    if (sha256(bytes) !== url.searchParams.get('digest')) return res.writeHead(400).end('digest mismatch');
    this.addBlob(bytes);
    return res.writeHead(201).end();
  }
}
