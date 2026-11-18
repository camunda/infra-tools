// Catalog entry of one published tool version, for tests.
export const catalogEntry = (tool, version, revision, line) => ({
  version,
  line,
  folderVersion: version.replaceAll('+', '-'),
  revision,
  tag: `${tool.name}-${version.replaceAll('+', '-')}-r${revision}`,
  ...tool.install,
  publishedAt: '2026-10-01T00:00:00.000Z',
});
