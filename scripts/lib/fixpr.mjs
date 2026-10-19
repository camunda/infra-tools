import { createHash } from 'node:crypto';
import { majorOf } from './versions.mjs';

export const LABEL = 'tool-build';
const MARKER = /<!-- tool-build: (\{.*\}) -->/;

export const parseMarker = (body) => {
  const match = MARKER.exec(body ?? '');
  return match ? JSON.parse(match[1]) : null;
};

// Error signature: the last error lines without versions, digests and timestamps, so the same failure groups across versions.
export function signature(excerpt) {
  const normalized = String(excerpt)
    .split('\n')
    .filter((l) => /error|fail|not found|404/i.test(l))
    .slice(-5)
    .join('\n')
    .replace(/sha256:[0-9a-f]+/g, 'sha256')
    .replace(/\d+(\.\d+)+([+-][\w.]+)?/g, 'V')
    .replace(/#\d+ [\d.]+/g, '#');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

export const branchFor = (tool, folderVersion) => `tool-build/${tool}-${folderVersion}`;

// Versions an open fix PR tracks, and versions whose fix PR was closed without merge (treated as ignored).
export function trackedVersions(pulls) {
  const tracked = { open: new Map(), ignored: new Map() };
  for (const pull of pulls) {
    const marker = parseMarker(pull.body);
    if (!marker) continue;
    const target = pull.state === 'open' ? tracked.open : pull.pull_request?.merged_at ? null : tracked.ignored;
    if (!target) continue;
    for (const version of Object.keys(marker.versions)) target.set(`${marker.tool}|${version}`, pull.number);
  }
  return tracked;
}

// Open PR to extend for a failure: same tool and major, same error signature.
export function pullFor(failure, openPulls) {
  return openPulls.find((pull) => {
    const m = parseMarker(pull.body);
    return m && m.tool === failure.tool && m.major === majorOf(failure.version) && m.signature === failure.signature;
  });
}

export function renderBody(marker, failures, runUrl) {
  const versions = Object.keys(marker.versions);
  const latest = failures.at(-1);
  return [
    `The reconciler could not build or test ${marker.tool} ${versions.join(', ')}.`,
    '',
    `Failing step: \`${latest.error.step}\`${runUrl ? ` ([run](${runUrl}))` : ''}`,
    '',
    '```text',
    latest.error.excerpt.trim(),
    '```',
    '',
    'Push the fix to this branch (usually an `if version ≥ X` in the tool\'s `install.sh` or `test.sh`).',
    'Merging publishes the versions on the next reconciler run; closing this PR ignores them. Split it if versions need different fixes.',
    '',
    `<!-- tool-build: ${JSON.stringify(marker)} -->`,
  ].join('\n');
}
