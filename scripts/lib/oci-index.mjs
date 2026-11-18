// The index as an OCI artifact (D3, ADR 0004): an image index with one artifact manifest per platform, whose layers are the
// tool image layers, annotated with the tool version they hold. The action reads these annotations (scripts/action/setup.sh).
import { EMPTY_CONFIG, manifestBytes, MEDIA_TYPES, sha256 } from './oci.mjs';
import { PLATFORMS } from './tool-definition.mjs';

const ARTIFACT_TYPE = 'application/vnd.camunda.infra-tools.index.v1+json';

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
