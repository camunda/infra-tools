// Publishes one release X.Y.Z (spec §5.5, D60): release-please creates it as a draft, without its tag, so the action cannot be
// pinned to a release whose index is missing. Pushes its index (publish-index.mjs publishReleaseIndex), appends the Added /
// Replaced / Retired tables to its notes, attaches tools.json and publishes the draft last, which creates its tag: a release
// whose publication failed stays a draft, and the next run completes it.
import { publishReleaseIndex } from './publish-index.mjs';
import { RELEASE_VERSION, releaseBody, releaseNotes, toolsJson } from './release.mjs';
import { parseToolDefinition } from './tool-definition.mjs';

// release: a GitHub release ({ id, tag_name, target_commitish, body, draft }). registry: a Registry of the repository holding
// the tool images and the indexes. repository: the GitHub repository (owner/name).
// github: the GitHub API of the repository:
// - toolNames(ref): the folders of tools/ at ref;
// - file(path, ref): the parsed JSON file at ref, or null;
// - updateRelease(id, fields): the release with fields changed (a draft's tag_name and target_commitish included);
// - uploadToolsJson(release, content): tools.json attached to the release, replacing the one a failed upload left.
// Returns the pushed index (entries, digest), the previous release (previousVersion) and the notes.
export async function publishRelease(release, { registry, repository, github }) {
  const version = release.tag_name;
  // A draft keeps its tag name only through updates that send it: one without it resets it to untagged-<hash>, and publishing
  // the draft would then create that tag. A draft that lost it fails here, with the command that restores it.
  if (release.draft && !RELEASE_VERSION.test(version)) {
    throw new Error(
      `draft release ${release.name} (id ${release.id}) lost its tag name (${version}): restore it with ` +
        `gh api -X PATCH repos/${repository}/releases/${release.id} -f tag_name=<X.Y.Z> -f target_commitish=${release.target_commitish}, then rerun`,
    );
  }
  const keepTag = release.draft ? { tag_name: version, target_commitish: release.target_commitish } : {};
  // The tool definitions and the catalog at the release commit (main may have moved since): a draft has no tag yet, and
  // release-please sets its target to the release commit; a draft published by hand has its tag.
  const ref = release.draft ? release.target_commitish : version;
  const names = await github.toolNames(ref);
  const tools = [];
  const catalogs = {};
  for (const name of names) {
    tools.push(parseToolDefinition(name, await github.file(`tools/${name}/tool.json`, ref)));
    catalogs[name] = (await github.file(`published/${name}.json`, ref)) ?? [];
  }

  const { entries, digest, previousVersion, before } = await publishReleaseIndex(registry, version, { tools, catalogs });
  const notes = releaseNotes({ version, previousVersion, repository, before, after: entries });
  await github.updateRelease(release.id, { ...keepTag, body: releaseBody(release.body, notes) });
  await github.uploadToolsJson(release, `${JSON.stringify(toolsJson({ version, image: registry.repository, entries }), null, 2)}\n`);
  // A release published by hand keeps its latest flag.
  if (release.draft) await github.updateRelease(release.id, { ...keepTag, draft: false, make_latest: 'true' });
  return { entries, digest, previousVersion, notes };
}
