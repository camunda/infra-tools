// Usage: node run-failure.mjs reconcile <step> --out <file> [--log <file>] [--subject <name>]
//        node run-failure.mjs release setup --out <file> --log <file>
// Run failure report of a reconciler step that failed (plan, push, record or completeness; spec §5.3, ADR 0012), or of a step of
// the release job outside the release steps (setup; spec §5.5), written to --out as JSON for failure-issues.mjs, from the end
// of the step's log (--log; a missing one means the job failed before the step logged anything), under --subject (the step by
// default, a tool image tag for a push). Also appends where the failure is tracked to the job summary ($GITHUB_STEP_SUMMARY).
// Needs no dependencies: it runs even when installing them failed.
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { runFailureReport } from './lib/reconcile-failures.mjs';
import { releaseFailureReport } from './lib/release-failures.mjs';

const { values, positionals } = parseArgs({ options: { out: { type: 'string' }, log: { type: 'string' }, subject: { type: 'string' } }, allowPositionals: true });
const [flow, step] = positionals;
const release = flow === 'release' && step === 'setup';
if (!(flow === 'reconcile' || release) || !step || !values.out) {
  throw new Error('usage: node run-failure.mjs reconcile <step> --out <file> [--log <file>] [--subject <name>]\n       node run-failure.mjs release setup --out <file> --log <file>');
}

async function readLog(path) {
  if (!path) return undefined;
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return undefined;
    throw err;
  }
}

const log = await readLog(values.log);
const report = release ? releaseFailureReport({ step, error: log }) : runFailureReport({ step, subject: values.subject, log });
await mkdir(dirname(values.out), { recursive: true });
await writeFile(values.out, `${JSON.stringify(report, null, 2)}\n`);
console.log(`run failure: ${flow} ${step}${values.subject ? ` (${values.subject})` : ''}, reported to ${values.out}`);
if (process.env.GITHUB_STEP_SUMMARY) {
  const summary = [
    `## Run failure: ${flow} ${step}`,
    '',
    `${report.context} The **${release ? 'Open, update and close the failure issues** step' : 'Failure issues** job'} of this run tracks it in its failure issue (\`run-failure\` label), with its procedure from \`docs/runbooks/${flow}/${step}.md\`. Inspect the failed step in the job logs.`,
    '',
  ];
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`);
}
