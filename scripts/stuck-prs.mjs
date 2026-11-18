// Usage: node stuck-prs.mjs --repository <owner>/<name> --run-url <url> --out <file> < processed-prs.json
// Weekly digest of stuck Renovate PRs (lib/stuck-prs.mjs), from the processed-prs output of the renovate-pr-maintainer action
// on stdin. Writes the Slack payload to --out only when some PR is stuck.
import { writeFile } from 'node:fs/promises';
import { json } from 'node:stream/consumers';
import { parseArgs } from 'node:util';
import { STUCK_HOURS, stuckPrDigest } from './lib/stuck-prs.mjs';

const { values } = parseArgs({ options: { repository: { type: 'string' }, 'run-url': { type: 'string' }, out: { type: 'string' } } });
if (!values.repository || !values['run-url'] || !values.out) throw new Error('usage: node stuck-prs.mjs --repository <owner>/<name> --run-url <url> --out <file> < processed-prs.json');

const digest = stuckPrDigest(await json(process.stdin), { repository: values.repository, runUrl: values['run-url'] });
if (digest) await writeFile(values.out, `${JSON.stringify(digest, null, 2)}\n`);
console.log(digest ? `stuck PRs (dirty or awaiting rebase for ${STUCK_HOURS}h or more): digest written to ${values.out}` : `no PR dirty or awaiting rebase for ${STUCK_HOURS}h or more`);
