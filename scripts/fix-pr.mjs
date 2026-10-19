// Usage: node fix-pr.mjs [--results results.json] [--registry <repo>] [--base main]
// Opens or extends one fix PR per failing version (grouped per tool and major when the error matches), comments when an
// error changes, and closes fix PRs whose versions are all published. Dry run without GITHUB_TOKEN.
import { join } from 'node:path';
import { args, log, main, readJson } from './lib/cli.mjs';
import { DEFAULT_REGISTRY, ROOT } from './lib/config.mjs';
import { branchFor, LABEL, parseMarker, pullFor, renderBody, signature } from './lib/fixpr.mjs';
import { GitHub } from './lib/github.mjs';
import { Registry } from './lib/registry.mjs';
import { majorOf } from './lib/versions.mjs';

main(async () => {
  const opts = args({
    results: { type: 'string', default: join(ROOT, 'build/out/results.json') },
    registry: { type: 'string', default: process.env.INFRA_TOOLS_REGISTRY ?? DEFAULT_REGISTRY },
    base: { type: 'string', default: process.env.INFRA_TOOLS_BASE_BRANCH ?? 'main' },
  });
  const { results } = await readJson(opts.results);
  const github = new GitHub();
  const runUrl = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : undefined;
  const failures = results.filter((r) => r.status === 'failed').map((r) => ({ ...r, signature: signature(r.error.excerpt) }));
  if (!github.enabled) {
    failures.forEach((f) => log(`dry run: fix PR for ${f.tool} ${f.version} (signature ${f.signature})`));
    return;
  }
  const open = (await github.labeledPulls(LABEL)).filter((p) => p.state === 'open');

  for (const f of failures) {
    const existing = open.find((p) => parseMarker(p.body)?.tool === f.tool && f.version in parseMarker(p.body).versions);
    if (existing) {
      const marker = parseMarker(existing.body);
      if (marker.signature !== f.signature) {
        marker.signature = f.signature;
        await github.comment(existing.number, `The error changed for ${f.tool} ${f.version}:\n\n\`\`\`text\n${f.error.excerpt.trim()}\n\`\`\``);
        existing.body = renderBody(marker, [f], runUrl);
        await github.updatePull(existing.number, { body: existing.body });
      }
      continue;
    }
    const pull = pullFor(f, open);
    if (pull) {
      const marker = parseMarker(pull.body);
      marker.versions[f.version] = f.tag;
      pull.body = renderBody(marker, [f], runUrl);
      await github.updatePull(pull.number, { title: `fix(${f.tool}): build ${Object.keys(marker.versions).join(', ')}`, body: pull.body });
      log(`${f.tool} ${f.version}: added to #${pull.number}`);
      continue;
    }
    const branch = branchFor(f.tool, f.folderVersion);
    await github.createBranch(branch, await github.branchSha(opts.base));
    await github.emptyCommit(branch, `fix(${f.tool}): build ${f.version}`);
    const marker = { tool: f.tool, major: majorOf(f.version), signature: f.signature, branch, versions: { [f.version]: f.tag } };
    const created = await github.createPull({ title: `fix(${f.tool}): build ${f.version}`, head: branch, base: opts.base, body: renderBody(marker, [f], runUrl) });
    await github.addLabels(created.number, [LABEL]);
    open.push({ ...created, state: 'open' });
    log(`${f.tool} ${f.version}: opened #${created.number}`);
  }

  const registry = new Registry(opts.registry);
  for (const pull of open) {
    const marker = parseMarker(pull.body);
    if (!marker) continue;
    const tags = Object.values(marker.versions);
    if ((await Promise.all(tags.map((t) => registry.exists(t)))).every(Boolean)) {
      await github.comment(pull.number, 'All versions of this PR are published now; closing.');
      await github.updatePull(pull.number, { state: 'closed' });
      await github.deleteBranch(marker.branch);
      log(`#${pull.number}: closed`);
    }
  }
});
