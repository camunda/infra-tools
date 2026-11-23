// Failures of a reconciler run (spec §5.3, ADR 0012): the reports of its tool failures and run failures, as
// scripts/failure-issues.mjs takes them ({ key, context, state, errors }), the gaps of its completeness check (R17) and the job
// summary of a build that failed.
import { codeBlock, TOOL_FAILURE_LABEL } from './failure-issues.mjs';
import { majorOf } from './versions.mjs';

// Longest excerpt kept, well within the 65536 characters of an issue body.
const EXCERPT_LENGTH = 10000;

// The excerpt of a failed Bake stage's output (--progress=plain) for its failure issue: the 25 lines before its first error,
// BuildKit's `#<step> ERROR: ...` right after the failing command's output, and the 5 lines after it; the last 30 lines without
// one.
export function logExcerpt(log) {
  const lines = log.replace(/\u001b\[[0-9;]*m/g, '').trimEnd().split('\n');
  const error = lines.findIndex((l) => /\bERROR\b/.test(l));
  const excerpt = (error < 0 ? lines.slice(-30) : lines.slice(Math.max(0, error - 25), error + 6)).join('\n');
  return excerpt.length > EXCERPT_LENGTH ? excerpt.slice(-EXCERPT_LENGTH) : excerpt;
}

// The job summary of a build that failed (failure guidance, spec §5.8): the tool version, its failing step and log excerpt.
export function buildFailureSummary({ tool, version, step, excerpt }) {
  return [
    `## ${tool} ${version}: the \`${step}\` step failed`,
    '',
    `Nothing was pushed. The **Failure issues** job of this run tracks it in the failure issue of ${tool} ${majorOf(version)} (\`${TOOL_FAILURE_LABEL}\` label), and every run builds it again until it builds or is ignored. The end of the \`${step}\` step log:`,
    '',
    codeBlock(excerpt),
    '',
  ].join('\n');
}

// The tool images this run built (builds: the plan's builds.json, [{ tool, version, tag }]) that are still planned once its
// builds are recorded (planTool's result per tool, plans), each with its failure in this run (failures: build.mjs --failure's
// { tool, version, tag, step, excerpt }), or none: a gap (R17). Matched by tag: a version or revision planned since the run's
// plan (its minAge passed, new upstream, or a platform added upstream to a version it published) is the next run's; a failure
// whose tool image is no longer planned (published) is no failure.
function builtVersions({ plans, builds, failures }) {
  const tags = new Set(builds.map((b) => b.tag));
  return Object.values(plans).flatMap((plan) =>
    plan.versions.filter((v) => v.decision === 'publish' && tags.has(v.tag)).map((v) => ({ tool: plan.tool, ...v, failure: failures.find((f) => f.tag === v.tag) })),
  );
}

// The tool failure report of one tool and major: each failing version (built, as builtVersions gives them), its step and log
// excerpt, and how to reproduce and fix it.
function toolFailureReport(failed) {
  const { tool } = failed[0];
  const list = failed.map((v) => v.version).join(', ');
  return {
    key: { tool, major: String(majorOf(failed[0].version)) },
    context: [
      `The reconciler could not build or test ${tool} ${list}: ${failed.length > 1 ? 'they are' : 'it is'} not published, and every reconciler run builds ${failed.length > 1 ? 'them' : 'it'} again.`,
      `Reproduce one with \`node scripts/build.mjs ${tool} ${failed[0].version}\`.`,
      `Fix the build in a pull request that refers to this issue, or ignore the versions in \`tools/${tool}/tool.json\`: see the procedure below.`,
    ].join(' '),
    state: failed.map((v) => `- ${tool} ${v.version}: the \`${v.failure.step}\` step failed; line \`${v.line}\`, tag \`${v.tag}\`, ${v.platforms.join(', ')}`).join('\n'),
    errors: Object.fromEntries(failed.map((v) => [`${v.version} (${v.failure.step})`, v.failure.excerpt])),
  };
}

// The failures of a run once its builds are recorded (plans, builds and failures as builtVersions takes them; reported: the
// subjects of the push failure reports its build jobs wrote, their tool image tags):
// - reports: one tool failure report per tool and major, and a push report without a log for each gap whose build job failed
//   without reporting (a timeout, a cancelled job);
// - resolve: the failure issue keys this run checked (tool/<tool>, or tool/<tool>/<major> for a tool with a gap), whose open
//   issue closes when no report has their key: every version of the key it built failed or is published. A gap's major is left
//   as it is: its version was neither published nor failed;
// - gaps: the versions this run built that are neither published nor failed (R17), which fail the completeness check;
// - stale: the reported push subjects that are no gap, reports an earlier attempt of the run left before a rerun of its build
//   job published the version: they must not reach the failure issues.
export function reconcileFailures({ plans, builds, failures, reported }) {
  const versions = builtVersions({ plans, builds, failures });
  const failed = Map.groupBy(
    versions.filter((v) => v.failure),
    (v) => `${v.tool}/${majorOf(v.version)}`,
  );
  const unfailed = versions.filter((v) => !v.failure);
  const silent = unfailed.filter((v) => !reported.includes(v.tag)).map((v) => runFailureReport({ step: 'push', subject: v.tag }));
  const resolve = Object.values(plans).flatMap((plan) => {
    const gaps = new Set(unfailed.filter((v) => v.tool === plan.tool).map((v) => majorOf(v.version)));
    if (!gaps.size) return [`tool/${plan.tool}`];
    return [...new Set(plan.versions.map((v) => majorOf(v.version)))].filter((m) => !gaps.has(m)).map((m) => `tool/${plan.tool}/${m}`);
  });
  const stale = reported.filter((tag) => !unfailed.some((v) => v.tag === tag));
  return { reports: [...[...failed.values()].map(toolFailureReport), ...silent], resolve, gaps: unfailed.map((v) => `${v.tool} ${v.version} (${v.reason})`), stale };
}

// The context and observed state of each reconciler step's run failure; its runbook is docs/runbooks/reconcile/<step>.md.
const RUN_STEPS = {
  plan: {
    context: 'The reconciler could not plan the tool versions to publish, from upstream, the published tags of `ghcr.io/camunda/infra-tools` and the tool definitions.',
    state: 'Nothing was built or published by this run; every run plans again.',
  },
  push: {
    context: 'The reconciler could not push a tool image it built and tested, or its build job failed for another reason than a tool failure.',
    state: 'The tool images below are not published; every run plans them again.',
  },
  record: {
    context: 'The reconciler could not record the tool versions it published: the catalog (`published/<tool>.json`), the tool releases or the record commit to `main`.',
    state: 'Tool images pushed by this run are not in the catalog yet; the next run records every published tool image the catalog lacks.',
  },
  completeness: {
    context: 'The completeness check (R17) found versions this run built neither published nor failed with their failure issue, or could not plan to check.',
    state: 'The versions the error lists are not published; every run plans them again.',
  },
};

// Lines of a step log kept in a run failure report: its error is at the end.
const RUN_LOG_LINES = 50;

// The report of a reconciler step that failed (step: plan, push, record or completeness): the end of its log, under subject
// (the step by default, the tool image tag for a push). Without a log, the job failed before the step ran or logged anything.
export function runFailureReport({ step, subject = step, log }) {
  if (!(step in RUN_STEPS)) throw new Error(`unknown reconciler step ${step}: ${Object.keys(RUN_STEPS).join(', ').replace(/, (\w+)$/, ' or $1')}`);
  const excerpt = log?.trim()
    ? log.replace(/\u001b\[[0-9;]*m/g, '').trimEnd().split('\n').slice(-RUN_LOG_LINES).join('\n')
    : `No log: the job failed before its ${step} step ran or logged anything (a setup step, a timeout); see the run's job logs.`;
  return { key: { flow: 'reconcile', step }, ...RUN_STEPS[step], errors: { [subject]: excerpt } };
}
