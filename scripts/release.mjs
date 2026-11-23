// Usage: node release.mjs --image <registry>/<repository> --repository <owner>/<name> [--mirror <name>=<user>@<registry>/<repository>]...
//        [--out <dir>]
// The release (spec §5.5, ADR 0013, D64): publishes the draft release release-please created (lib/publish-release.mjs), its
// index pushed to --image and copied to each --mirror, logged in as <user> with the token in MIRROR_TOKEN_<NAME> (MIRROR_TOKEN_GAR
// for gar). Does nothing without a draft. Writes to --out (default build/out/release), for failure-issues.mjs, the failure
// report of each step that failed in reports/ (one JSON file per step; a step that never finished, its timeout, leaves one
// without its error) and the failure issue scopes the steps that passed resolve in resolve.txt, one per line; also writes
// tools.json before its upload, and the outcome to the job summary ($GITHUB_STEP_SUMMARY). Exits 1 when a step failed. Uses gh
// and its token (GH_TOKEN, else GITHUB_TOKEN) for GitHub, GITHUB_TOKEN for the registry.
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { publishRelease } from './lib/publish-release.mjs';
import { releaseFailureReport } from './lib/release-failures.mjs';
import { Registry } from './lib/registry.mjs';
import { ghApi, ghJson, ROOT } from './lib/repository.mjs';

const USAGE = 'usage: node release.mjs --image <registry>/<repository> --repository <owner>/<name> [--mirror <name>=<user>@<registry>/<repository>]... [--out <dir>]';
const { values } = parseArgs({
  options: {
    image: { type: 'string' },
    repository: { type: 'string' },
    mirror: { type: 'string', multiple: true, default: [] },
    out: { type: 'string', default: join(ROOT, 'build/out/release') },
  },
});
if (!values.image || !values.repository) throw new Error(USAGE);

// A mirror without its token, its login step having failed, fails its own step without any request: the registry client would
// otherwise send GITHUB_TOKEN to the mirror.
const mirrors = values.mirror.map((option) => {
  const match = option.match(/^([a-z0-9-]+)=([^@]+)@(.+)$/);
  if (!match) throw new Error(`--mirror ${option}: expected <name>=<user>@<registry>/<repository>\n${USAGE}`);
  const [, name, user, repository] = match;
  const variable = `MIRROR_TOKEN_${name.toUpperCase().replaceAll('-', '_')}`;
  const token = process.env[variable];
  if (!token) return { name, error: `${variable} is not set: the login step of mirror ${name} failed, see its log` };
  return { name, registry: new Registry(repository, { token, user }) };
});

const repo = `repos/${values.repository}`;
// The failure reports, replacing those written before.
const reports = join(values.out, 'reports');
async function writeReports(list) {
  await rm(reports, { recursive: true, force: true });
  await mkdir(reports, { recursive: true });
  for (const report of list) await writeFile(join(reports, `release-${report.key.step}.json`), `${JSON.stringify(report, null, 2)}\n`);
}
await writeReports([]);

// The tools.json asset of a release, by release id: a draft's tag name can be lost.
const toolsJsonAsset = (id) => ghJson(`${repo}/releases/${id}/assets`).find((a) => a.name === 'tools.json');
const github = {
  listReleases: () => JSON.parse(ghApi('', '--paginate', '--slurp', `${repo}/releases?per_page=100`)).flat(),
  toolNames: (ref) =>
    ghJson(`${repo}/contents/tools?ref=${ref}`)
      .filter((e) => e.type === 'dir')
      .map((e) => e.name),
  file: (path, ref) => ghJson(`${repo}/contents/${path}?ref=${ref}`, { accept: 'application/vnd.github.raw+json' }),
  updateRelease: (id, fields) => ghJson(`${repo}/releases/${id}`, { method: 'PATCH', body: fields }),
  // A failed upload can leave it in the starter state: no content.
  toolsJson: ({ id }) => {
    const asset = toolsJsonAsset(id);
    return asset?.state === 'uploaded' ? ghApi('', '-H', 'Accept: application/octet-stream', `${repo}/releases/assets/${asset.id}`) : null;
  },
  uploadToolsJson: async ({ id }, content) => {
    const path = join(values.out, 'tools.json');
    await writeFile(path, content);
    const asset = toolsJsonAsset(id);
    if (asset) ghJson(`${repo}/releases/assets/${asset.id}`, { method: 'DELETE' });
    ghApi('', '--method', 'POST', '-H', 'Content-Type: application/json', `https://uploads.github.com/${repo}/releases/${id}/assets?name=tools.json`, '--input', path);
  },
};

const { release, failures, resolve } = await publishRelease({
  registry: new Registry(values.image),
  mirrors,
  repository: values.repository,
  github,
  // The failures so far and the step in progress: one cut by the step's timeout is reported too.
  onStep: (step, version, failed) => writeReports([...failed, releaseFailureReport({ step, release: version })]),
});
await writeReports(failures);
await writeFile(join(values.out, 'resolve.txt'), resolve.map((scope) => `${scope}\n`).join(''));

const summary = [];
if (!failures.length) {
  const outcome = release ? `Release ${release} published: https://github.com/${values.repository}/releases/tag/${release}` : 'No draft release: every release is published.';
  console.log(outcome);
  summary.push('## Release', '', outcome, '');
}
for (const { key, context, state, errors } of failures) {
  const title = `Run failure: release ${[key.release, key.step].filter(Boolean).join(' ')}`;
  console.error(`${title}\n${Object.values(errors).join('\n')}`);
  summary.push(
    `## ${title}`,
    '',
    `${context} ${state} The **Open, update and close the failure issues** step tracks it in its failure issue (\`run-failure\` label), with its procedure from \`docs/runbooks/release/${key.step.split('.')[0]}.md\`.`,
    '',
  );
}
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary.join('\n')}\n`);
if (failures.length) process.exitCode = 1;
