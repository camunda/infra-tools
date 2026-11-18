// Tool release (spec §5.5): the GitHub release documenting one published tool image, tagged like it on the commit its layers
// were built from, never marked latest.
import { archFolder, isPlainTool, PLATFORMS } from './tool-definition.mjs';
import { folderVersion } from './versions.mjs';

const MB = 1024 * 1024;

// recorded: a recorded tool version that needs its tool release (lib/reconcile.mjs recordRun unreleased). layers: its layer
// per platform (Registry.toolImageLayers); digest: its image digest; image: <registry>/<repository> it is pushed to;
// repository: owner/name; commit: the build commit. Returns the GitHub REST API fields of the release.
export function toolRelease({ tool, recorded, layers, digest, image, repository, commit }) {
  const plain = isPlainTool(tool);
  const rows = PLATFORMS.map((platform) => {
    const { digest: layer, size } = layers[platform];
    return `| ${platform} | \`${tool.install.cacheFolder}/${folderVersion(recorded.version)}/${archFolder(tool, platform)}\` | \`${layer}\` | ${(size / MB).toFixed(1)} MB |`;
  });
  return {
    tag_name: recorded.tag,
    target_commitish: commit,
    name: `${tool.name} ${recorded.version} (r${recorded.revision})`,
    make_latest: 'false',
    body: [
      `${tool.name} ${recorded.version}${plain ? ', ready to use' : ' in the runner tool cache, for its setup-* action'}.${recorded.upstream ? ` Upstream: ${recorded.upstream}` : ''}`,
      '',
      '## Usage',
      '',
      plain
        ? 'In jobs pinning an infra-tools release that lists it:'
        : 'In jobs pinning an infra-tools release that lists it. The setup-* step takes the version the infra-tools step installed, so it finds it in the tool cache instead of downloading it:',
      '',
      '```yaml',
      ...usage(tool, recorded.version),
      '```',
      '',
      '## Tool image',
      '',
      '| Platform | Tool cache path | Layer digest | Size |',
      '| --- | --- | --- | --- |',
      ...rows,
      '',
      `Image \`${image}:${recorded.tag}@${digest}\`, line \`${recorded.line}\`, revision ${recorded.revision}, built from ${repository}@${commit.slice(0, 7)}.`,
    ].join('\n'),
  };
}

// The annotation of a tool image's index holding its build commit, set by scripts/build.mjs (build/docker-bake.hcl).
const BUILD_COMMIT ='org.opencontainers.image.revision';

// The tool release of a recorded tool version, from its tool image in registry (Registry): layers, digest and build commit.
// Fails when the tool image has no build commit (pushed before scripts/build.mjs set it): with no commit to tag, it would get
// no tool release; a revision bump builds it again with one.
export async function imageToolRelease({ tool, recorded, registry, repository }) {
  const commit = (await registry.manifest(recorded.tag)).annotations?.[BUILD_COMMIT];
  if (!commit) {
    const fix = `bump the revision of ${tool.name} ${recorded.version} in tools/${tool.name}/tool.json to build it again with one`;
    throw new Error(`${recorded.tag}: its tool image has no build commit (${BUILD_COMMIT} annotation), so no tool release; ${fix}`);
  }
  const layers = await registry.toolImageLayers(recorded.tag);
  return toolRelease({ tool, recorded, layers, digest: await registry.digest(recorded.tag), image: registry.repository, repository, commit });
}

// The workflow steps: the infra-tools step, then for a tool-cache tool its setup-* step with the resolved version (D53).
function usage(tool, version) {
  if (isPlainTool(tool)) return ['- uses: camunda/infra-tools@<sha> # X.Y.Z', '  with:', `    tools: ${tool.name}@${version}`];
  const resolved = `\${{ fromJSON(steps.tools.outputs.versions).${tool.name} }}`;
  const steps = ['- id: tools', '  uses: camunda/infra-tools@<sha> # X.Y.Z', '  with:', `    tool-cache: ${tool.name}@${version}`];
  if (!tool.setup) return [...steps, `# Then the setup-* action of ${tool.name}, with its version input set to ${resolved}`];
  const inputs = Object.entries(tool.setup.with).map(([input, value]) => `    ${input}: ${value}`);
  return [...steps, `- uses: ${tool.setup.action}@<sha> # vX.Y.Z`, '  with:', ...inputs, `    ${tool.setup.versionInput}: ${resolved}`];
}
