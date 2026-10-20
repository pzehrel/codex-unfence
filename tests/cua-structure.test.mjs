import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parse } from 'acorn';
import { analyze } from 'eslint-scope';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
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

const guardedMethod = `
  async throwIfBlocksUrl(runtime, site, backend, browser, authorization = 'browser-origin-access') {
    if (bypass(runtime, 'check-url-site-status') || typeof site != 'string') return;
    let status = await this.checkUrl(runtime, site, backend);
    if (status == null) return;
    let { request, result } = status, label = display(browser), family = browser?.browserFamily;
    if (result.blocked) throw log(() => ({ authorization, backend, browserFamily: family, check: 'check-url-site-status', origin: origin(site) ?? void 0, permissionSource: 'site-status', outcome: 'denied', reason: 'site_status_blocked', ...result.cached ? { cached: true } : {} })), new SiteError('site_status_blocked', \`\${label} blocked on \${request.displayUrl}\`);
  }
`;
const guardedHelpers = `
function bypass(runtime, check) { return false; }
function display(browser) { return browser?.name ?? 'synthetic'; }
function origin(site) { return new URL(site).origin; }
function log(event) { event(); }
class SiteError extends Error {}
`;
const guardedFixture = guardedHelpers + fixture.slice(0, fixture.indexOf('function checkSite')).replace('  async checkUrl(', guardedMethod + '  async checkUrl(');

test('supports the finite guarded class consumer while retaining bypass, logging and original cache code', () => {
  const result = deriveCua(guardedFixture);
  assert.equal(result.support, 'supported', JSON.stringify(result.diagnostics));
  assert.ok(result.change.patchedSource.includes(guardedMethod));
});

test('supports a once-initialized local terminal error class', () => {
  const source = guardedFixture.replace('class SiteError extends Error {}', 'var SiteError, initErrorClass = once(() => { SiteError = class extends Error {}; });\ninitErrorClass();');
  const result = deriveCua(source);
  assert.equal(result.support, 'supported', JSON.stringify(result.diagnostics));
});

test('supports a direct async callback consuming the guarded policy result', () => {
  const source = guardedFixture.replace('class SiteError extends Error {}', 'var SiteError, initErrorClass = once(() => { SiteError = class extends Error {}; });\ninitErrorClass();') + `
function checkSite(runtime, site, backend) { return policy.checkUrl(runtime, site, backend); }
const controller = { validate: async site => {
  if ((await checkSite(this.runtime, site, this.browserBackend))?.result.blocked)
    throw new SiteError('siteStatus', 'site_status_blocked', 'Blocked', { origin: origin(site) ?? void 0, source: 'site-status' });
} };
`;
  const result = deriveCua(source);
  assert.equal(result.support, 'supported', JSON.stringify(result.diagnostics));
});

test('supports a top-level class-expression terminal error binding', () => {
  const source = guardedFixture.replace('class SiteError extends Error {}', 'const SiteError = class extends Error {};');
  const result = deriveCua(source);
  assert.equal(result.support, 'supported', JSON.stringify(result.diagnostics));
});

const headerMetadata = `function getMetadata(runtime) {
  let value = runtime.requestMeta?.['x-codex-turn-metadata'];
  if (typeof value == 'string') try { value = JSON.parse(value); } catch { return; }
  if (!(value == null || typeof value != 'object' || Array.isArray(value))) return value;
}`;

test('supports finite turn-header parsing with the same runtime and parsed metadata binding', () => {
  const result = deriveCua(fixture.replace('function getMetadata(runtime) { return runtime.turn; }', headerMetadata));
  assert.equal(result.support, 'supported', JSON.stringify(result.diagnostics));
});

test('supports a bound literal-only error formatter without changing the original guard', () => {
  const source = 'function message(text) { return `synthetic: ${text}`; }\n' + fixture.replace("new Error('Missing fetch')", "new Error(message('Missing fetch'))");
  const result = deriveCua(source);
  assert.equal(result.support, 'supported', JSON.stringify(result.diagnostics));
  assert.ok(result.change.patchedSource.includes("new Error(message('Missing fetch'))"));
});

test('refuses initializer calls hidden after return or under a conditional', () => {
  for (const source of [
    fixture.replace('var initialize = once(() => {', 'var initialize = once(() => { return;'),
    fixture.replace('initErrors(); initSiteStatus();', 'initErrors(); if (false) initSiteStatus();').replace('var initErrors = once(() => { initMetadata(); initSiteStatus(); });', 'var initErrors = once(() => { initMetadata(); if (false) initSiteStatus(); });'),
  ]) {
    const result = deriveCua(source);
    assert.equal(result.support, 'unsupported');
    assert.equal(result.change, null);
  }
});

test('requires direct constant configuration before the policy can be consumed', () => {
  const direct = fixture.replace(/var baseUrl, agentKey, requestSource, initSiteStatus = once\(\(\) => \{[\s\S]*?\n\}\);/, "var baseUrl = 'https://chatgpt.com/backend-api', agentKey = 'agent', requestSource = 'codex_browser_use'; var initSiteStatus = once(() => {});");
  assert.equal(deriveCua(direct).support, 'supported');
  const declaration = "var baseUrl = 'https://chatgpt.com/backend-api', agentKey = 'agent', requestSource = 'codex_browser_use';";
  const late = direct.replace(declaration, '') + '\nenforce({}, "https://example.com");\n' + declaration;
  const result = deriveCua(late);
  assert.equal(result.support, 'unsupported');
  assert.equal(result.change, null);
});

test('refuses destructured and global-root aliases that modify standard capabilities', () => {
  for (const prefix of [
    'const {prototype: original} = URL; original.toString = function () { return "changed"; };',
    'const globals = globalThis; globals.URL.prototype.toString = function () { return "changed"; };',
    'const {URL: constructor} = globalThis; constructor.prototype.toString = function () { return "changed"; };',
    'const globals = globalThis; globals[unknownKey] = function () {};',
  ]) {
    const result = deriveCua(prefix + fixture);
    assert.equal(result.support, 'unsupported', prefix);
    assert.equal(result.change, null);
  }
});

function renamed(source, prefix) {
  const program = parse(source, { ecmaVersion: 2022, sourceType: 'module', ranges: true });
  const scopes = analyze(program, { ecmaVersion: 2022, sourceType: 'module' });
  const edits = new Map(), shorthands = new Set();
  function collect(node) {
    if (node.type === 'Property' && node.shorthand) shorthands.add(node.value.start);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) { for (const child of value) if (child?.type) collect(child); }
      else if (value?.type) collect(value);
    }
  }
  collect(program);
  let index = 0;
  for (const scope of scopes.scopes) for (const binding of scope.variables) {
    if (!binding.defs.length) continue;
    const replacement = prefix + index++;
    for (const node of [...binding.identifiers, ...binding.references.map(ref => ref.identifier)]) edits.set(node.start, { start: node.start, end: node.end, replacement });
  }
  for (const edit of [...edits.values()].sort((a, b) => b.start - a.start)) {
    // Expand shorthand keys: renaming a value must keep the public property.
    const old = source.slice(edit.start, edit.end);
    const shorthand = shorthands.has(edit.start);
    source = source.slice(0, edit.start) + (shorthand ? `${old}: ${edit.replacement}` : edit.replacement) + source.slice(edit.end);
  }
  return source;
}

test('supports lexical renaming, Unicode offsets and unrelated module code with genuine distinct digests', () => {
  const shifted = '/* 中文 🦉 unrelated prefix */\nconst unrelatedValue = 17;\n' + renamed(fixture, 'local') + '\nfunction unrelatedFetch(runtime) { return runtime.fetch("other"); }';
  const result = deriveCua(shifted);
  assert.equal(result.support, 'supported', JSON.stringify(result.diagnostics));
  assert.notEqual(createHash('sha256').update(shifted).digest('hex'), createHash('sha256').update(fixture).digest('hex'));
  const { range, after, patchedSource } = result.change;
  assert.equal(patchedSource.slice(0, range.start), shifted.slice(0, range.start));
  assert.equal(patchedSource.slice(range.start + after.length), shifted.slice(range.end));
  assert.deepEqual(Buffer.from(patchedSource.slice(0, range.start)), Buffer.from(shifted.slice(0, range.start)));
  assert.deepEqual(Buffer.from(patchedSource.slice(range.start + after.length)), Buffer.from(shifted.slice(range.end)));
  assert.equal(deriveCua(patchedSource).support, 'unsupported');
});

test('refuses another plausible site-status channel even when only one is fully supported', () => {
  const second = renamed(fixture.replace("{ method: 'GET' }", "{ method: 'POST' }"), 'other');
  const result = deriveCua(fixture + '\n' + second.replace("import { basename } from 'node:path';", ''));
  assert.equal(result.support, 'unsupported');
  assert.equal(result.change, null);
});

test('refuses ambiguity, unknown response interfaces, changed provenance, receivers and boolean semantics', () => {
  const cases = [
    fixture + renamed(fixture, 'another').replace("import { basename } from 'node:path';", ''),
    fixture.replace('/aura/site_status', '/aura/other'),
    fixture.replace("{ method: 'GET' }", "{ method: 'POST' }"),
    fixture.replace('await response.json()', 'await other.json()'),
    fixture.replace('if (!response.ok)', 'response.text(); if (!response.ok)'),
    fixture.replace('return agentBlocked(body);', 'return agentBlocked({ feature_status: { agent: true } });'),
    fixture.replace('flags[key] === true', 'flags[key] == true'),
    fixture.replace('return await runtime.fetch(endpoint, options)', 'const borrowed = runtime.fetch; return await borrowed(endpoint, options)'),
    fixture.replace('const unrelated =', 'const URL = function () {}; const unrelated ='),
    fixture + '\nunknown(transport);',
    fixture + '\nObject.defineProperty(SitePolicy.prototype, "fetchBlocked", {value: unknown});',
    fixture.replace('return agentBlocked(body);', 'unknown(body); return agentBlocked(body);'),
    fixture.replace('function agentBlocked(body) {', 'function agentBlocked(body) { enabled = unknown;'),
  ];
  for (const source of cases) {
    const result = deriveCua(source);
    assert.equal(result.support, 'unsupported', result.change?.before);
    assert.equal(result.change, null);
    assert.ok(result.diagnostics.length);
  }
});

test('returns parse diagnostics for invalid and unsupported syntax without throwing', () => {
  for (const source of ['function {', 'await using value = item;', '']) {
    const result = deriveCua(source);
    assert.equal(result.support, 'unsupported');
    assert.equal(result.change, null);
    assert.ok(result.diagnostics.length);
  }
});

function executable() {
  const result = deriveCua(fixture);
  assert.equal(result.support, 'supported');
  const source = result.change.patchedSource.replace("import { basename } from 'node:path';", '').replace("basename('/unrelated');", '');
  return runInNewContext(`(function () { ${source}; return {transport, SitePolicy, policy, enforce}; })()`, { URL, Map, Date, Object, Reflect, Error, JSON });
}

test('compiled replacement preserves fetch receiver, request identity, lazy ok and json receiver/order', async () => {
  const events = [], endpoint = {}, options = {}, original = Object.freeze({ feature_status: Object.freeze({ agent: true, other: 4 }), other: 7 });
  const response = Object.freeze({
    get ok() { assert.equal(this, response); events.push('ok'); return 'yes'; },
    get json() { assert.equal(this, response); events.push('json-read'); return function () { assert.equal(this, response); assert.equal(arguments.length, 0); events.push('json-call'); return { then(resolve) { events.push('json-await'); resolve(original); } }; }; },
  });
  const runtime = Object.freeze({ fetch(url, init) { assert.equal(this, runtime); assert.equal(url, endpoint); assert.equal(init, options); assert.equal(arguments.length, 2); events.push('fetch'); return { then(resolve) { events.push('fetch-await'); resolve(response); } }; } });
  const api = executable();
  const wrapped = await api.transport(runtime, endpoint, options);
  assert.deepEqual(events, ['fetch', 'fetch-await']);
  assert.equal(wrapped.ok, 'yes');
  assert.equal(wrapped.ok, 'yes');
  assert.deepEqual(events, ['fetch', 'fetch-await', 'ok', 'ok']);
  const result = await wrapped.json();
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { feature_status: { agent: false, other: 4 }, other: 7 });
  assert.notEqual(result, original);
  assert.notEqual(result.feature_status, original.feature_status);
  assert.equal(original.feature_status.agent, true);
  assert.deepEqual(events.slice(4), ['json-read', 'json-call', 'json-await']);
});

test('compiled replacement propagates original errors and passes unsupported JSON shapes by identity', async () => {
  const { transport, policy } = executable(), failure = new Error('original failure');
  for (const fetch of [() => { throw failure; }, () => Promise.reject(failure)]) await assert.rejects(transport({ fetch }), error => error === failure);
  let reads = 0;
  await assert.rejects(policy.fetchBlocked({ fetch() { return { ok: false, json() { reads++; } }; } }, { endpoint: 'synthetic' }));
  assert.equal(reads, 0);
  const accessor = Object.defineProperty({}, 'feature_status', { enumerable: true, get() { throw failure; } });
  const values = [null, undefined, true, [], {}, { feature_status: { agent: 1 } }, { feature_status: { agent: 'true' } }, { feature_status: { agent: false } }, accessor, { feature_status: Object.create({ agent: true }) }, { feature_status: { agent: true }, [Symbol('keep')]: 1 }];
  for (const value of values) {
    const wrapped = await transport({ fetch() { return { json() { return value; } }; } });
    assert.equal(await wrapped.json(), value);
  }
  for (const response of [{ get ok() { throw failure; } }, { get json() { throw failure; } }, { json() { throw failure; } }, { json() { return Promise.reject(failure); } }]) {
    const wrapped = await transport({ fetch() { return response; } });
    if (!('json' in response)) assert.throws(() => wrapped.ok, error => error === failure);
    else await assert.rejects(wrapped.json(), error => error === failure);
  }
  const body = JSON.parse('{"__proto__":{"keep":1},"feature_status":{"__proto__":{"keep":2},"agent":true}}');
  const wrapped = await transport({ fetch() { return { json() { return body; } }; } });
  const copied = await wrapped.json();
  assert.equal(Object.hasOwn(copied, '__proto__'), true);
  assert.equal(Object.hasOwn(copied.feature_status, '__proto__'), true);
  assert.equal(copied.feature_status.agent, false);
  assert.equal(body.feature_status.agent, true);
});

test('refuses related export exposure even without an extra local reference', () => {
  for (const source of [
    fixture.replace('async function transport(', 'export async function transport('),
    fixture.replace('var ttl =', 'export var ttl ='),
    fixture.replace('function agentBlocked(', 'export function agentBlocked('),
  ]) {
    const result = deriveCua(source);
    assert.equal(result.support, 'unsupported');
    assert.equal(result.change, null);
  }
});

test('requires initialization assignment itself to be reachable before any abrupt statement', () => {
  for (const abrupt of ['return;', 'throw new Error("stop");']) {
    const result = deriveCua(fixture.replace("baseUrl = 'https://chatgpt.com/backend-api'", abrupt + " baseUrl = 'https://chatgpt.com/backend-api'"));
    assert.equal(result.support, 'unsupported', abrupt);
    assert.equal(result.change, null);
  }
});

test('tracks destructured aliases of the global root itself', () => {
  const source = 'const {globalThis: globals} = globalThis; globals.URL.prototype.toString = () => "changed";\n' + fixture;
  assert.equal(deriveCua(source).support, 'unsupported');
});

test('refuses an additional unknown chain with statically computed blocked reads', () => {
  const second = renamed(fixture, 'computed').replace("import { basename } from 'node:path';", '').replaceAll('.blocked', '["blocked"]');
  const result = deriveCua(fixture + second);
  assert.equal(result.support, 'unsupported');
  assert.equal(result.change, null);
});

const readerFixture = await readFile(new URL('./fixtures/cua-structural-reader.js.txt', import.meta.url), 'utf8');

test('admits only the linked finite ZXing reader bridge under an explicit noninterference assumption', () => {
  const result = deriveCua(fixture + readerFixture);
  assert.equal(result.support, 'supported', JSON.stringify(result.diagnostics));
  assert.ok(result.assumptions.some(text => /ZXing/.test(text) && /not proved/.test(text)));
  assert.ok(result.evidence.some(item => /ZXing/.test(item.description)));
});

test('permits finite conditional unrelated global keys while refusing unknown keys', () => {
  const source = 'const globals = globalThis; globals[choose ? "syntheticStateA" : "syntheticStateB"] = {};\n' + fixture;
  assert.equal(deriveCua(source).support, 'supported');
});

test('permits the finite read-only instanceof helper for standard error classification', () => {
  const result = deriveCua('function instance(value, constructor) { try { return value instanceof constructor; } catch { return false; } }\ninstance(synthetic, Error);\n' + fixture);
  assert.equal(result.support, 'supported', JSON.stringify(result.diagnostics));
});

test('permits direct unrelated calls to the proven read-only metadata parser', () => {
  const source = fixture.replace('function getMetadata(runtime) { return runtime.turn; }', headerMetadata) + '\nfunction model(runtime) { return getMetadata(runtime)?.model; }';
  const result = deriveCua(source);
  assert.equal(result.support, 'supported', JSON.stringify(result.diagnostics));
});

test('rejects disconnected or changed reader bridges and additional capability escape', () => {
  for (const change of [
    readerFixture.replace('decodeReader(readerFactory, image, options)', 'decodeReader(otherFactory, image, options)'),
    readerFixture.replace('prepareReader(readerFactory, options)', 'prepareReader(otherFactory, options)'),
    readerFixture.replace('global: globalHandle', 'global: otherHandle'),
    readerFixture.replaceAll('bridge.toHandle', 'otherBridge.toHandle'),
    readerFixture.replaceAll('zxing_reader.wasm', 'other.wasm'),
    readerFixture + '\nunknown(globalThis[unknownKey]);',
    readerFixture.replace('const imports =', 'unknown(globalHandle); const imports ='),
    readerFixture.replace('let handles =', 'URL.prototype.toString = unknown; let handles ='),
  ]) {
    const result = deriveCua(fixture + change);
    assert.equal(result.support, 'unsupported', result.change?.before);
    assert.equal(result.change, null);
  }
  const renamedResult = deriveCua(fixture + renamed(readerFixture, 'reader'));
  assert.equal(renamedResult.support, 'supported', JSON.stringify(renamedResult.diagnostics));
});

test('refuses reader imports detached from resource instantiation', () => {
  const result = deriveCua(fixture + readerFixture.replace('new Uint8Array(), imports', 'new Uint8Array(), otherImports'));
  assert.equal(result.support, 'unsupported');
  assert.equal(result.change, null);
});

test('refuses configuration whose once initializer never runs', () => {
  const result = deriveCua(fixture.replace('initialize();', ''));
  assert.equal(result.support, 'unsupported');
  assert.equal(result.change, null);
  assert.match(result.diagnostics[0].code, /INITIALIZATION/);
});

test('allows unrelated browser capability inspection without treating it as chain mutation', () => {
  const source = 'const descriptor = Object.getOwnPropertyDescriptor(window.Element.prototype, "localName"); const browser = globalThis.document; browser.syntheticFlag = true;\n' + fixture;
  const result = deriveCua(source);
  assert.equal(result.support, 'supported', JSON.stringify(result.diagnostics));
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
