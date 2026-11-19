// Fix PRs (spec §5.3, step 5): where the reconciler tracks a tool version that fails to build or test, until it builds again.
import { createHash } from 'node:crypto';
import { folderVersion, majorOf } from './versions.mjs';

// Label of every fix PR.
export const LABEL = 'tool-build';
// Holds the fix PR's tool, major and versions, each with the signature of its latest error, as JSON.
const MARKER = '<!-- infra-tools: fix PR ';
const MARKER_PATTERN = /<!-- infra-tools: fix PR (\{.*\}) -->/;

// Longest excerpt kept, well within the 65536 characters of a PR body.
const EXCERPT_LENGTH = 10000;

// The excerpt of a failed Bake stage's output (--progress=plain) for its fix PR: the 25 lines before its first error, BuildKit's
// `#<step> ERROR: ...` right after the failing command's output, and the 5 lines after it; the last 30 lines without one.
export function logExcerpt(log) {
  const lines = log.replace(/\u001b\[[0-9;]*m/g, '').trimEnd().split('\n');
  const error = lines.findIndex((l) => /\bERROR\b/.test(l));
  const excerpt = (error < 0 ? lines.slice(-30) : lines.slice(Math.max(0, error - 25), error + 6)).join('\n');
  return excerpt.length > EXCERPT_LENGTH ? excerpt.slice(-EXCERPT_LENGTH) : excerpt;
}

// The job summary of a build that failed (failure guidance, spec §5.8): the tool version, its failing step and log excerpt.
export function failureSummary({ tool, version, step, excerpt }) {
  const code = fence(excerpt);
  return [
    `## ${tool} ${version}: the \`${step}\` step failed`,
    '',
    `Nothing was pushed. The **Fix PRs** job of this run tracks it in a fix PR (\`${LABEL}\` label), and every run builds it again until it builds. The end of the \`${step}\` step log:`,
    '',
    `${code}text`,
    excerpt,
    code,
    '',
  ].join('\n');
}

// The error of a failure, the same across the versions of a tool: its step and the end of its excerpt up to the first error,
// without versions, hashes and BuildKit step timings.
function signature({ step, excerpt }) {
  const lines = excerpt.split('\n');
  const error = lines.findIndex((l) => /\bERROR\b/.test(l));
  const normalized = lines
    .slice(0, error < 0 ? lines.length : error + 1)
    .slice(-5)
    .map((l) =>
      l
        .replace(/^#\d+ (\d+\.\d+ )?/, '')
        .replace(/\b[0-9a-f]{12,}\b/g, 'H')
        .replace(/\d+(\.\d+)+([+-][\w.]+)?/g, 'V'),
    );
  return createHash('sha256').update([step, ...normalized].join('\n')).digest('hex').slice(0, 12);
}

// A Markdown code fence longer than any backtick run of the text it wraps.
const fence = (text) => '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));

const title = (pr) => `fix(${pr.tool}): build ${Object.keys(pr.versions).join(', ')}`;

// The body of a fix PR, with the failure that last changed it.
function body(pr, failure, runUrl) {
  const { tool } = pr;
  const code = fence(failure.excerpt);
  return [
    `The reconciler could not build or test ${tool} ${Object.keys(pr.versions).join(', ')}.`,
    '',
    `**Failing step**: \`${failure.step}\`, in [this reconciler run](${runUrl})`,
    '',
    `${code}text`,
    failure.excerpt,
    code,
    '',
    `Push the fix to this branch, usually an \`if version ≥ X\` in \`tools/${tool}/install.sh\` or \`tools/${tool}/test.sh\`: once a tool file changes, this PR's checks build and test the versions. Merging publishes them on the next reconciler run; closing this PR without merging ignores them.`,
    `Versions of ${tool} ${pr.major} failing with the same error join this PR; split it if they need different fixes.`,
    '',
    `${MARKER}${JSON.stringify({ tool, major: pr.major, versions: pr.versions })} -->`,
  ].join('\n');
}

// failures: the tool versions that failed to build or test in this run ({ tool, version, step, excerpt }, build.mjs).
// pulls: every fix PR ({ number, state: 'OPEN', 'CLOSED' or 'MERGED', body }, gh pr list). plans: planTool's result per tool
// once the run's builds are recorded, with the fix PRs. runUrl: this reconciler run.
// A failure joins the open fix PR of the same tool and major failing with the same error, or opens one; a fix PR version that
// fails again changes it only when its error changed. Returns the changes to make, in order:
// - { action: 'comment', number, body }: the new error of a fix PR version;
// - { action: 'open', branch, title, body }: a fix PR to open from an empty commit on the base branch, labeled LABEL;
// - { action: 'update', number, title, body }: an open fix PR a failure joined, or whose error changed;
// - { action: 'close', number, comment, body }: an open fix PR none of whose versions is left to publish, to close with that
//   comment and that body, marked resolved.
export function fixPrChanges({ failures, pulls, plans, runUrl }) {
  // Open fix PRs, then those this run opens (no number), each with the failure that last changed it.
  const prs = pulls.filter((p) => p.state === 'OPEN').flatMap((p) => {
    const marker = parseMarker(p.body);
    return marker ? [{ ...marker, number: p.number, previous: p.body }] : [];
  });
  const planned = (tool, version) => plans[tool]?.versions.find((v) => v.version === version);
  const comments = [];
  // A failure from an earlier attempt of the run whose version a later attempt published is no failure any more.
  for (const f of failures.filter((f) => planned(f.tool, f.version)?.decision === 'publish')) {
    const error = signature(f);
    const major = majorOf(f.version);
    // A version of a fix PR, planned again, failed again: only a new error changes the fix PR.
    const tracking = prs.find((p) => p.tool === f.tool && f.version in p.versions);
    if (tracking) {
      // The same version listed twice, or tracked by a fix PR this run opens: once is enough.
      if (tracking.versions[f.version] === error || !tracking.number) continue;
      Object.assign(tracking, { versions: { ...tracking.versions, [f.version]: error }, failure: f });
      const code = fence(f.excerpt);
      comments.push({ action: 'comment', number: tracking.number, body: [`The error of ${f.tool} ${f.version} changed: the \`${f.step}\` step failed in [this reconciler run](${runUrl}).`, '', `${code}text`, f.excerpt, code].join('\n') });
      continue;
    }
    const pr = prs.find((p) => p.tool === f.tool && p.major === major && Object.values(p.versions).includes(error));
    if (pr) Object.assign(pr, { versions: { ...pr.versions, [f.version]: error }, failure: f });
    else prs.push({ tool: f.tool, major, versions: { [f.version]: error }, failure: f, branch: `${LABEL}/${f.tool}-${folderVersion(f.version)}` });
  }
  const changes = prs.flatMap((pr) => {
    if (pr.failure) {
      const change = { title: title(pr), body: body(pr, pr.failure, runUrl) };
      return [pr.number ? { action: 'update', number: pr.number, ...change } : { action: 'open', branch: pr.branch, ...change }];
    }
    // Every version published (it builds again), or no longer published by its line (skipped, or no longer planned at all).
    const left = Object.keys(pr.versions).map((version) => [version, planned(pr.tool, version)]);
    if (left.some(([, v]) => v && v.decision !== 'skip')) return [];
    const reasons = left.map(([version, v]) => `- ${pr.tool} ${version}: ${v?.reason ?? 'no longer planned'}`);
    // Marked resolved: a fix PR the reconciler closed does not ignore its versions, as one a maintainer closed does.
    const marker = `${MARKER}${JSON.stringify({ tool: pr.tool, major: pr.major, versions: pr.versions, resolved: true })} -->`;
    return [{ action: 'close', number: pr.number, comment: [`No version of this PR is left to publish ([reconciler run](${runUrl})), closing:`, ...reasons].join('\n'), body: pr.previous.replace(MARKER_PATTERN, () => marker) }];
  });
  return [...comments, ...changes];
}

// The versions fix PRs track, by tool then version ({ number, state }, planTool's fixPrs): 'open' while their fix PR is open,
// 'closed' once a maintainer closed it without merge (ignored). A merged fix PR, or one the reconciler closed, tracks nothing.
// pulls: every fix PR, as fixPrChanges takes them.
export function trackedVersions(pulls) {
  const tracked = {};
  // Oldest first: a version a later fix PR tracks again follows it.
  for (const p of [...pulls].sort((a, b) => a.number - b.number)) {
    const marker = parseMarker(p.body);
    if (!marker || marker.resolved || !['OPEN', 'CLOSED'].includes(p.state)) continue;
    const versions = (tracked[marker.tool] ??= new Map());
    for (const version of Object.keys(marker.versions)) versions.set(version, { number: p.number, state: p.state === 'OPEN' ? 'open' : 'closed' });
  }
  return tracked;
}

function parseMarker(text) {
  const match = MARKER_PATTERN.exec(text ?? '');
  return match ? JSON.parse(match[1]) : null;
}
