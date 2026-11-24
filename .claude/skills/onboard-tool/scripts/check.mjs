// Usage: node check.mjs <tool>
// Quick check of a new tool definition, without building: tools/<tool>/tool.json parses, the upstream lookup works, and the
// reconciler would publish (or wait for) the expected versions, as for a tool with nothing published yet; then the linters on
// the tool's files. Needs scripts/node_modules (npm ci in scripts/).
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const name = process.argv[2];
if (!name) {
  console.error('Usage: node check.mjs <tool>');
  process.exit(2);
}
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const { parseToolDefinition, isPlainTool } = await import(join(root, 'scripts/lib/tool-definition.mjs'));
const { planTool } = await import(join(root, 'scripts/lib/plan.mjs'));

const tool = parseToolDefinition(name, JSON.parse(await readFile(join(root, 'tools', name, 'tool.json'), 'utf8')));
const { cacheFolder, archFolders, addToPath } = tool.install;
console.log(`Definition: ${isPlainTool(tool) ? `plain tool, ${addToPath} on PATH` : `tool-cache tool${tool.setup ? ` for ${tool.setup.action}` : ''}`}`);
console.log(`Tool cache: ${cacheFolder}/<version>/{${archFolders.amd64},${archFolders.arm64}}`);

const plan = await planTool(tool, { tags: [], platformsOf: async () => [] });
console.log(`Upstream: ${plan.upstream ?? 'no project link'}`);
const shown = plan.versions.filter((v) => v.decision !== 'skip');
const skipped = plan.versions.length - shown.length;
for (const v of shown) {
  const missing = v.missing?.length ? ` (upstream lacks ${v.missing.join(', ')})` : '';
  console.log(`  ${v.decision} ${v.version}: ${v.reason}${missing}`);
}
console.log(`  ${skipped} older or out-of-line versions skipped`);
if (!shown.length) console.log('Nothing to publish: check the lines (from, versions) against the upstream versions.');

const files = ['tool.json', 'install.sh', 'test.sh'].map((f) => join('tools', name, f));
const lint = spawnSync('pre-commit', ['run', '--files', ...files, 'docs/spec.md'], { cwd: root, encoding: 'utf8' });
if (lint.error) console.log('Lint: pre-commit not found, skipped');
else {
  const failed = lint.stdout.split('\n').filter((l) => /Failed|- hook id|^[^ ].*:\d+/.test(l));
  console.log(lint.status === 0 ? 'Lint: passed' : `Lint: failed\n${failed.join('\n')}`);
  process.exitCode = lint.status;
}
