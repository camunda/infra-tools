// Files of this repository read by the scripts.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseToolDefinition } from './tool-definition.mjs';

export const ROOT = fileURLToPath(new URL('../..', import.meta.url));

export async function readToolDefinition(name) {
  return parseToolDefinition(name, JSON.parse(await readFile(join(ROOT, 'tools', name, 'tool.json'), 'utf8')));
}
