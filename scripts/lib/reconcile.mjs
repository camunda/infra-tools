// Reconciler run (spec §5.3): what a run records once its builds are pushed, and the safeguards around it.
import { isDeepStrictEqual } from 'node:util';
import { buildTarget } from './build.mjs';
import { mergeCatalog } from './catalog.mjs';
import { buildCommit } from './tool-release.mjs';

// Fails when a catalog version, retired or not (older releases keep it), lost its tag: published tool images never change, so
// it must not be planned and pushed again. tagExists(tag): Registry.exists, whose errors other than 404 fail the run.
export async function checkCatalogTags({ catalogs, tagExists }) {
  const lost = [];
  for (const [name, entries] of Object.entries(catalogs)) {
    for (const e of entries) if (!(await tagExists(e.tag))) lost.push(`${name} ${e.version}: tag ${e.tag} not found`);
  }
  if (lost.length) throw new Error(`published versions lost their tag; published tool images never change:\n${lost.join('\n')}`);
}

// Completeness check (R17): fails when a version in range is neither published nor tracked, once the run's builds are recorded
// and its failures are in fix PRs. plans: planTool's result per tool then, with the fix PRs: tracked versions wait, are ignored
// (skipped) or are retried by an open fix PR (fixPr set).
export function checkCompleteness(plans) {
  const gaps = Object.values(plans).flatMap((plan) => plan.versions.filter((v) => v.decision === 'publish' && !v.fixPr).map((v) => `${plan.tool} ${v.version} (${v.reason})`));
  if (gaps.length) throw new Error(`versions in range neither published nor tracked by a fix PR (R17), see the build jobs of this run:\n${gaps.join('\n')}`);
}

// plans: planTool's result per tool, once the run's builds are pushed. Every version whose tool image exists (reason
// published) is recorded when the catalog lacks it at that revision, whether this run or an earlier one that failed before
// its record commit pushed it; failed builds stay planned and are not recorded.
// Fails when one was built with another install block than the tool definition's (an earlier run's push, then an install
// change without a revision bump): the action installs from the tool cache path tools/<tool>/tool.json gives, which its tool
// image does not hold. registry: Registry, whose tool images carry their build commit; readToolDefinitionAt(name, commit):
// the tool definition at that commit, which throws when it cannot be read.
// Returns the catalogs of every tool, the changes of the record commit, and unreleased, the recorded tool versions that need
// a tool release ({ tool, version, line, revision, tag, upstream }).
export async function recordRun({ tools, catalogs, plans, now, registry, readToolDefinitionAt }) {
  const run = { catalogs: {}, changes: [], unreleased: [] };
  for (const tool of tools) {
    const entries = catalogs[tool.name] ?? [];
    const plan = plans[tool.name];
    const targets = plan.versions.filter((v) => v.reason === 'published').map((v) => buildTarget(tool, v.version));
    const recorded = (t) => entries.some((e) => e.version === t.version && e.revision >= t.revision);
    for (const t of targets.filter((t) => !recorded(t))) {
      const commit = await buildCommit({ tool, recorded: t, registry });
      if (!isDeepStrictEqual((await readToolDefinitionAt(tool.name, commit)).install, tool.install)) {
        const where = `tools/${tool.name}/tool.json`;
        const fix = `bump the revision of ${tool.name} ${t.version} in ${where} to build it again`;
        throw new Error(`${t.tag}: its tool image was built with another install block (${where} at ${commit}) and does not hold the tool cache path the action installs from; ${fix}`);
      }
      run.unreleased.push({ tool: tool.name, version: t.version, line: t.line, revision: t.revision, tag: t.tag, upstream: plan.upstream });
    }
    const merged = mergeCatalog(tool, entries, targets, { now });
    run.catalogs[tool.name] = merged.entries;
    run.changes.push(...merged.changes);
  }
  return run;
}

const entry = (c) => `${c.type}(${c.tool})${c.breaking ? '!' : ''}: ${c.text}`;

// The record commit message: one conventional entry per change, the first as subject, the others as nested commits in the body,
// which release-please reads as one commit each, breaking ones included. Empty when nothing changed: no commit.
export function commitMessage(changes) {
  if (!changes.length) return '';
  const [subject, ...others] = changes.map(entry);
  const nested = others.flatMap((e) => ['BEGIN_NESTED_COMMIT', e, 'END_NESTED_COMMIT']);
  return `${[subject, ...(nested.length ? ['', ...nested] : [])].join('\n')}\n`;
}
