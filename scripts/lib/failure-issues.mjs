// Failure issues (ADR 0012, D63): the GitHub issue tracking one failure of the reconciler or of a release, which follows the
// failure's state, with its procedure from docs/runbooks/ and a Slack line in #infra-alerts, its failure alert: when it opens,
// or for a reconciler run failure once its step has kept failing for a day (D67).
import { createHash } from 'node:crypto';

// Label of the failure issues of tool failures (one per tool and major) and of run failures (one per flow and step, and release).
export const TOOL_FAILURE_LABEL = 'tool-failure';
const RUN_FAILURE_LABEL = 'run-failure';

// Holds the failure issue's key and the signature of each of its errors, as JSON; for a reconciler run failure, also when
// the issue's failure started (firstFailedAt) and whether its failure alert was sent (alerted).
const MARKER = '<!-- infra-tools: failure ';
const MARKER_PATTERN = /<!-- infra-tools: failure (\{.*\}) -->/;

// What a key's kind of failure decides: the label, the id (the key as one string, the same whatever the order of its fields:
// tool/<tool>/<major> or <flow>/<step>[/<release>]), the title and the runbook, relative to docs/runbooks/ (tool-failure.md, or
// <flow>/<step>.md, a step's qualifier aside: release/mirror.md for mirror.gar), and whether its failure alert waits ALERT_AFTER
// (delaysAlert: a reconciler run failure).
function kindOf(key) {
  if ('tool' in key) {
    return { label: TOOL_FAILURE_LABEL, id: `tool/${key.tool}/${key.major}`, title: `Tool failure: ${key.tool} ${key.major}`, runbook: 'tool-failure.md', delaysAlert: false };
  }
  return {
    label: RUN_FAILURE_LABEL,
    id: [key.flow, key.step, key.release].filter(Boolean).join('/'),
    title: `Run failure: ${[key.flow, key.release, key.step].filter(Boolean).join(' ')}`,
    runbook: `${key.flow}/${key.step.split('.')[0]}.md`,
    delaysAlert: key.flow === 'reconcile',
  };
}
const keyId = (key) => kindOf(key).id;

// A reconciler run failure alerts only once its step has kept failing this long (D67): transient outages, which a run every 2
// hours outlives, open its issue but alert no one. Tool failures and release run failures alert when their issue opens.
const ALERT_AFTER_HOURS = 24;
const ALERT_AFTER = ALERT_AFTER_HOURS * 60 * 60 * 1000;

// A Markdown text code block of a log excerpt, its fence longer than any backtick run of the excerpt.
export function codeBlock(excerpt) {
  const fence = '`'.repeat(Math.max(3, ...[...excerpt.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return `${fence}text\n${excerpt}\n${fence}`;
}

// The error of a log excerpt, the same from one run to the next: without colors, BuildKit step numbers and timings (#12 0.512,
// DONE 0.4s), hashes and timestamps.
function signature(excerpt) {
  const normalized = excerpt
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/^#\d+ (\d+\.\d+ )?/gm, '')
    .replace(/^DONE \d+(\.\d+)?s$/gm, 'DONE')
    .replace(/\b[0-9a-f]{12,}\b/g, 'H')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z?/g, 'T');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

// Characters left to the errors of an issue body or comment, within GitHub's 65536, the runbook and the context aside.
const ERRORS_LENGTH = 40000;

// The end of an excerpt within a length, in whole lines.
function tail(excerpt, length) {
  if (excerpt.length <= length) return excerpt;
  const end = excerpt.slice(-length);
  return end.slice(end.indexOf('\n') + 1);
}

// Each error under its subject's heading, each line followed by a blank one; the errors share ERRORS_LENGTH.
function errorLines(errors) {
  const entries = Object.entries(errors);
  return entries.flatMap(([subject, excerpt]) => [`### ${subject}`, '', codeBlock(tail(excerpt, Math.floor(ERRORS_LENGTH / entries.length))), '']);
}

// The body of a failure issue: its context, last failed run, observed state and errors, then its runbook without its title.
// streak: { firstFailedAt, alerted } of a reconciler run failure, kept in the marker; none for the others.
function body(failure, runbook, runUrl, streak) {
  return [
    failure.context,
    '',
    `Last failed run: ${runUrl}`,
    '',
    '## Observed state',
    '',
    failure.state,
    '',
    '## Error',
    '',
    ...errorLines(failure.errors),
    runbook.replace(/^# .*\n+/, '').trimEnd(),
    '',
    markerText({ key: failure.key, errors: Object.fromEntries(Object.entries(failure.errors).map(([s, e]) => [s, signature(e)])), ...streak }),
  ].join('\n');
}

const markerText = (marker) => `${MARKER}${JSON.stringify(marker)} -->`;

// The marker of a failure issue's body ({ key, errors }), null for an issue without one.
function parseMarker(text) {
  const match = MARKER_PATTERN.exec(text ?? '');
  return match ? JSON.parse(match[1]) : null;
}

// The sections every runbook has, copied into its failure issues: Agents says which commands an agent may run unattended.
const RUNBOOK_SECTIONS = ['Likely causes', 'Procedure', 'Verify', 'Agents'];

// What a runbook of docs/runbooks/ lacks, one message per missing section ([] when complete).
export const runbookErrors = (runbook) => RUNBOOK_SECTIONS.filter((s) => !new RegExp(`^## ${s}$`, 'm').test(runbook)).map((s) => `missing the ## ${s} section`);

// The failure issue of a key: its open one, else its latest closed one. A key opens one issue at a time, but one can be opened
// by hand.
function issueOf(issues, key) {
  const ofKey = issues.filter((issue) => keyId(issue.marker.key) === keyId(key));
  const latest = (list) => list.sort((a, b) => b.number - a.number)[0];
  return latest(ofKey.filter((issue) => issue.state === 'open')) ?? latest(ofKey);
}

// The streak of a reconciler run failure: its issue's, until a run finds the failure gone and clears it; else one starting at
// now. It follows the failure, not the issue: closing or reopening the issue by hand keeps it.
const streakOf = (issue, now) =>
  issue?.marker.firstFailedAt
    ? { firstFailedAt: issue.marker.firstFailedAt, alerted: issue.marker.alerted === true }
    : { firstFailedAt: new Date(now).toISOString(), alerted: false };

// Failures of one key are one: their errors together, and each context and state once, paragraphs apart.
function mergeByKey(failures) {
  const once = (text, more) => (text.split('\n\n').includes(more) ? text : `${text}\n\n${more}`);
  const byId = new Map();
  for (const f of failures) {
    const merged = byId.get(keyId(f.key));
    byId.set(keyId(f.key), merged ? { ...merged, context: once(merged.context, f.context), state: once(merged.state, f.state), errors: { ...merged.errors, ...f.errors } } : f);
  }
  return [...byId.values()];
}

// Slack mrkdwn link, its text escaped.
const slackLink = (url, text) => `<${url}|${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}>`;

// Opens or updates the failure issue of each failure of a run.
// github: the GitHub API of the repository:
// - listIssues(label): its issues with that label, open or closed ({ number, state: 'open' or 'closed', title, body, url });
// - createIssue({ title, body, labels }): { number, url };
// - updateIssue(number, { title, body, state });
// - addComment(number, body).
// alert(text): posts one Slack line to #infra-alerts. readRunbook(path): a runbook of docs/runbooks/, by relative path.
// failures: this run's failures ({ key, context, state, errors }): key is { tool, major } for a tool failure, { flow, step,
// release } for a run failure (release only for a release's own step); context two or three sentences of Markdown, state the
// observed state, errors the log excerpt of each failing subject (a tool version, a step), by subject. Failures of one key,
// such as the push failures of several build jobs, are merged into one.
// resolve: the keys this run checked, as key ids or their leading segments (tool, tool/java, reconcile, reconcile/push,
// release/index/1.2.0, ...): the open failure issue of such a key none of failures has is closed, its failure gone.
// runUrl: this run. now: this run's time, in milliseconds, that a reconciler run failure's streak is measured with.
// Returns pendingAlerts: the open issues of reconciler run failures whose failure alert is still to come ({ title, url,
// alertAt }).
export async function syncFailureIssues({ github, alert, readRunbook, failures: reports, resolve = [], runUrl, now = Date.now() }) {
  const failures = mergeByKey(reports);
  // An issue with both labels is listed once.
  const listed = (await Promise.all([TOOL_FAILURE_LABEL, RUN_FAILURE_LABEL].map((label) => github.listIssues(label)))).flat();
  const issues = [...new Map(listed.map((issue) => [issue.number, issue])).values()].flatMap((issue) => {
    const marker = parseMarker(issue.body);
    return marker ? [{ ...issue, marker }] : [];
  });
  // Every runbook is checked before any issue changes.
  const runbooks = await Promise.all(
    failures.map(async ({ key }) => {
      const path = kindOf(key).runbook;
      const runbook = await readRunbook(path);
      const errors = runbookErrors(runbook);
      if (errors.length) throw new Error(errors.map((e) => `docs/runbooks/${path}: ${e}`).join('\n'));
      return runbook;
    }),
  );
  const pendingAlerts = [];
  for (const [index, failure] of failures.entries()) {
    const { label, title, delaysAlert } = kindOf(failure.key);
    const runbook = runbooks[index];
    const issue = issueOf(issues, failure.key);
    const streak = delaysAlert ? streakOf(issue, now) : undefined;
    // A delayed failure alert is sent once, by the first failed run a day or more after its failure started.
    const due = streak && !streak.alerted && now - Date.parse(streak.firstFailedAt) >= ALERT_AFTER;
    if (due) streak.alerted = true;
    let url = issue?.url;
    if (issue?.state === 'closed') {
      await github.addComment(issue.number, [`Failing again in [this run](${runUrl}):`, '', ...errorLines(failure.errors)].join('\n').trimEnd());
      await github.updateIssue(issue.number, { title, body: body(failure, runbook, runUrl, streak), state: 'open' });
      if (!streak) await alert(`:rotating_light: Failure issue reopened: ${slackLink(url, title)}`);
    } else if (issue) {
      const newErrors = Object.fromEntries(Object.entries(failure.errors).filter(([subject, excerpt]) => issue.marker.errors[subject] !== signature(excerpt)));
      if (Object.keys(newErrors).length) await github.addComment(issue.number, [`New error in [this run](${runUrl}):`, '', ...errorLines(newErrors)].join('\n').trimEnd());
      await github.updateIssue(issue.number, { title, body: body(failure, runbook, runUrl, streak) });
    } else {
      ({ url } = await github.createIssue({ title, body: body(failure, runbook, runUrl, streak), labels: [label] }));
      if (!streak) await alert(`:rotating_light: Failure issue opened: ${slackLink(url, title)}`);
    }
    if (due) await alert(`:rotating_light: Failure issue failing for ${ALERT_AFTER_HOURS} h: ${slackLink(url, title)}`);
    else if (streak && !streak.alerted) pendingAlerts.push({ title, url, alertAt: new Date(Date.parse(streak.firstFailedAt) + ALERT_AFTER).toISOString() });
  }
  const failing = new Set(failures.map((f) => keyId(f.key)));
  const inScope = (id) => resolve.some((scope) => id === scope || id.startsWith(`${scope}/`));
  for (const issue of issues.filter((i) => i.state === 'open' && inScope(keyId(i.marker.key)) && !failing.has(keyId(i.marker.key)))) {
    await github.addComment(issue.number, `No longer fails in [this run](${runUrl}): closing.`);
    // Its streak ends: the failure starts a new one when it comes back, even in an issue reopened by hand.
    const { firstFailedAt, alerted, ...marker } = issue.marker;
    await github.updateIssue(issue.number, { state: 'closed', ...(firstFailedAt && { body: issue.body.replace(MARKER_PATTERN, markerText(marker)) }) });
  }
  return { pendingAlerts };
}
