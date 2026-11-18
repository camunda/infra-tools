// OCI image format basics shared by the registry client, the index and the tool image push.
import { createHash } from 'node:crypto';

export const MEDIA_TYPES = {
  index: 'application/vnd.oci.image.index.v1+json',
  manifest: 'application/vnd.oci.image.manifest.v1+json',
  empty: 'application/vnd.oci.empty.v1+json',
};

// The empty config blob, `{}`.
export const EMPTY_CONFIG = { mediaType: MEDIA_TYPES.empty, digest: 'sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a', size: 2 };

export const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

// The bytes pushed for a manifest, which its digest and size are computed from.
export const manifestBytes = (manifest) => Buffer.from(JSON.stringify(manifest));
