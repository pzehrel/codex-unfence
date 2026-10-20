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
