// GitHub release of one published tool version: name and body.
const SIZE_UNIT = 1024 * 1024;

const parseArchFolders = (value) =>
  typeof value === 'string' ? Object.fromEntries(value.split(' ').map((pair) => pair.split('='))) : value;

export const releaseName = (r) => `${r.tool} ${r.version} (r${r.revision})`;

// r: published result; tool: normalized tool config; layers: { 'linux/<arch>': { digest, size } }.
export function releaseBody({ r, tool, layers, registry, repository, commit, source }) {
  const archFolders = parseArchFolders(r.archFolders);
  const rows = Object.entries(layers)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([platform, layer]) => {
      const folder = archFolders[platform.split('/')[1]];
      return `| ${platform} | \`${r.cacheFolder}/${r.folderVersion}/${folder}\` | \`${layer.digest}\` | ${Math.round(layer.size / SIZE_UNIT)} MB |`;
    });
  return [
    `${r.tool} ${r.version}, built for the runner tool cache.${source ? ` Upstream: ${source}` : ''}`,
    '',
    '**Use it**',
    '',
    '```yaml',
    `- uses: ${repository}${tool.addToPath ? '' : '/cache'}@<sha> # X.Y.Z`,
    '  with:',
    `    tools: ${r.tool}@${r.version}`,
    '```',
    '',
    'Available from the infra-tools release that first lists it in its `tools.json`.',
    '',
    '**Layers**',
    '',
    '| Platform | Tool cache path | Layer digest | Size |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    `Image \`${registry}:${r.tag}${r.digest ? `@${r.digest}` : ''}\`, line \`${r.line ?? '*'}\`, revision ${r.revision}.`,
    `Built and tested on ${Object.keys(layers).sort().join(' and ')}${commit ? ` from ${repository}@${commit.slice(0, 7)}` : ''}.`,
  ].join('\n');
}
