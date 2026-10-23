import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePackages } from '../lib/apt.mjs';

test('Packages index: one version per package, sorted', () => {
  const text = [
    'Package: libclamav12\nArchitecture: amd64\nVersion: 1.5.4+dfsg-0ubuntu0.24.04.1\nFilename: pool/main/libclamav12.deb',
    'Package: clamav\nVersion: 1.5.4+dfsg-0ubuntu0.24.04.1\nDepends: libclamav12',
    'Description: no package field',
  ].join('\n\n');
  assert.deepEqual(parsePackages(text), { clamav: '1.5.4+dfsg-0ubuntu0.24.04.1', libclamav12: '1.5.4+dfsg-0ubuntu0.24.04.1' });
});
