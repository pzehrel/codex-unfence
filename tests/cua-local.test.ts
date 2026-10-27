import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
import { deriveCua } from '../src/cua-analysis.js';
import { detectCuaPatch } from '../src/cua-patch-detection.js';
import { deriveCua as legacy } from '../src/cua-legacy-analysis.js';
import { sourceFixture } from './helpers/paths.js';

const minimal = `
async function transport(runtime, endpoint, options) {
  return await runtime.fetch(endpoint, options);
}
async function check(runtime, site) {
  const endpoint = new URL('https://example.test/aura/site_status');
  endpoint.searchParams.set('site_url', site);
  const response = await transport(runtime, endpoint.toString(), { method: 'GET' });
  if (!response.ok) throw new Error('failed');
  const body = await response.json();
  return body.feature_status.agent === true;
}
`;
function supported(source: string) {
  const result = deriveCua(source);
  assert.equal(result.support, 'supported', JSON.stringify(result.diagnostics));
  assert.ok(result.change);
  const { before, after, range, patchedSource } = result.change;
  assert.equal(before, 'await response.json()');
  assert.equal(source.slice(range.start, range.end), before);
  assert.equal(patchedSource.slice(0, range.start), source.slice(0, range.start));
  assert.equal(patchedSource.slice(range.start + after.length), source.slice(range.end));
  assert.equal(result.runtime, 'not-verified');
  return result.change;
}

test('local admission needs no policy class, cache, predicate template or fixed origin', () => {
  assert.equal(legacy(minimal).support, 'unsupported');
  supported(minimal);
});

test('local admission accepts new backend configuration and unrelated policy changes', async () => {
  const fixture = await readFile(sourceFixture('deferred-site-status.js.txt'), 'utf8');
  const changed = fixture
    .replace('conversationId: metadata?.session_id', 'backendApiBaseUrl: runtime.env?.backend, conversationId: metadata?.session_id')
    .replace('cache = new Map', 'cache = new Map')
    .replace('1440 * 60 * 1e3', '60 * 1e3');
  assert.notEqual(changed, fixture);
  assert.equal(legacy(changed).support, 'unsupported');
  supported(changed);
});

for (const [name, source] of [
  ['wrong endpoint', minimal.replace('/aura/site_status', '/other')],
  ['unrelated endpoint literal', minimal.replace("const endpoint = new URL('https://example.test/aura/site_status');", "const unused = '/aura/site_status'; const endpoint = new URL('https://example.test/other');")],
  ['wrong response binding', minimal.replace('await response.json()', 'await other.json()')],
  ['text interface', minimal.replace('await response.json()', 'await response.text()')],
  ['missing feature status consumption', minimal.replace('body.feature_status.agent', 'body.other.agent')],
  ['Object capture', 'const Object = {};\n' + minimal],
  ['Reflect capture', 'const Reflect = {};\n' + minimal],
  ['block Object capture', minimal.replace('const body =', 'const Object = {}; const body =')],
  ['transport ignores endpoint', minimal.replace('runtime.fetch(endpoint, options)', "runtime.fetch('https://example.test/other', options)")],
  ['transport overwrites endpoint parameter', minimal.replace('return await runtime.fetch', "endpoint = 'https://example.test/other'; return await runtime.fetch")],
  ['endpoint reassignment', minimal.replace("const endpoint = new URL('https://example.test/aura/site_status');", "let endpoint = new URL('https://example.test/aura/site_status'); endpoint = new URL('https://example.test/other');")],
  ['duplicate endpoint property', minimal.replace('endpoint.toString()', "({endpoint: '/aura/site_status', endpoint: '/other'}).endpoint")],
  ['unrelated logical endpoint branch', minimal.replace('endpoint.toString()', "('/other' || '/aura/site_status')")],
  ['response reinitialization', minimal.replace('const response =', 'var response =').replace('const body =', 'var response = other; const body =')],
] as const) {
  test(`local admission rejects ${name}`, () => {
    const result = deriveCua(source);
    assert.equal(result.support, 'unsupported', JSON.stringify(result));
    assert.equal(result.change, null);
  });
}

test('local admission rejects two distinct site-status injection points', () => {
  const second = minimal.replaceAll('transport', 'transport2').replaceAll('check(', 'check2(');
  assert.equal(deriveCua(minimal + second).diagnostics[0]?.code, 'AMBIGUOUS_TARGET');
});

test('local admission rejects a second site-status channel with an unsupported response interface', () => {
  const second = minimal.replaceAll('transport', 'transport2').replaceAll('check(', 'check2(').replace('response.ok', 'response.status');
  assert.equal(deriveCua(minimal + second).diagnostics[0]?.code, 'AMBIGUOUS_TARGET');
});

test('local admission rejects already wrapped source', () => {
  const change = supported(minimal);
  assert.equal(deriveCua(change.patchedSource).support, 'unsupported');
});

test('source detection verifies the complete installed wrapper at the selected JSON result', () => {
  const change = supported(minimal);
  const detected = detectCuaPatch(change.patchedSource);
  assert.equal(detected?.recipeVersion, 2);
  assert.equal(detected?.derivation.support, 'supported');
  assert.equal(detectCuaPatch(minimal), null);
  assert.ok(detectCuaPatch(change.patchedSource.replace('status.agent !== true', 'status.agent\n !== true')));
  assert.equal(detectCuaPatch(change.patchedSource.replace('agent: false', 'agent: true')), null);
  assert.equal(detectCuaPatch(change.patchedSource.replace('/aura/site_status', '/other')), null);
  assert.equal(detectCuaPatch(minimal + '\n// ' + JSON.stringify(change.after)), null);
  assert.equal(detectCuaPatch(minimal + '\nconst sample = ' + JSON.stringify(change.after) + ';'), null);
  const nested = change.patchedSource.replace(change.after, change.after.replace(change.before, change.after));
  assert.equal(detectCuaPatch(nested), null);
  assert.equal(detectCuaPatch(change.patchedSource + '\nconst unused = ' + change.after.replace(change.before, 'null') + ';'), null);
});

test('local admission supports direct fetch without a dedicated transport helper', () => {
  const source = minimal.slice(minimal.indexOf('async function check')).replace('transport(runtime, endpoint.toString(),', 'runtime.fetch(endpoint.toString(),');
  const result = deriveCua(source);
  assert.equal(result.support, 'supported', JSON.stringify(result.diagnostics));
  assert.equal(result.change?.before, 'await response.json()');
});

test('local admission preserves receiver, arguments, errors and response rewrite behavior', async () => {
  const change = supported(minimal);
  const check: unknown = runInNewContext(change.patchedSource + ';check');
  assert.equal(typeof check, 'function');
  if (typeof check !== 'function') return;
  let calls = 0;
  const original = { feature_status: { agent: true }, other: 7 };
  const runtime = {
    async fetch(endpoint: unknown, options: unknown) {
      assert.equal(this, runtime);
      assert.equal(endpoint, 'https://example.test/aura/site_status?site_url=https%3A%2F%2Fsite.test');
      assert.deepEqual(JSON.parse(JSON.stringify(options)), { method: 'GET' });
      calls++;
      return { ok: true, async json() { return original; } };
    },
  };
  // Use the same realm for JSON records and the injected standard capabilities.
  const run: unknown = runInNewContext(change.patchedSource + ';check', { URL, Object, Reflect });
  if (typeof run !== 'function') throw new Error('Expected check function');
  assert.equal(await run(runtime, 'https://site.test'), false);
  assert.equal(calls, 1);
  assert.equal(original.feature_status.agent, true);
  const failure = new Error('network');
  await assert.rejects(run({ fetch() { throw failure; } }, 'https://site.test'), error => error === failure);
});

test('shared and aliased transports leave unrelated responses and matching JSON fields untouched', async () => {
  const source = minimal.replace('return body.feature_status.agent === true;', 'void body?.feature_status; return body;') + `
const alias = transport;
async function other(runtime) { return await alias(runtime, 'https://example.test/other', {}); }
`;
  const change = supported(source);
  const context = { URL, Object, Reflect };
  const selected: unknown = runInNewContext(change.patchedSource + ';check', context);
  const other: unknown = runInNewContext(change.patchedSource + ';other', { URL, Object, Reflect });
  if (typeof selected !== 'function' || typeof other !== 'function') throw new Error('Expected test functions');
  const body = Object.freeze({ feature_status: Object.freeze({ agent: true, other: 2 }), other: Object.freeze({ keep: 7 }) });
  const response = new Response(JSON.stringify(body), { status: 201, headers: { 'x-test': 'preserved' } });
  const runtime = { async fetch() { return response; } };
  const unrelated: unknown = await other(runtime);
  assert.equal(unrelated, response);
  assert.deepEqual(await response.clone().json(), body);
  const result: unknown = await selected(runtime, 'https://site.test');
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { feature_status: { agent: false, other: 2 }, other: { keep: 7 } });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('x-test'), 'preserved');
  assert.equal(response.bodyUsed, true);
});

test('response interfaces, methods, identity and JSON arguments pass through unchanged', async () => {
  const source = minimal
    .replace('const body = await response.json();', "inspect(response); response.custom = 9; const body = await response.json('argument');")
    .replace('return body.feature_status.agent === true;', 'void body?.feature_status; return body;');
  const change = deriveCua(source).change;
  assert.ok(change);
  const body = Object.freeze({ feature_status: Object.freeze({ agent: true, other: 3 }), keep: Object.freeze({ value: 4 }) });
  const headers = new Headers({ 'x-test': 'preserved' });
  const response = {
    ok: true, status: 202, headers, custom: 0,
    text() { assert.equal(this, response); return 'text'; },
    arrayBuffer() { assert.equal(this, response); return new ArrayBuffer(3); },
    clone() { assert.equal(this, response); return response; },
    async json(argument: unknown) { assert.equal(this, response); assert.equal(argument, 'argument'); return body; },
  };
  let inspected = 0;
  const run: unknown = runInNewContext(change.patchedSource + ';check', { URL, Object, Reflect, inspect(value: unknown) {
    assert.equal(value, response);
    assert.equal(response.status, 202);
    assert.equal(response.headers, headers);
    assert.equal(response.text(), 'text');
    assert.equal(response.arrayBuffer().byteLength, 3);
    assert.equal(response.clone(), response);
    inspected++;
  } });
  if (typeof run !== 'function') throw new Error('Expected check function');
  const result = await run({ async fetch() { return response; } }, 'https://site.test');
  assert.equal(inspected, 1);
  assert.equal(response.custom, 9);
  assert.equal(result.keep, body.keep);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { feature_status: { agent: false, other: 3 }, keep: { value: 4 } });
  assert.equal(body.feature_status.agent, true);
});

test('JSON errors and data without a true agent flag pass through unchanged', async () => {
  const change = supported(minimal.replace('return body.feature_status.agent === true;', 'void body?.feature_status; return body;'));
  const run: unknown = runInNewContext(change.patchedSource + ';check', { URL, Object, Reflect });
  if (typeof run !== 'function') throw new Error('Expected check function');
  const values = [null, undefined, 7, [], {}, { feature_status: {} }, { feature_status: { agent: false } }, { feature_status: { agent: 'true' } }];
  for (const body of values) assert.equal(await run({ async fetch() { return { ok: true, async json() { return body; } }; } }, 'https://site.test'), body);
  const failure = new Error('JSON failure');
  await assert.rejects(run({ async fetch() { return { ok: true, json() { throw failure; } }; } }, 'https://site.test'), error => error === failure);
  await assert.rejects(run({ async fetch() { return { ok: true, json() { return Promise.reject(failure); } }; } }, 'https://site.test'), error => error === failure);
});

test('local admission keeps UTF-16 ranges and deterministic results', () => {
  const source = '// 🧪\n' + minimal;
  supported(source);
  assert.deepEqual(deriveCua(source), deriveCua(source));
  assert.equal(deriveCua('async function {').diagnostics[0]?.code, 'PARSE_ERROR');
});
