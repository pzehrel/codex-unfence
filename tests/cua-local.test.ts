import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { readFile } from 'node:fs/promises';
import { deriveCua } from '../src/cua-analysis.js';
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
  assert.equal(before, 'await runtime.fetch(endpoint, options)');
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
  ['status interface', minimal.replace('if (!response.ok)', 'if (response.status !== 200 || !response.ok)')],
  ['headers interface', minimal.replace('if (!response.ok)', 'if (!response.headers || !response.ok)')],
  ['text interface', minimal.replace('await response.json()', 'await response.text()')],
  ['json arguments', minimal.replace('response.json()', 'response.json(1)')],
  ['response escape', minimal.replace('const body =', 'consume(response); const body =')],
  ['response property assignment', minimal.replace('const body =', 'response.ok = true; const body =')],
  ['shared transport', minimal + "async function other(runtime) { return await transport(runtime, 'https://example.test/other', {}); }"],
  ['escaped transport', minimal + '\nconst alias = transport;'],
  ['missing feature status consumption', minimal.replace('body.feature_status.agent', 'body.other.agent')],
  ['Object capture', 'const Object = {};\n' + minimal],
  ['Reflect capture', 'const Reflect = {};\n' + minimal],
  ['block Object capture', minimal.replace('return await runtime.fetch', 'const Object = {}; return await runtime.fetch')],
  ['transport ignores endpoint', minimal.replace('runtime.fetch(endpoint, options)', "runtime.fetch('https://example.test/other', options)")],
  ['transport overwrites endpoint parameter', minimal.replace('return await runtime.fetch', "endpoint = 'https://example.test/other'; return await runtime.fetch")],
  ['endpoint reassignment', minimal.replace("const endpoint = new URL('https://example.test/aura/site_status');", "let endpoint = new URL('https://example.test/aura/site_status'); endpoint = new URL('https://example.test/other');")],
  ['duplicate endpoint property', minimal.replace('endpoint.toString()', "({endpoint: '/aura/site_status', endpoint: '/other'}).endpoint")],
  ['unrelated logical endpoint branch', minimal.replace('endpoint.toString()', "('/other' || '/aura/site_status')")],
  ['arrow transport escape', minimal.replace('async function transport(runtime, endpoint, options)', 'const transport = async (runtime, endpoint, options) =>') + '\nconst alias = transport;'],
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

test('local admission supports direct fetch without a dedicated transport helper', () => {
  const source = minimal.slice(minimal.indexOf('async function check')).replace('transport(runtime, endpoint.toString(),', 'runtime.fetch(endpoint.toString(),');
  const result = deriveCua(source);
  assert.equal(result.support, 'supported', JSON.stringify(result.diagnostics));
  assert.equal(result.change?.before, "await runtime.fetch(endpoint.toString(), { method: 'GET' })");
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

test('local admission keeps UTF-16 ranges and deterministic results', () => {
  const source = '// 🧪\n' + minimal;
  supported(source);
  assert.deepEqual(deriveCua(source), deriveCua(source));
  assert.equal(deriveCua('async function {').diagnostics[0]?.code, 'PARSE_ERROR');
});
