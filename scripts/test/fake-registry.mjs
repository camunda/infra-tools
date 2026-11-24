// Fake OCI registry for tests, over http on 127.0.0.1: bearer token exchange as on ghcr.io (pull, or pull and push), manifests by
// tag or digest, tag listing (pageSize tags per page), blobs and blob uploads. Records every request.
// With metadataToken, it also plays Artifact Registry and the GKE metadata server. With ecrPassword, it plays ECR: Basic auth as
// AWS with that password on every request, no token exchange; with aws too, also STS and the ECR API, which give that password
// to a runner's IRSA role, and S3, where blob downloads redirect (aws.s3Host), recording the Authorization header it gets.
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

  s3Authorizations = []; // Authorization header of each S3 download, '' without one

  constructor({ name = REPOSITORY, metadataToken, ecrPassword, aws, user = 'token' } = {}) {
    this.name = name;
    this.metadataToken = metadataToken;
    this.ecrPassword = ecrPassword;
    this.aws = aws; // { roleArn, webIdentityToken, keyId, secret, session, region, s3Host }
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
    if (this.aws) {
      if (req.headers.host === this.aws.s3Host) {
        this.s3Authorizations.push(req.headers.authorization ?? '');
        return this.serveBlob(req, res, url.pathname.slice(1));
      }
      if (req.method === 'POST' && url.pathname === '/') return this.awsApi(req, res);
    }
    if (this.ecrPassword) {
      if (req.headers.authorization !== `Basic ${Buffer.from(`AWS:${this.ecrPassword}`).toString('base64')}`) {
        return res.writeHead(401, { 'WWW-Authenticate': `Basic realm="http://${this.host}/",service="ecr.amazonaws.com"` }).end();
      }
      return this.serve(req, res, url);
    }
    const write = !['GET', 'HEAD'].includes(req.method);
    const allowed = write ? ['Bearer bearer-pull,push'] : ['Bearer bearer-pull', 'Bearer bearer-pull,push', ...(this.metadataToken ? [`Bearer ${this.metadataToken}`] : [])];
    if (!allowed.includes(req.headers.authorization)) {
      const challenge = `Bearer realm="http://${this.host}/token",service="${this.host}",scope="repository:${this.name}:pull"`;
      return res.writeHead(401, { 'WWW-Authenticate': challenge }).end();
    }
    return this.serve(req, res, url);
  }

  serve(req, res, url) {
    if (url.pathname === `/v2/${this.name}/tags/list`) return this.listTags(res, url);
    const match = url.pathname.match(/^\/v2\/(.+?)\/(blobs\/uploads|manifests|blobs)\/(.*)$/);
    if (!match || match[1] !== this.name) return res.writeHead(404).end();
    const [, , kind, reference] = match;
    if (kind === 'blobs/uploads') return this.upload(req, res, url, reference);
    if (kind === 'manifests') return this.serveManifest(req, res, reference);
    return this.serveBlob(req, res, reference);
  }

  // STS AssumeRoleWithWebIdentity (form, unsigned) and ECR GetAuthorizationToken (JSON, SigV4 with the STS credentials), in JSON.
  async awsApi(req, res) {
    const { roleArn, webIdentityToken, keyId, secret, session, region } = this.aws;
    const json = (status, data) => res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(data));
    const received = (await body(req)).toString();
    if (req.headers['x-amz-target'] === 'AmazonEC2ContainerRegistry_V20150921.GetAuthorizationToken') {
      const signed = new RegExp(`^AWS4-HMAC-SHA256 Credential=${keyId}/\\d{8}/${region}/ecr/aws4_request, SignedHeaders=.*x-amz-security-token.*, Signature=[0-9a-f]{64}$`);
      if (!signed.test(req.headers.authorization ?? '') || req.headers['x-amz-security-token'] !== session) return json(403, { message: 'denied' });
      return json(200, { authorizationData: [{ authorizationToken: Buffer.from(`AWS:${this.ecrPassword}`).toString('base64') }] });
    }
    const form = new URLSearchParams(received);
    if (form.get('Action') !== 'AssumeRoleWithWebIdentity' || form.get('RoleArn') !== roleArn || form.get('WebIdentityToken') !== webIdentityToken) {
      return json(403, { message: 'denied' });
    }
    const credentials = { AccessKeyId: keyId, SecretAccessKey: secret, SessionToken: session };
    return json(200, { AssumeRoleWithWebIdentityResponse: { AssumeRoleWithWebIdentityResult: { Credentials: credentials } } });
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
    // ECR serves blobs from S3, through a pre-signed URL.
    if (this.aws && req.headers.host !== this.aws.s3Host) return res.writeHead(307, { Location: `http://${this.aws.s3Host}/${digest}` }).end();
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
