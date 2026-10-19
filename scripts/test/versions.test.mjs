import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  compareVersions, folderVersion, highestMatching, lineOf, matchesSelector, parseDuration, sortVersions, tagFor, trimVersion, versionFromFolder,
} from '../lib/versions.mjs';

test('builds of the same X.Y.Z are distinct and ordered by build', () => {
  assert.deepEqual(sortVersions(['21.0.12+101.0.LTS', '21.0.11+10.0.LTS', '21.0.12+8.0.LTS']), ['21.0.11+10.0.LTS', '21.0.12+8.0.LTS', '21.0.12+101.0.LTS']);
  assert.notEqual(compareVersions('21.0.12+8.0.LTS', '21.0.12+101.0.LTS'), 0);
});

test('numeric ordering', () => {
  assert.deepEqual(sortVersions(['26.11.10', '26.11.2', '26.9.0', '24.21.0']), ['24.21.0', '26.9.0', '26.11.2', '26.11.10']);
});

test('from is inclusive and covers its builds', () => {
  assert.ok(compareVersions('21.0.12', '21.0.12') === 0);
  assert.ok(compareVersions('21.0.12+8.0.LTS', '21.0.12') > 0);
  assert.ok(compareVersions('21.0.11+10.0.LTS', '21.0.12') < 0);
});

test('selectors match at their precision, + and - are equivalent', () => {
  assert.ok(matchesSelector('26.11.1', '26'));
  assert.ok(matchesSelector('26.11.1', '26.11'));
  assert.ok(!matchesSelector('26.11.10', '26.11.1'));
  assert.ok(matchesSelector('21.0.12+101.0.LTS', '21.0.12'));
  assert.ok(matchesSelector('21.0.12-8.0.LTS', '21.0.12+8'));
  assert.ok(matchesSelector('589.0.0', ''));
  assert.equal(highestMatching(['21.0.12+8.0.LTS', '21.0.12+101.0.LTS', '21.0.11+10.0.LTS'], '21'), '21.0.12+101.0.LTS');
  assert.equal(highestMatching(['26.11.1'], '27'), undefined);
});

test('line of a version: longest matching key', () => {
  assert.equal(lineOf('21.0.13+5', ['21', '25']), '21');
  assert.equal(lineOf('21+35', ['21']), '21');
  assert.equal(lineOf('1.25.12', ['1.25', '1']), '1.25');
  assert.equal(lineOf('1.250.0', ['1.25']), undefined);
  assert.equal(lineOf('26.11.3', ['26', '26.11']), '26.11');
  assert.equal(lineOf('27.0.0', ['26']), undefined);
});

test('folder and tag names', () => {
  assert.equal(folderVersion('21.0.12+101.0.LTS'), '21.0.12-101.0.LTS');
  assert.equal(versionFromFolder('21.0.12-101.0.LTS'), '21.0.12+101.0.LTS');
  assert.equal(tagFor('java', '21.0.12+101.0.LTS', 1), 'java-21.0.12-101.0.LTS-r1');
  assert.throws(() => tagFor('node', '26 .1', 1));
});

test('trim and durations', () => {
  assert.equal(trimVersion('21.0.12+101.0.LTS'), '21.0.12');
  assert.equal(trimVersion('589.0.0'), '589.0.0');
  assert.equal(parseDuration('3 days'), 3 * 86400e3);
  assert.equal(parseDuration('1 day'), 86400e3);
  assert.throws(() => parseDuration('soon'));
});
