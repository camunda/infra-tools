// Publishes the release (spec §5.5, ADR 0013, D64): the one draft X.Y.Z release-please created, without its tag, published by
// steps that each check their own end state and do nothing once it is reached, so a run repeated after any failure completes
// it. A failed step stops the release, which stays a draft, and is reported for its failure issue (ADR 0012).
import { duration } from './log.mjs';
import { mirrorIndex } from './mirror.mjs';
import { publishReleaseIndex } from './publish-index.mjs';
import { releaseFailureReport } from './release-failures.mjs';
import { draftRelease, releaseBody, releaseNotes, toolsJson } from './release.mjs';
import { parseToolDefinition } from './tool-definition.mjs';

// Runs the release steps, in order:
// - drafts: the releases listed, and the draft to publish (lib/release.mjs draftRelease), nothing more to do without one;
// - index: its X.Y.Z-tools index pushed to registry, built from the tool definitions and the catalog at the draft's target;
// - mirror.<name>: the index copied to each mirror, digests checked (D65);
// - notes: the Added / Replaced / Retired tables in its notes, and tools.json attached;
// - undraft: the draft published as the latest release, which creates its tag.
// registry: the Registry of the tool images and the indexes (ghcr.io). mirrors: [{ name, registry }], or { name, error } for a
// mirror that cannot be reached (its login failed), whose step fails with error. repository: the GitHub repository (owner/name).
// github: the GitHub API of the repository:
// - listReleases(): its releases;
// - toolNames(ref): the folders of tools/ at ref;
// - file(path, ref): the parsed JSON file at ref, or null;
// - updateRelease(id, fields): the release with fields changed;
// - toolsJson(release): the content of its uploaded tools.json, or null;
// - uploadToolsJson(release, content): tools.json attached to the release, replacing any other.
// onStep(step, release, failures): called before each step starts, with the failure reports so far, so a step that never
// finishes (its timeout) can still be reported. log: called with each line of the run: the lines of a step in a collapsed group
// of the job log, then its outcome and duration (`mirror.ecr: 1.3.0-tools copied in 2m 21s`).
// Returns the draft's version (release, null without one), the failure reports of the steps that failed ({ key, context,
// state, errors }, as scripts/failure-issues.mjs takes them), and the failure issue scopes the steps that passed resolve
// (release without a draft, else release/<step>).
export async function publishRelease({ registry, mirrors = [], repository, github, onStep = async () => {}, log = () => {} }) {
  const failures = [];
  const resolve = [];
  // Runs one step, whose action returns its outcome when it is more than done: true once it passed, false when it failed and
  // is reported.
  const step = async (name, version, action) => {
    await onStep(name, version, [...failures]);
    const start = Date.now();
    log(`::group::${name}`);
    const outcome = (text) => {
      log('::endgroup::');
      log(`${name}: ${text} in ${duration(Date.now() - start)}`);
    };
    try {
      outcome((await action()) ?? 'done');
    } catch (err) {
      outcome('failed');
      failures.push(releaseFailureReport({ step: name, release: version, error: err.message }));
      return false;
    }
    resolve.push(`release/${name}`);
    return true;
  };

  let draft;
  const drafts = async () => {
    draft = draftRelease(await github.listReleases(), repository);
  };
  if (!(await step('drafts', undefined, drafts))) return { release: null, failures, resolve };
  if (!draft) return { release: null, failures, resolve: ['release'] };
  const version = draft.tag_name;
  const result = (release) => ({ release, failures, resolve });
  // A draft keeps its tag name and target only through updates that send them.
  const keep = { tag_name: version, target_commitish: draft.target_commitish };

  const tag = `${version}-tools`;
  let index;
  const push = async () => {
    index = await pushIndex(draft, { registry, github });
    return index.pushed ? `${tag} pushed` : 'nothing to do';
  };
  if (!(await step('index', version, push))) return result(version);

  // Every mirror is tried, so each failing one is reported.
  let mirrored = true;
  for (const mirror of mirrors) {
    const copy = async () => {
      if (mirror.error) throw new Error(mirror.error);
      return (await mirrorIndex(registry, mirror.registry, tag, { log })) ? `${tag} copied` : 'nothing to do';
    };
    mirrored = (await step(`mirror.${mirror.name}`, version, copy)) && mirrored;
  }
  if (!mirrored) return result(version);

  const notes = async () => {
    const body = releaseBody(draft.body, releaseNotes({ version, previousVersion: index.previousVersion, repository, before: index.before, after: index.entries }));
    if (body !== draft.body) await github.updateRelease(draft.id, { ...keep, body });
    const content = `${JSON.stringify(toolsJson({ version, image: registry.repository, entries: index.entries }), null, 2)}\n`;
    if ((await github.toolsJson(draft)) !== content) await github.uploadToolsJson(draft, content);
  };
  if (!(await step('notes', version, notes))) return result(version);

  const undraft = async () => {
    await github.updateRelease(draft.id, { ...keep, draft: false, make_latest: 'true' });
  };
  await step('undraft', version, undraft);
  return result(version);
}

// The index of the draft, from the tool definitions and the catalog at its target commit (main may have moved since).
async function pushIndex(draft, { registry, github }) {
  const ref = draft.target_commitish;
  const tools = [];
  const catalogs = {};
  for (const name of await github.toolNames(ref)) {
    tools.push(parseToolDefinition(name, await github.file(`tools/${name}/tool.json`, ref)));
    catalogs[name] = (await github.file(`published/${name}.json`, ref)) ?? [];
  }
  return publishReleaseIndex(registry, draft.tag_name, { tools, catalogs });
}
