// Usage: node record.mjs [--results results.json] [--message-file commit.txt]
// Records published versions and retirements in published/<tool>.json and writes the conventional commit message
// (one entry per change) that drives release-please. Writes an empty message when nothing changed.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { args, log, main, readJson } from './lib/cli.mjs';
import { commitMessage, readCatalog, updateCatalog, writeCatalog } from './lib/catalog.mjs';
import { loadTools, ROOT } from './lib/config.mjs';

main(async () => {
  const opts = args({
    results: { type: 'string', default: join(ROOT, 'build/out/results.json') },
    'message-file': { type: 'string', default: join(ROOT, 'build/out/commit.txt') },
  });
  const { results } = await readJson(opts.results);
  const changes = [];
  for (const tool of await loadTools()) {
    const published = results.filter((r) => r.tool === tool.name && r.status === 'published');
    const current = await readCatalog(tool.name);
    const update = updateCatalog(tool, current, published);
    if (update.changes.length) {
      await writeCatalog(tool.name, update.entries);
      changes.push(...update.changes);
    }
  }
  const message = commitMessage(changes);
  await writeFile(opts['message-file'], message);
  log(message ? `recorded ${changes.length} change(s)` : 'nothing to record');
});
