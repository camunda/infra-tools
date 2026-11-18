// Usage: node index.mjs --index <registry>/<repository>:<tag> <tool>@<version>...
// Adds the tool images of the given tool versions to the index at --index (lib/publish-index.mjs) and pushes it.
import { parseArgs } from 'node:util';
import { publishIndex } from './lib/publish-index.mjs';
import { Registry } from './lib/registry.mjs';
import { readToolDefinition } from './lib/repository.mjs';

const { values, positionals } = parseArgs({ options: { index: { type: 'string' } }, allowPositionals: true });
const [repository, tag] = values.index?.split(/:(?=[^:/]+$)/) ?? [];
if (!tag || !positionals.length) throw new Error('usage: node index.mjs --index <registry>/<repository>:<tag> <tool>@<version>...');

const toolVersions = [];
for (const selector of positionals) {
  const [name, version] = selector.split('@');
  toolVersions.push({ tool: await readToolDefinition(name), version });
}
const { entries, digest } = await publishIndex(new Registry(repository), tag, toolVersions);
console.log(`pushed ${values.index}@${digest}: ${entries.length} tool layers`);
for (const e of entries) console.log(`  ${e.platform} ${e.tool} ${e.version} ${e.tag} ${e.digest}`);
