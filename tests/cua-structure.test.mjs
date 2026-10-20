import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { deriveCua } from '../dist/cua-analysis.js';

const fixture = await readFile(new URL('./fixtures/deferred-site-status.js.txt', import.meta.url), 'utf8');

test('derives the unique dedicated transport in a complete synthetic site-status chain', () => {
  const result = deriveCua(fixture);
  assert.equal(result.support, 'supported', JSON.stringify(result.diagnostics));
  assert.equal(result.scheme, 'cua-site-status-transport-v1');
  assert.equal(result.recipeVersion, 1);
  assert.equal(result.runtime, 'not-verified');
  assert.ok(result.assumptions.length > 0);
  assert.deepEqual(new Set(result.evidence.map(item => item.kind)), new Set(['source', 'transport', 'response', 'predicate', 'consumption', 'receiver']));
  assert.equal(result.change.before, 'await runtime.fetch(endpoint, options)');
  assert.equal(fixture.slice(result.change.range.start, result.change.range.end), result.change.before);
  assert.equal(result.change.range.unit, 'utf16');
  assert.deepEqual(deriveCua(fixture), result);
});

test('refuses configuration whose once initializer never runs', () => {
  const result = deriveCua(fixture.replace('initialize();', ''));
  assert.equal(result.support, 'unsupported');
  assert.equal(result.change, null);
  assert.match(result.diagnostics[0].code, /INITIALIZATION/);
});

test('refuses visible standard capability mutation and dynamic scope', () => {
  for (const change of [
    'Object.defineProperty(URL.prototype, "pathname", {set(value) {}});',
    'Map.prototype.get = function () { return true; };',
    'const standard = URL; standard.prototype.toString = () => "changed";',
    'globalThis["URL"] = function () {};',
    'eval("URL = function () {}");',
  ]) {
    const result = deriveCua(change + fixture);
    assert.equal(result.support, 'unsupported', change);
    assert.equal(result.change, null);
  }
});

test('refuses conditional, reordered and changed once initialization', () => {
  const inputs = [
    fixture.replace('initialize();', 'if (false) initialize();'),
    fixture.replace('initialize();', '').concat('\nenforce({}, "https://example.com"); initialize();'),
    fixture.replace("baseUrl = 'https://chatgpt.com/backend-api'", "if (false) baseUrl = 'https://chatgpt.com/backend-api'"),
    fixture.replace('task(task = 0)', 'task(task)'),
  ];
  for (const source of inputs) {
    const result = deriveCua(source);
    assert.equal(result.support, 'unsupported', source.slice(-100));
    assert.equal(result.change, null);
  }
});
