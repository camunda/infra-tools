import { parseArgs } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export function args(options) {
  return parseArgs({ options, allowPositionals: false }).values;
}

export const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

export async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(data, null, 2)}\n`);
}

export const log = (...parts) => console.error(...parts);

export async function main(fn) {
  try {
    await fn();
  } catch (err) {
    log(`error: ${err.message}${err.cause ? ` (${err.cause.code ?? err.cause.message})` : ''}`);
    process.exitCode = 1;
  }
}

export async function pool(items, concurrency, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await worker(items[i], i);
      }
    }),
  );
  return results;
}
