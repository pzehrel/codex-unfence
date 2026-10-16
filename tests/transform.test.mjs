import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const fixture = await readFile(new URL('./fixtures/site-status.js.txt', import.meta.url), 'utf8');
const { transformSource } = await import('../dist/analysis.js');

test('pure transformation changes only the proven UTF-16 expression, preserving UTF-8 BOM, CRLF and non-BMP bytes', () => {
  const source = '﻿/* 中文 😀 */\r\n' + fixture.replaceAll('\n', '\r\n');
  const result = transformSource(source);
  assert.equal(result.analysis.compatibility, 'compatible');
  const change = result.transformation;
  assert.ok(change);
  assert.equal(change.before, 'body');
  assert.equal(change.after, '({...body,feature_status:{...body?.feature_status,agent:false}})');
  const before = Buffer.from(source.slice(0, change.range.start));
  const after = Buffer.from(source.slice(change.range.end));
  const patched = Buffer.from(change.patchedSource);
  assert.deepEqual(patched.subarray(0, before.length), before);
  assert.deepEqual(patched.subarray(patched.length - after.length), after);
  assert.ok(patched.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])));
  assert.match(change.localDiff, /UTF-16/);
  assert.match(change.localDiff, /agent:false/);
  assert.doesNotThrow(() => new vm.Script(change.patchedSource));
});

test('response copy overrides only local agent while preserving originals and other fields', () => {
  const { transformation } = transformSource(fixture);
  const copy = new vm.Script(`(body) => ${transformation.after}`).runInNewContext();
  for (const agent of [true, false, 1, 'true', null, undefined]) {
    const other = { retained: true };
    const flags = Object.freeze({ agent, comment: true, other });
    const body = Object.freeze({ feature_status: flags, metadata: other });
    const result = copy(body);
    assert.equal(result.feature_status.agent, false);
    assert.equal(result.feature_status.comment, true);
    assert.equal(result.feature_status.other, other);
    assert.equal(result.metadata, other);
    assert.notEqual(result, body);
    assert.notEqual(result.feature_status, flags);
    assert.equal(body.feature_status.agent, agent);
  }
  for (const body of [null, {}, { feature_status: null }]) {
    assert.equal(copy(body).feature_status.agent, false);
  }
});

test('transformed synthetic flow retains GET source, HTTP and JSON failures and subsequent checks', async () => {
  // Only this self-authored fixture is executed, after its execution sentinel is removed.
  const executable = fixture.replace("throw new Error('Do not execute analysis fixtures');", '');
  const { transformation } = transformSource(executable);
  const calls = [];
  const body = { feature_status: { agent: true, comment: true }, metadata: 7 };
  const runtime = { fetch: async (url, options) => {
    calls.push([url, options.method]);
    return { ok: true, json: async () => body };
  } };
  const evaluate = (text, input, extra = '') => new vm.Script(text + '\nnew Policy().check(runtime, "https://example.invalid/path?q=1").then(() => { ' + extra + ' });').runInNewContext({ runtime: input, URL });
  await assert.rejects(evaluate(executable, runtime), /site_status_blocked/);
  await evaluate(transformation.patchedSource, runtime);
  assert.deepEqual(calls, [
    ['https://chatgpt.com/backend-api/aura/site_status?site_url=https%3A%2F%2Fexample.invalid%2Fpath%3Fq%3D1', 'GET'],
    ['https://chatgpt.com/backend-api/aura/site_status?site_url=https%3A%2F%2Fexample.invalid%2Fpath%3Fq%3D1', 'GET'],
  ]);
  assert.equal(body.feature_status.agent, true);
  assert.equal(body.feature_status.comment, true);
  await assert.rejects(evaluate(transformation.patchedSource, { fetch: async () => ({ ok: false, json: async () => { throw new Error('must not parse'); } }) }), /Status request failed/);
  const jsonError = new Error('synthetic JSON failure');
  await assert.rejects(evaluate(transformation.patchedSource, { fetch: async () => ({ ok: true, json: async () => { throw jsonError; } }) }), (error) => error === jsonError);
  await assert.rejects(evaluate(transformation.patchedSource, runtime, 'throw new Error("user authorization still required");'), /user authorization still required/);
});

test('unsupported or ambiguous source never produces a transformation', () => {
  for (const text of ['function {', 'const unrelated = true;', fixture + fixture.slice(fixture.indexOf('class Policy')).replace('class Policy', 'class Other')]) {
    const result = transformSource(text);
    assert.equal(result.analysis.compatibility, 'incompatible');
    assert.equal(result.transformation, null);
  }
});
