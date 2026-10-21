function required<T>(value: T): NonNullable<T> { assert.ok(value !== null && value !== undefined, 'Expected test value to be present'); return value; }
import { sourceFixture } from './helpers/paths.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(sourceFixture('site-status.js.txt'), 'utf8');
const { analyzeSource } = await import('../src/analysis.js');

function rejects(text: string, code: string) {
  const result = analyzeSource(text);
  assert.equal(result.compatibility, 'incompatible', JSON.stringify(result));
  assert.equal(result.target, null);
  assert.equal(required(result.diagnostics[0]).code, code, JSON.stringify(result));
}

test('rejects reflective aliases and indirect mutation capabilities without executing source', () => {
  for (const extra of [
    "const change = Reflect.set; change(URL.prototype, 'toString', function () { return 'https://other.invalid'; });",
    "const change = Object.defineProperty; change(Policy.prototype, 'load', { value: async function () { return false; } });",
    "const { set: change } = Reflect; change(URL.prototype, 'toString', replacement);",
    "const reflection = Reflect; const change = reflection['set']; change(URL.prototype, 'toString', replacement);",
    "const name = 's' + 'et'; Reflect[name](URL.prototype, 'toString', replacement);",
    "unknown(URL);",
    "import './unproven-effects.mjs';",
    "import('./unproven-effects.mjs');",
    "Function('return globalThis')();",
  ]) {
    const text = source + '\n' + extra;
    const result = analyzeSource(text);
    assert.equal(result.compatibility, 'incompatible', extra);
    assert.equal(result.target, null, extra);
  }
});

test('rejects inherited, borrowed and escaped receivers instead of assuming this dispatch', () => {
  for (const extra of [
    "class ActualPolicy extends Policy { async query(runtime, request) { return { blocked: true }; } }",
    "Policy.prototype.check.call({ query: async function () { return { blocked: true }; } }, runtime, site);",
    "const policy = new Policy(); const borrowed = policy.check; borrowed.call(other, runtime, site);",
    "const policy = new Policy(); unknown(policy);",
    "const Alias = Policy;",
  ]) {
    const result = analyzeSource(source + '\n' + extra);
    assert.equal(result.compatibility, 'incompatible', extra);
    assert.equal(result.target, null, extra);
  }
});

test('accepts closed direct and constant-instance calls with static method names after renaming', () => {
  const text = source + "\nasync function direct(runtime, site) { await new Policy()['check'](runtime, site); }\nasync function bound(runtime, site) { const policy = new Policy(); await policy.check(runtime, site); }";
  assert.equal(analyzeSource(text).compatibility, 'compatible');
  assert.equal(analyzeSource(text.replaceAll('Policy', 'R7').replaceAll('check', 'c4')).compatibility, 'compatible');
});

test('rejects a second plausible consumption chain that cannot be proven even alongside a complete chain', () => {
  const extra = source.slice(source.indexOf('class Policy')).replace('class Policy', 'class OtherPolicy').replace('return agentBlocked(body);', 'return agentBlocked({});');
  rejects(source + extra, 'UNPROVEN_CANDIDATE');
});

test('rejects an unsupported extra-statement candidate alongside a proven chain', () => {
  const extra = source.slice(source.indexOf('class Policy')).replace('class Policy', 'class OtherPolicy').replace('const request = requestFor(site);', 'const request = requestFor(site); audit();');
  rejects(source + extra, 'UNPROVEN_CANDIDATE');
});

test('accepts renaming, static computed reads, quote changes, comments and compressed whitespace', () => {
  let renamed = source;
  for (const [before, after] of Object.entries({ feature: 'k7', record: 'g9', enabled: 'p3', agentBlocked: 'q8', requestFor: 'b6', transport: 't5', Policy: 'R4', load: 'l2', query: 'u1', check: 'c0', runtime: 'r', request: 'n', response: 'h', body: 'j', flags: 'f', key: 'x', value: 'v', address: 'a', site: 's', result: 'z', options: 'o' })) {
    renamed = renamed.replace(new RegExp(`\\b${before}\\b`, 'g'), after);
  }
  renamed = renamed.replaceAll("'", '"').replaceAll('.feature_status', '["feature_status"]').replaceAll('.endpoint', '["endpoint"]').replaceAll('.blocked', '["blocked"]').replace(/^\/\/[^\n]*/gm, '').replace(/\s+/g, ' ').replaceAll('true', '!0').replaceAll('false', '!1');
  const result = analyzeSource('/* renamed synthetic chain */ ' + renamed);
  assert.equal(result.compatibility, 'compatible', JSON.stringify(result));
  assert.equal(('/* renamed synthetic chain */ ' + renamed).slice(required(result.target).start, required(result.target).end), 'j');
});

const rejectionCases = [
  ['agent constant shadowed by response parameter', source.replace('function agentBlocked(body) {\n  return enabled(body, feature);', 'function agentBlocked(feature) {\n  return enabled(feature, feature);'), 'UNSUPPORTED_INITIALIZATION'],
  ['URL global shadowed by module binding', "const URL = globalThis.fakeURL;\n" + source, 'UNPROVEN_SOURCE'],
  ['callee shadowed by a block-local function', source.replace('return agentBlocked(body);', '{ function agentBlocked(value) { return false; } return agentBlocked(body); }'), 'UNSUPPORTED_CHAIN'],
  ['response shadowed by a block binding', source.replace('return agentBlocked(body);', '{ const body = {}; return agentBlocked(body); }'), 'UNSUPPORTED_CHAIN'],
  ['agent key changed', source.replace("const feature = 'agent';", "const feature = 'comment';"), 'CHANGED_SEMANTICS'],
  ['truthy comparison', source.replace('flags[key] === true', 'flags[key]'), 'CHANGED_SEMANTICS'],
  ['false comparison', source.replace('flags[key] === true', 'flags[key] === false'), 'CHANGED_SEMANTICS'],
  ['negated agent result', source.replace('return enabled(body, feature);', 'return !enabled(body, feature);'), 'UNSUPPORTED_CHAIN'],
  ['changed object guard', source.replace('value != null', 'value === null'), 'CHANGED_SEMANTICS'],
  ['changed GET endpoint with correct endpoint in dead function', source.replace('backend-api/aura/site_status', 'backend-api/other') + '\nfunction unused() { return "https://chatgpt.com/backend-api/aura/site_status"; }', 'UNPROVEN_SOURCE'],
  ['changed site_url source', source.replace("'site_url', site", "'site_url', 'https://other.invalid'"), 'UNPROVEN_SOURCE'],
  ['different request binding', source.replace('transport(runtime, request.endpoint', 'transport(runtime, unrelated.endpoint'), 'UNSUPPORTED_BINDING'],
  ['POST transport', source.replace("method: 'GET'", "method: 'POST'"), 'UNPROVEN_SOURCE'],
  ['transport swaps endpoint', source.replace('runtime.fetch(endpoint, options)', "runtime.fetch('https://other.invalid', options)"), 'UNPROVEN_SOURCE'],
  ['different JSON response', source.replace('await response.json()', 'await runtime.json()'), 'UNPROVEN_RESPONSE'],
  ['different predicate response', source.replace('return agentBlocked(body);', 'return agentBlocked(unrelated);'), 'UNSUPPORTED_BINDING'],
  ['inline predicate', source.replace('return agentBlocked(body);', 'return enabled(body, feature);'), 'UNSUPPORTED_CHAIN'],
  ['split response alias', source.replace('return agentBlocked(body);', 'const other = body; return agentBlocked(other);'), 'UNSUPPORTED_CHAIN'],
  ['extra return path', source.replace('const body = await response.json();', 'if (runtime.shortcut) return false; const body = await response.json();'), 'UNSUPPORTED_CHAIN'],
  ['response reassigned', source.replace('const body = await response.json();', 'let body = await response.json(); body = {};'), 'UNSUPPORTED_CHAIN'],
  ['request reassigned', source.replace('const request = requestFor(site);', 'let request = requestFor(site); request = {};'), 'UNSUPPORTED_CHAIN'],
  ['method reassigned', source + '\nPolicy.prototype.load = async () => false;', 'UNSUPPORTED_MUTATION'],
  ['method duplicated', source.replace('async query(runtime, request)', 'async load(runtime, request) {}\n  async query(runtime, request)'), 'UNSUPPORTED_BINDING'],
  ['reflective mutation', source + '\nObject.defineProperty(Policy.prototype, "load", {});', 'UNSUPPORTED_MUTATION'],
  ['eval', source + '\neval("change bindings");', 'UNSUPPORTED_SCOPE'],
  ['invalid syntax', 'function {', 'PARSE_ERROR'],
  ['no target', 'const agent = true;', 'NO_TARGET'],
  ['unrelated similar predicate without consumption', source.slice(0, source.indexOf('class Policy')), 'NO_TARGET'],
  ['sidebar text parsing shape', "async function sidebar(runtime, url) { const response = await runtime.fetch('/aura/site_status'); const value = JSON.parse(await response.text()); return value.feature_status.agent === true; }", 'NO_TARGET'],
] as const;
for (const [name, text, code] of rejectionCases) {
  test(`rejects ${name}`, () => rejects(text, code));
}

test('ignores unrelated similar predicates while retaining a single complete chain', () => {
  const result = analyzeSource(source + '\nfunction unrelated(body) { return body.feature_status.agent === true; }');
  assert.equal(result.compatibility, 'compatible');
});

test('rejects two complete candidates even when their generic predicate is shared', () => {
  rejects(source + source.slice(source.indexOf('class Policy')).replace('class Policy', 'class OtherPolicy'), 'AMBIGUOUS_TARGET');
});

test('diagnoses response-copy patched shape without claiming trusted tool application', () => {
  const patched = source.replace('agentBlocked(body);', 'agentBlocked({...body,feature_status:{...body?.feature_status,agent:false}});');
  rejects(patched, 'UNTRUSTED_PATCHED_SHAPE');
  assert.equal(analyzeSource(patched).evidence.length, 5);
});

test('returns UTF-16 target ranges for BOM, CRLF, non-BMP and Chinese source prefixes', () => {
  const text = '﻿/* 中文 😀 */\r\n' + source.replaceAll('\n', '\r\n');
  const result = analyzeSource(text);
  assert.equal(result.compatibility, 'compatible');
  assert.equal(text.slice(required(result.target).start, required(result.target).end), 'body');
  assert.equal(required(result.target).start, text.indexOf('body);\r\n  }\r\n  async query'));
});

test('rejects a later duplicate blocking method that overrides the proven method', () => {
  rejects(source.replace('class Policy {', 'class Policy {\n  async check(runtime, site) {}'), 'UNSUPPORTED_BINDING');
});

test('rejects reassigned class bindings', () => {
  rejects(source + '\nPolicy = class {};\n', 'REASSIGNED_BINDING');
});

test('rejects a nested consumption candidate alongside a proven module-level chain', () => {
  const extra = source.slice(source.indexOf('class Policy')).replace('class Policy', 'class NestedPolicy');
  rejects(source + '\nfunction nested() { ' + extra + ' }', 'UNPROVEN_CANDIDATE');
});

test('rejects patched lookalikes whose computed spread key changes the copied feature object', () => {
  const patched = source.replace('agentBlocked(body);', 'agentBlocked({...body,feature_status:{...body?.[feature_status],agent:false}});');
  rejects(patched, 'UNPROVEN_RESPONSE');
});

test('rejects property writes hidden inside destructuring assignments', () => {
  rejects(source + '\n({replacement: Policy.prototype.load} = unknown);', 'UNSUPPORTED_MUTATION');
});

test('rejects packed deferred initialization rather than treating one assignment as a constant', () => {
  const deferred = "var feature; var once=(task,value)=>()=>(task&&(value=task(task=0)),value); var initialize=once(()=>{feature='agent';}); initialize();";
  rejects(source.replace("const feature = 'agent';", deferred), 'UNSUPPORTED_INITIALIZATION');
});

test('rejects conditional initialization and non-const agent bindings', () => {
  rejects(source.replace("const feature = 'agent';", "var feature; if (globalThis.ready) feature = 'agent';"), 'UNSUPPORTED_INITIALIZATION');
  rejects(source.replace("const feature = 'agent';", "let feature = 'agent'; feature = 'comment';"), 'UNSUPPORTED_INITIALIZATION');
});

test('rejects reassignment to the predicate binding after its declaration', () => {
  rejects(source + '\nagentBlocked = () => false;\n', 'REASSIGNED_BINDING');
});

test('rejects reassignment of the global URL constructor', () => {
  rejects(source + '\nURL = class {};\n', 'REASSIGNED_BINDING');
});

test('rejects escaped predicate aliases whose binding can be changed by unknown code', () => {
  rejects(source + '\nconst alias = agentBlocked; unknown(alias);\n', 'ESCAPED_BINDING');
});

test('rejects property writes through request aliases before the source chain is consumed', () => {
  rejects(source + '\nfunction alter(request) { request.endpoint = "https://elsewhere.invalid"; }\n', 'UNSUPPORTED_MUTATION');
});

test('proves one complete site-status source, response, agent predicate and blocking consumption chain without execution', async () => {
  const result = analyzeSource(source);
  assert.equal(result.compatibility, 'compatible', JSON.stringify(result));
  assert.equal(result.patternVersion, 'site-status-v1');
  assert.equal(result.runtime, 'not-verified');
  assert.deepEqual(result.diagnostics, []);
  assert.equal(source.slice(required(result.target).start, required(result.target).end), 'body');
  assert.deepEqual(result.evidence.map((entry) => entry.kind), ['source', 'transport', 'response', 'predicate', 'consumption']);
  for (const entry of result.evidence) {
    assert.equal(entry.range.unit, 'utf16');
    assert.ok(source.slice(entry.range.start, entry.range.end).length > 0);
  }
});
