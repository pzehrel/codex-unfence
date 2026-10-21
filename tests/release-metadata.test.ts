import assert from 'node:assert/strict';
import test from 'node:test';
import { npmTagForRelease } from '../scripts/release-metadata.js';

test('stable releases publish to latest', () => {
  assert.equal(npmTagForRelease('0.2.0', 'v0.2.0', false), 'latest');
});

test('prereleases publish to next', () => {
  assert.equal(npmTagForRelease('0.3.0-rc.1', 'v0.3.0-rc.1', true), 'next');
});

test('hyphens in build metadata do not make a stable version a prerelease', () => {
  const version = '0.3.0+build-1';
  assert.equal(npmTagForRelease(version, `v${version}`, false), 'latest');
  assert.throws(() => npmTagForRelease(version, `v${version}`, true), /prerelease flag/);
});

test('prerelease identifiers still select next when build metadata is present', () => {
  const version = '0.3.0-rc.1+build-1';
  assert.equal(npmTagForRelease(version, `v${version}`, true), 'next');
  assert.throws(() => npmTagForRelease(version, `v${version}`, false), /prerelease flag/);
});

test('release tags must match the package version and include the v prefix', () => {
  for (const tag of ['v0.1.0', 'v0.3.0', '0.2.0', 'v0.2.0\n']) {
    assert.throws(() => npmTagForRelease('0.2.0', tag, false), /must match package.json version/);
  }
});

test('a prerelease version cannot publish as a stable release', () => {
  assert.throws(() => npmTagForRelease('0.3.0-rc.1', 'v0.3.0-rc.1', false), /prerelease flag/);
});

test('a stable version cannot publish as a prerelease', () => {
  assert.throws(() => npmTagForRelease('0.2.0', 'v0.2.0', true), /prerelease flag/);
});
