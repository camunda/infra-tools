// The index as an OCI artifact (D3, ADR 0004): an image index with one artifact manifest per platform, whose layers are the
// tool image layers, annotated with the tool version they hold. The action reads these annotations (scripts/action/setup.sh).
import { createHash } from 'node:crypto';
import { PLATFORMS } from './tool-definition.mjs';

export const MEDIA_TYPES = {
  index: 'application/vnd.oci.image.index.v1+json',
  manifest: 'application/vnd.oci.image.manifest.v1+json',
  empty: 'application/vnd.oci.empty.v1+json',
};
const ARTIFACT_TYPE = 'application/vnd.camunda.infra-tools.index.v1+json';
// The empty config blob, `{}`.
export const EMPTY_CONFIG = { mediaType: MEDIA_TYPES.empty, digest: 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', size: 2 };

const PREFIX = 'io.camunda.infra-tools';
// Annotation key per index entry field; add-to-path is left out for tool-cache tools.
const ANNOTATIONS = {
  tool: 'tool',
  version: 'version',
  line: 'line',
  folderVersion: 'folder-version',
  revision: 'revision',
  tag: 'tag',
  cacheFolder: 'cache-folder',
  archFolder: 'arch-folder',
  addToPath: 'add-to-path',
};

// The bytes pushed for a manifest, which its digest and size are computed from.
export const manifestBytes = (manifest) => Buffer.from(JSON.stringify(manifest));

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

// Index entries (release.mjs buildIndex) to the image index and its manifests, keyed by digest.
export function ociIndex(entries) {
  const manifests = {};
  const descriptors = PLATFORMS.map((platform) => {
    const manifest = {
      schemaVersion: 2,
      mediaType: MEDIA_TYPES.manifest,
      artifactType: ARTIFACT_TYPE,
      config: EMPTY_CONFIG,
      layers: entries.filter((e) => e.platform === platform).map(toLayer),
    };
    const bytes = manifestBytes(manifest);
    const digest = sha256(bytes);
    manifests[digest] = manifest;
    const [os, architecture] = platform.split('/');
    return { mediaType: MEDIA_TYPES.manifest, artifactType: ARTIFACT_TYPE, digest, size: bytes.length, platform: { os, architecture } };
  });
  return { index: { schemaVersion: 2, mediaType: MEDIA_TYPES.index, artifactType: ARTIFACT_TYPE, manifests: descriptors }, manifests };
}

// The entries of an image index, given its manifests keyed by digest.
export function indexEntries(index, manifests) {
  return index.manifests.flatMap(({ digest, platform }) =>
    manifests[digest].layers.map((layer) => fromLayer(`${platform.os}/${platform.architecture}`, layer)),
  );
}

function toLayer(entry) {
  const annotations = {};
  for (const [field, key] of Object.entries(ANNOTATIONS)) {
    if (entry[field] !== null && entry[field] !== undefined) annotations[`${PREFIX}.${key}`] = String(entry[field]);
  }
  return { mediaType: entry.mediaType, digest: entry.digest, size: entry.size, annotations };
}

function fromLayer(platform, layer) {
  const entry = { platform };
  for (const [field, key] of Object.entries(ANNOTATIONS)) entry[field] = layer.annotations[`${PREFIX}.${key}`] ?? null;
  return { ...entry, revision: Number(entry.revision), digest: layer.digest, size: layer.size, mediaType: layer.mediaType };
}
