// Usage: node build.mjs [--plan plan.json] [--push] [--platforms linux/amd64,linux/arm64] [--concurrency 2] [--results results.json]
// Builds and tests each planned version with Bake; with --push, pushes the line image of each version whose test passed.
// Failures are recorded in the results (for fix PRs), not thrown.
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { args, log, main, pool, readJson, writeJson } from './lib/cli.mjs';
import { PLATFORMS, ROOT } from './lib/config.mjs';

const OUT = join(ROOT, 'build/out');
const COMMIT = process.env.GITHUB_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();

function bake(files, target, extra, logFile) {
  return new Promise((resolve) => {
    const out = createWriteStream(logFile, { flags: 'a' });
    const child = spawn('docker', ['buildx', 'bake', ...files.flatMap((f) => ['-f', f]), '--progress=plain', ...extra, target], { cwd: ROOT, env: process.env });
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    child.on('close', (code) => out.end(() => resolve(code)));
  });
}

async function excerpt(logFile) {
  const lines = (await readFile(logFile, 'utf8')).split('\n');
  const error = lines.findIndex((l) => /^ERROR|ERROR: /.test(l));
  return lines.slice(Math.max(0, (error < 0 ? lines.length : error) - 25), error < 0 ? lines.length : error + 5).join('\n');
}

main(async () => {
  const opts = args({
    plan: { type: 'string', default: join(OUT, 'plan.json') },
    push: { type: 'boolean', default: false },
    platforms: { type: 'string', default: PLATFORMS.join(',') },
    concurrency: { type: 'string', default: '2' },
    results: { type: 'string', default: join(OUT, 'results.json') },
  });
  const plan = await readJson(opts.plan);
  process.env.PLATFORMS = opts.platforms;
  await Promise.all(['bake', 'logs', 'meta'].map((d) => mkdir(join(OUT, d), { recursive: true })));

  const results = await pool(plan.items, Number(opts.concurrency), async (item) => {
    const id = `${item.tool}-${item.folderVersion}-r${item.revision}`.replace(/[^A-Za-z0-9_-]/g, '_');
    const args = { VERSION: item.version, FOLDER_VERSION: item.folderVersion, CACHE_FOLDER: item.cacheFolder, ARCH_FOLDERS: item.archFolders };
    const definition = join(OUT, 'bake', `${id}.json`);
    await writeJson(definition, {
      target: {
        [`line-${id}`]: {
          inherits: ['_line'],
          context: `tools/${item.tool}`,
          dockerfile: item.dockerfile,
          args,
          tags: [`${plan.registry}:${item.tag}`],
          annotations: [
            `index,manifest:org.opencontainers.image.source=https://github.com/camunda/infra-tools`,
            `index:io.camunda.infra-tools.tool=${item.tool}`,
            `index:io.camunda.infra-tools.version=${item.version}`,
            `index:io.camunda.infra-tools.revision=${item.revision}`,
          ],
        },
        [`test-${id}`]: { inherits: ['_test'], context: `tools/${item.tool}`, dockerfile: join(ROOT, 'build/test.Dockerfile'), contexts: { line: `target:line-${id}` }, args },
      },
    });
    const files = [join(ROOT, 'build/docker-bake.hcl'), definition];
    const logFile = join(OUT, 'logs', `${id}.log`);
    const result = { ...item, log: logFile };

    log(`${item.tool} ${item.version}: build and test`);
    if ((await bake(files, `test-${id}`, [], logFile)) !== 0) {
      log(`${item.tool} ${item.version}: failed`);
      return { ...result, status: 'failed', error: { step: 'build and test', excerpt: await excerpt(logFile) } };
    }
    if (!opts.push) return { ...result, status: 'tested' };

    const meta = join(OUT, 'meta', `${id}.json`);
    const push = ['--provenance=false', '--set', `line-${id}.output=type=registry,oci-mediatypes=true`, '--metadata-file', meta];
    if ((await bake(files, `line-${id}`, push, logFile)) !== 0) {
      return { ...result, status: 'failed', error: { step: 'push', excerpt: await excerpt(logFile) } };
    }
    const digest = (await readJson(meta))[`line-${id}`]?.['containerimage.digest'];
    log(`${item.tool} ${item.version}: published ${item.tag}`);
    return { ...result, status: 'published', digest, commit: COMMIT };
  });

  await writeJson(opts.results, { registry: plan.registry, results });
  const count = (s) => results.filter((r) => r.status === s).length;
  log(`published ${count('published')}, tested ${count('tested')}, failed ${count('failed')}`);
});
