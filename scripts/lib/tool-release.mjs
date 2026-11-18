// Tool release (spec §5.5): the GitHub release documenting one published tool image, tagged like it on the commit its layers
// were built from, never marked latest.
import { archFolder, PLATFORMS } from './tool-definition.mjs';
import { folderVersion } from './versions.mjs';

const MB = 1024 * 1024;

// published: a recorded tool version (lib/reconcile.mjs recordRun). layers: its layer per platform (Registry.toolImageLayers);
// digest: its image digest; image: <registry>/<repository> it is pushed to; repository: owner/name; commit: the build commit.
// Returns the GitHub REST API fields of the release.
export function toolRelease({ tool, published: p, layers, digest, image, repository, commit }) {
  const plain = tool.install.addToPath !== null;
  const rows = PLATFORMS.map((platform) => {
    const { digest: layer, size } = layers[platform];
    return `| ${platform} | \`${tool.install.cacheFolder}/${folderVersion(p.version)}/${archFolder(tool, platform)}\` | \`${layer}\` | ${(size / MB).toFixed(1)} MB |`;
  });
  return {
    tag_name: p.tag,
    target_commitish: commit,
    name: `${tool.name} ${p.version} (r${p.revision})`,
    make_latest: 'false',
    body: [
      `${tool.name} ${p.version}${plain ? ', ready to use' : ' in the runner tool cache, for its setup-* action'}.${p.upstream ? ` Upstream: ${p.upstream}` : ''}`,
      '',
      '## Usage',
      '',
      plain
        ? 'In jobs pinning an infra-tools release that lists it:'
        : 'In jobs pinning an infra-tools release that lists it. The setup-* step takes the version the infra-tools step installed, so it finds it in the tool cache instead of downloading it:',
      '',
      '```yaml',
      ...usage(tool, p.version),
      '```',
      '',
      '## Tool image',
      '',
      '| Platform | Tool cache path | Layer digest | Size |',
      '| --- | --- | --- | --- |',
      ...rows,
      '',
      `Image \`${image}:${p.tag}@${digest}\`, line \`${p.line}\`, revision ${p.revision}, built from ${repository}@${commit.slice(0, 7)}.`,
    ].join('\n'),
  };
}

// The workflow steps: the infra-tools step, then for a tool-cache tool its setup-* step with the resolved version (D53).
function usage(tool, version) {
  if (tool.install.addToPath !== null) return ['- uses: camunda/infra-tools@<sha> # X.Y.Z', '  with:', `    tools: ${tool.name}@${version}`];
  const resolved = `\${{ fromJSON(steps.tools.outputs.versions).${tool.name} }}`;
  const steps = ['- id: tools', '  uses: camunda/infra-tools@<sha> # X.Y.Z', '  with:', `    tool-cache: ${tool.name}@${version}`];
  if (!tool.setup) return [...steps, `# Then the setup-* action of ${tool.name}, with its version input set to ${resolved}`];
  const inputs = Object.entries(tool.setup.with).map(([input, value]) => `    ${input}: ${value}`);
  return [...steps, `- uses: ${tool.setup.action}@<sha> # vX.Y.Z`, '  with:', ...inputs, `    ${tool.setup.versionInput}: ${resolved}`];
}
