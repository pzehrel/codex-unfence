import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { analyzeSource, transformSource } from '../dist/analysis.js';

const source = await readFile(new URL('./fixtures/deferred-site-status.js.txt', import.meta.url), 'utf8');

test('reports finite once initialization and strict agent stage evidence without claiming compatibility or a transform', () => {
  const result = analyzeSource(source);
  assert.equal(result.patternVersion, 'site-status-deferred-v1');
  assert.equal(result.compatibility, 'incompatible');
  assert.equal(result.runtime, 'not-verified');
  assert.equal(result.target, null);
  assert.deepEqual(result.evidence.map(entry => entry.kind), ['initialization', 'predicate', 'source', 'transport', 'response']);
  assert.match(result.evidence[0].description, /normal completion/i);
  assert.match(result.evidence[1].description, /strict.*true/i);
  assert.deepEqual(result.diagnostics.map(entry => entry.code), ['UNPROVEN_CACHE_POLICY', 'DEFERRED_TRANSFORM_DISABLED']);
  for (const entry of [...result.evidence, ...result.diagnostics]) {
    assert.equal(entry.range.unit, 'utf16');
    assert.ok(source.slice(entry.range.start, entry.range.end).length > 0);
  }
  assert.equal(transformSource(source).transformation, null);
});

test('proves URL input, request metadata, guarded receiver transport and same HTTP JSON binding while retaining later blockers', () => {
  const result = analyzeSource(source);
  assert.deepEqual(result.evidence.map(entry => entry.kind), ['initialization', 'predicate', 'source', 'transport', 'response']);
  assert.deepEqual(result.diagnostics.map(entry => entry.code), ['UNPROVEN_CACHE_POLICY', 'DEFERRED_TRANSFORM_DISABLED']);
  const [input, transport, response] = result.evidence.slice(2);
  assert.ok(source.slice(input.range.start, input.range.end).startsWith('function requestFor('));
  assert.match(input.description, /origin.*pathname.*search/);
  assert.match(input.description, /conversation_id.*turn_id/);
  assert.ok(source.slice(transport.range.start, transport.range.end).startsWith('async function transport('));
  assert.match(transport.description, /receiver.*GET/);
  assert.ok(source.slice(response.range.start, response.range.end).startsWith('async fetchBlocked('));
  assert.match(response.description, /same HTTP.*JSON.*binding/);
  assert.equal(result.compatibility, 'incompatible');
  assert.equal(result.target, null);
  assert.equal(transformSource(source).transformation, null);
});

test('rejects request-chain replacements, unknown control flow, escapes and capability mutation with concrete locations', () => {
  for (const [text, code] of [
    [source.replace('site_url\', copy.toString()', 'site_url\', "https://other.invalid/"'), 'DEFERRED_REQUEST_CONTEXT'],
    [source.replace('copy.search = url.search', 'copy.search = url.hash'), 'DEFERRED_REQUEST_SITE_URL'],
    [source.replace('new URL(url.origin);\n  copy.pathname', 'new URL(url.href);\n  copy.pathname'), 'DEFERRED_REQUEST_SITE_URL'],
    [source.replace('request.endpoint, { method:', 'other.endpoint, { method:'), 'DEFERRED_REQUEST_ENDPOINT'],
    [source.replace("method: 'GET'", "method: 'POST'"), 'DEFERRED_REQUEST_GET'],
    [source.replace('!response.ok', '!other.ok'), 'DEFERRED_HTTP_SUCCESS'],
    [source.replace('await response.json()', 'await other.json()'), 'DEFERRED_RESPONSE_BINDING'],
    [source.replace('agentBlocked(body);', 'agentBlocked(response);'), 'DEFERRED_RESPONSE_BINDING'],
    [source.replace('runtime.fetch(endpoint, options)', '(0, runtime.fetch)(endpoint, options)'), 'DEFERRED_TRANSPORT_RECEIVER'],
    [source.replace('metadata?.session_id', 'metadata?.turn_id'), 'DEFERRED_REQUEST_CONTEXT'],
    [source.replace('this.isBlocked(runtime, request)', 'this.isBlocked(runtime, other)'), 'DEFERRED_REQUEST_CONNECTION'],
    [source.replace('this.fetchBlocked(runtime, request)', 'this.fetchBlocked(runtime, other)'), 'DEFERRED_REQUEST_CONNECTION'],
    [source.replace('let result;\n    try', 'let result;\n    if (ready) return;\n    try'), 'DEFERRED_REQUEST_CONNECTION'],
    [source.replace('let result;\n    try', 'let result;\n    unknown(request.endpoint);\n    try'), 'DEFERRED_REQUEST_CONNECTION'],
    [source.replace("throw new Error('Missing fetch')", "throw new Error(unknown(runtime))"), 'DEFERRED_TRANSPORT_RECEIVER'],
    [source + '\nURL.prototype.toString = replacement;', 'DEFERRED_HOST_MUTATION'],
    [source + '\nconst alias = URL; alias.prototype.pathname = replacement;', 'DEFERRED_HOST_MUTATION'],
    [source + '\nReflect.set(URL.prototype, "search", replacement);', 'DEFERRED_HOST_MUTATION'],
    [source + '\nconst alias = String.prototype; unknown(alias);', 'DEFERRED_HOST_MUTATION'],
    [source + '\nunknown(endpointFor);', 'DEFERRED_ESCAPED_BINDING'],
    [source + '\nconst alias = requestFor; alias.changed = true;', 'DEFERRED_ESCAPED_BINDING'],
  ]) {
    const result = analyzeSource(text);
    assert.equal(result.target, null);
    assert.deepEqual(result.evidence, [], text.slice(-120));
    assert.equal(result.diagnostics[0].code, code, JSON.stringify(result));
    assert.equal(result.diagnostics[0].range.unit, 'utf16');
    assert.ok(text.slice(result.diagnostics[0].range.start, result.diagnostics[0].range.end).length > 0);
    assert.equal(transformSource(text).transformation, null);
  }
});

test('rejects conditional or delayed request startup before the unproven cache suffix', () => {
  for (const text of [
    source.replace('let pending = this.fetchBlocked(runtime, request), cached', 'if (ready) return; let pending = this.fetchBlocked(runtime, request), cached'),
    source.replace('let pending = this.fetchBlocked(runtime, request), cached', 'let pending = ready ? this.fetchBlocked(runtime, request) : other, cached'),
  ]) {
    const result = analyzeSource(text);
    assert.deepEqual(result.evidence, []);
    assert.equal(result.diagnostics[0].code, 'DEFERRED_REQUEST_CONNECTION');
  }
});

test('rejects reflective replacement through global host aliases and prototype inheritance', () => {
  for (const extra of [
    'globalThis[dynamicKey] = replacement;',
    'const root = globalThis; const {URL: alias} = root; alias.prototype.toString = replacement;',
    'const root = globalThis; const alias = root.URL; unknown(alias);',
    'const proto = Object.prototype; proto.searchParams = replacement;',
    'Reflect.set(Function.prototype, "call", replacement);',
    'const mutate = Object.assign; mutate(String.prototype, {trim: replacement});',
  ]) {
    const result = analyzeSource(source + '\n' + extra);
    assert.deepEqual(result.evidence, [], extra);
    assert.equal(result.diagnostics[0].code, 'DEFERRED_HOST_MUTATION', extra);
  }
});

test('rejects request member writes through destructuring, deletion and closure capture', () => {
  for (const extra of [
    '({key: request.cacheKey} = replacement);',
    '[request.endpoint] = replacement;',
    'delete request.endpoint;',
    'request.endpoint++;',
    'const alias = request; Reflect.set(alias, "endpoint", replacement);',
    'unknown(() => request);',
  ]) {
    const text = source.replace('let previous = this.inflightRequests', extra + '\n    let previous = this.inflightRequests');
    const result = analyzeSource(text);
    assert.deepEqual(result.evidence, [], extra);
    assert.match(result.diagnostics[0].code, /^DEFERRED_REQUEST_(ESCAPE|MUTATION)$/);
  }
});

test('rejects global-object escape and request coercion in an otherwise unproven cache suffix', () => {
  for (const [text, code] of [
    [source + '\nconst root = globalThis; unknown(root);', 'DEFERRED_HOST_MUTATION'],
    [source.replace('let previous = this.inflightRequests', 'unknown(`${request}`); let previous = this.inflightRequests'), 'DEFERRED_REQUEST_ESCAPE'],
  ]) {
    const result = analyzeSource(text);
    assert.deepEqual(result.evidence, []);
    assert.equal(result.diagnostics[0].code, code);
  }
});

test('retains request evidence after helper and local binding renames, compression, quoting and non-ASCII prefixes', () => {
  let text = source.replaceAll('https://chatgpt.com/backend-api', 'ENDPOINT_LITERAL');
  for (const [before, after] of Object.entries({ requestFor: 'r0', endpointFor: 'r1', localHost: 'r3', transport: 'r4', site: 'r5', url: 'r6', host: 'r7', copy: 'r8', response: 'r9', body: 'r10', runtime: 'r11', options: 'r12', pending: 'r13', backend: 'r14', fetchBlocked: 'r15', isBlocked: 'r16', checkUrl: 'r17' })) text = text.replace(new RegExp(`\\b${before}\\b`, 'g'), after);
  text = '﻿/* 中文 😀 */\r\n' + text.replaceAll('ENDPOINT_LITERAL', 'https://chatgpt.com/backend-api').replace(/^\/\/[^\n]*/gm, '').replaceAll("'", '"').replaceAll('.feature_status', '["feature_status"]').replaceAll('.fetch', '["fetch"]').replaceAll('.ok', '["ok"]').replaceAll('.json', '["json"]').replace(/\s+/g, ' ');
  const result = analyzeSource(text);
  assert.deepEqual(result.evidence.map(entry => entry.kind), ['initialization', 'predicate', 'source', 'transport', 'response'], JSON.stringify(result.diagnostics));
  assert.ok(text.slice(result.evidence[2].range.start, result.evidence[2].range.end).startsWith('function r0('));
  assert.ok(text.slice(result.evidence[3].range.start, result.evidence[3].range.end).startsWith('async function r4('));
  assert.ok(text.slice(result.evidence[4].range.start, result.evidence[4].range.end).startsWith('async r15('));
  assert.equal(transformSource(text).transformation, null);
});

test('rejects changed input filters, context defaults, helper binding writes and URL aliases', () => {
  for (const [text, code] of [
    [source.replace("url.protocol !== 'http:' && url.protocol !== 'https:'", "url.protocol !== 'http:' || url.protocol !== 'https:'"), 'DEFERRED_REQUEST_PROTOCOL'],
    [source.replace("host === '[::1]'", "host === '[::2]'"), 'DEFERRED_REQUEST_LOCALHOST'],
    [source.replace('host.slice(4)', 'host.slice(3)'), 'DEFERRED_REQUEST_CACHE_KEY'],
    [source.replace('urlRequestSource = requestSource', 'urlRequestSource = otherSource'), 'DEFERRED_REQUEST_CONFIGURATION'],
    [source.replace('conversationId != null &&', 'conversationId == null &&'), 'DEFERRED_REQUEST_CONTEXT'],
    [source.replace('conversationId: metadata?.session_id', 'conversationId: metadata?.other_id'), 'DEFERRED_REQUEST_CONTEXT'],
    [source.replace('urlRequestSource: backend == null ? requestSource', 'urlRequestSource: backend == null ? otherSource'), 'DEFERRED_REQUEST_CONFIGURATION'],
    [source.replace('return await runtime.fetch(endpoint, options)', 'return await runtime.fetch(options, endpoint)'), 'DEFERRED_TRANSPORT_RECEIVER'],
    [source.replace('let body = await response.json();', 'let body = await response.json(); body = other;'), 'DEFERRED_RESPONSE_BINDING'],
    [source.replace('let body = await response.json();', 'let body = await response.json(); unknown(body);'), 'DEFERRED_RESPONSE_BINDING'],
    [source.replace('copy.pathname = url.pathname,', 'const alias = copy; alias.hash = "replacement"; copy.pathname = url.pathname,'), 'DEFERRED_REQUEST_SITE_URL'],
    [source + '\ntransport = replacement;', 'DEFERRED_REASSIGNED_BINDING'],
    [source + '\nObject.defineProperty(endpointFor, "prototype", {});', 'DEFERRED_ESCAPED_BINDING'],
    [source + '\nconst alias = localHost; Reflect.set(alias, "call", replacement);', 'DEFERRED_ESCAPED_BINDING'],
    [source + '\nconst proto = Object.getPrototypeOf(URL.prototype); proto.toString = replacement;', 'DEFERRED_HOST_MUTATION'],
  ]) {
    const result = analyzeSource(text);
    assert.deepEqual(result.evidence, [], text.slice(-120));
    assert.equal(result.diagnostics[0].code, code, JSON.stringify(result));
  }
});

test('rejects class and instance edits to the request methods already claimed as stage evidence', () => {
  for (const extra of [
    'SitePolicy.prototype.fetchBlocked = replacement;',
    'policy.fetchBlocked = replacement;',
    'const alias = policy; Reflect.set(alias, "checkUrl", replacement);',
    'Object.setPrototypeOf(policy, other);',
    'unknown(SitePolicy);',
  ]) {
    const result = analyzeSource(source + '\n' + extra);
    assert.deepEqual(result.evidence, [], extra);
    assert.equal(result.diagnostics[0].code, 'DEFERRED_REQUEST_RECEIVER', extra);
  }
});

test('rejects this aliases and computed instance effects that could change request methods', () => {
  for (const [before, after] of [
    ['let previous = this.inflightRequests', 'unknown(this); let previous = this.inflightRequests'],
    ['let previous = this.inflightRequests', 'this.fetchBlocked = replacement; let previous = this.inflightRequests'],
    ['let previous = this.inflightRequests', 'this[dynamicKey] = replacement; let previous = this.inflightRequests'],
    ['let previous = this.inflightRequests', 'Reflect.set(this, "fetchBlocked", replacement); let previous = this.inflightRequests'],
    ['now;\n  getTurnMetadata;', 'now;\n  [unknown()] = replacement;\n  getTurnMetadata;'],
    ['SitePolicy = class {', 'SitePolicy = class extends Other {'],
  ]) {
    const result = analyzeSource(source.replace(before, after));
    assert.deepEqual(result.evidence, [], after);
    assert.equal(result.diagnostics[0].code, 'DEFERRED_REQUEST_RECEIVER');
  }
});

test('permits finite unrelated global property choices while rejecting a branch that can replace URL', () => {
  const safe = source + '\nconst root = globalThis; root[ready ? "unrelatedOne" : "unrelatedTwo"] ??= {};';
  assert.deepEqual(analyzeSource(safe).evidence.map(entry => entry.kind), ['initialization', 'predicate', 'source', 'transport', 'response']);
  const unsafe = safe.replace('"unrelatedTwo"', '"URL"');
  assert.equal(analyzeSource(unsafe).diagnostics[0].code, 'DEFERRED_HOST_MUTATION');
});

test('rejects replacement or escape of the metadata accessor used by request construction', () => {
  for (const extra of ['this.getTurnMetadata = replacement;', 'unknown(this.getTurnMetadata);']) {
    const text = source.replace('let previous = this.inflightRequests', extra + ' let previous = this.inflightRequests');
    const result = analyzeSource(text);
    assert.deepEqual(result.evidence, []);
    assert.equal(result.diagnostics[0].code, 'DEFERRED_REQUEST_RECEIVER');
  }
});

test('rejects duplicate or field-shadowed request methods', () => {
  for (const extra of ['fetchBlocked() { return false; }', 'fetchBlocked = replacement;']) {
    const text = source.replace('  now;\n  getTurnMetadata;', `  ${extra}\n  now;\n  getTurnMetadata;`);
    const result = analyzeSource(text);
    assert.deepEqual(result.evidence, []);
    assert.equal(result.diagnostics[0].code, 'DEFERRED_REQUEST_RECEIVER');
  }
});

test('permits standard string conversion in unrelated computed property writes', () => {
  const text = source + '\nfunction unrelatedCopy(input) { const output = {}; output[String(input)] = 1; return output; }';
  assert.deepEqual(analyzeSource(text).evidence.map(entry => entry.kind), ['initialization', 'predicate', 'source', 'transport', 'response']);
});

test('rejects a caught failed initialization attempt before the normal initialization path', () => {
  const text = source.replace('initialize();\nasync function transport', 'try { initialize(); } catch {}\ninitialize();\nasync function transport');
  const result = analyzeSource(text);
  assert.equal(result.compatibility, 'incompatible');
  assert.deepEqual(result.evidence, []);
  assert.equal(result.diagnostics[0].code, 'DEFERRED_INITIALIZATION_ORDER');
});

test('rejects a once helper factory defined after the initialization call', () => {
  const helper = 'var once = (task, value) => () => (task && (value = task(task = 0)), value);';
  const text = source.replace(helper, '').replace('initialize();\nasync function transport', `initialize();\n${helper}\nasync function transport`);
  const result = analyzeSource(text);
  assert.deepEqual(result.evidence, []);
  assert.equal(result.diagnostics[0].code, 'DEFERRED_INITIALIZATION_ORDER');
});

test('rejects predicate mutation through an input alias before the strict comparison', () => {
  const text = source.replace('let flags = body.feature_status;', 'let flags = body.feature_status; flags[key] = false;');
  const result = analyzeSource(text);
  assert.deepEqual(result.evidence, []);
  assert.equal(result.diagnostics[0].code, 'DEFERRED_AGENT_SEMANTICS');
});

test('rejects early predicate calls outside the initialized class boundary', () => {
  const text = source.replace('initialize();\nasync function transport', 'agentBlocked({});\ninitialize();\nasync function transport');
  const result = analyzeSource(text);
  assert.deepEqual(result.evidence, []);
  assert.equal(result.diagnostics[0].code, 'DEFERRED_ESCAPED_BINDING');
});

test('rejects reflective writes and external escapes of tracked predicates and initialization functions', () => {
  for (const extra of [
    'agentBlocked.prototype.changed = true;',
    'const alias = agentBlocked; alias.changed = true;',
    'const change = Reflect.set; change(agentBlocked, "call", replacement);',
    'const { defineProperty: change } = Object; change(enabled, "name", {});',
    'Object.setPrototypeOf(isRecord, other);',
    'unknown(once);', 'unknown(initSiteStatus);', 'unknown(agentBlocked);',
    'export { enabled };', 'agentBlocked = replacement;',
  ]) {
    const result = analyzeSource(source + '\n' + extra);
    assert.equal(result.target, null, extra);
    assert.deepEqual(result.evidence, [], extra);
    assert.match(result.diagnostics[0].code, /^DEFERRED_(ESCAPED|REASSIGNED)_BINDING$/, extra);
  }
});

test('rejects unproven initializer RHS effects that can reenter or swallow initialization failure', () => {
  for (const rhs of [
    'unknown(initSiteStatus)',
    '(() => { try { initSiteStatus(); } catch {} })()',
    '(() => { agentKey = "comment"; return {}; })()',
    'new (class { static { initSiteStatus(); } })()',
  ]) {
    const text = source.replace("metadata = { name: 'synthetic' }", `metadata = ${rhs}`);
    const result = analyzeSource(text);
    assert.deepEqual(result.evidence, [], rhs);
    assert.match(result.diagnostics[0].code, /^DEFERRED_(INITIALIZER_EFFECT|REASSIGNED_BINDING)$/, rhs);
  }
});

test('rejects initialization invoked early through a hoisted function whose body occurs later', () => {
  const text = source.replace('initialize();\nasync function transport', 'try { early(); } catch {}\ninitialize();\nfunction early() { initSiteStatus(); }\nasync function transport');
  const result = analyzeSource(text);
  assert.deepEqual(result.evidence, []);
  assert.equal(result.diagnostics[0].code, 'DEFERRED_INITIALIZATION_ORDER');
});

test('rejects mutation and escape of initialized data read by another initialization dependency', () => {
  for (const extra of ['const alias = metadata; unknown(alias);', 'metadata.name = replacement;', 'Reflect.set(metadata, "name", replacement);']) {
    const text = source.replace("['http:', 'https:']", '[metadata.name]') + '\n' + extra;
    const result = analyzeSource(text);
    assert.deepEqual(result.evidence, [], extra);
    assert.equal(result.diagnostics[0].code, 'DEFERRED_ESCAPED_BINDING', extra);
  }
});

test('keeps stage recognition under renaming, compressed formatting, static reads and UTF-16 prefixes', () => {
  let text = source;
  for (const [before, after] of Object.entries({ once: 'z0', task: 'z1', value: 'z2', initSiteStatus: 'z3', initialize: 'z4', initMetadata: 'z5', initProtocols: 'z6', initErrors: 'z7', agentKey: 'z8', agentBlocked: 'z9', enabled: 'z10', isRecord: 'z11', body: 'z12', flags: 'z13', key: 'z14', SitePolicy: 'z15', baseUrl: 'z16' })) text = text.replace(new RegExp(`\\b${before}\\b`, 'g'), after);
  text = '﻿/* 中文 😀 */\r\n' + text.replace(/^\/\/[^\n]*/gm, '').replaceAll("'", '"').replaceAll('.feature_status', '["feature_status"]').replaceAll('true', '!0').replaceAll('false', '!1').replace(/\s+/g, ' ');
  const result = analyzeSource(text);
  assert.deepEqual(result.evidence.map(entry => entry.kind), ['initialization', 'predicate', 'source', 'transport', 'response']);
  assert.equal(text.slice(result.evidence[0].range.start, result.evidence[0].range.end), 'z4()');
  assert.ok(text.slice(result.evidence[1].range.start, result.evidence[1].range.end).startsWith('function z9('));
  assert.equal(transformSource(text).transformation, null);
});

const negativeCases = [
  ['missing module activation', source.replace('initialize();\nasync function transport', '\nasync function transport'), 'DEFERRED_MISSING_INITIALIZATION'],
  ['conditional module activation', source.replace('initialize();\nasync function transport', 'if (ready) initialize();\nasync function transport'), 'DEFERRED_MISSING_INITIALIZATION'],
  ['class evaluated before activation', source.replace('initialize();\nasync function transport', '\nasync function transport') + '\ninitialize();', 'DEFERRED_INITIALIZATION_ORDER'],
  ['conditional dependency', source.replace('initMetadata();\n  initProtocols();', 'initMetadata();\n  if (ready) initProtocols();'), 'DEFERRED_CONDITIONAL_INITIALIZATION'],
  ['conditional key assignment', source.replace("agentKey = 'agent'", "agentKey = ready ? 'agent' : 'comment'"), 'DEFERRED_AGENT_KEY'],
  ['key reassignment', source + '\nagentKey = "agent";', 'DEFERRED_REASSIGNED_BINDING'],
  ['wrapper shadowing', source.replace('function agentBlocked(body) { return enabled(body, agentKey); }', 'function agentBlocked(agentKey) { return enabled(agentKey, agentKey); }'), 'DEFERRED_MISSING_INITIALIZATION'],
  ['negated wrapper', source.replace('return enabled(body, agentKey);', 'return !enabled(body, agentKey);'), 'DEFERRED_AGENT_SEMANTICS'],
  ['shadowed dependency', source.replace('initMetadata();\n  initProtocols();', 'initMetadata();\n  { let initProtocols = unknown; initProtocols(); }'), 'DEFERRED_CONDITIONAL_INITIALIZATION'],
  ['truthy agent', source.replace('flags[key] === true', 'flags[key]'), 'DEFERRED_AGENT_SEMANTICS'],
  ['loose true', source.replace('flags[key] === true', 'flags[key] == true'), 'DEFERRED_AGENT_SEMANTICS'],
  ['false agent', source.replace('flags[key] === true', 'flags[key] === false'), 'DEFERRED_AGENT_SEMANTICS'],
  ['other feature', source.replace("agentKey = 'agent'", "agentKey = 'comment'"), 'DEFERRED_AGENT_KEY'],
  ['wrong guard', source.replace("typeof value == 'object'", "typeof value == 'function'"), 'DEFERRED_AGENT_SEMANTICS'],
  ['null guard', source.replace('value != null', 'value === null'), 'DEFERRED_AGENT_SEMANTICS'],
  ['once callback not cleared', source.replace('task(task = 0)', 'task()'), 'DEFERRED_ONCE_HELPER'],
  ['once callback cleared too late', source.replace('value = task(task = 0)', 'value = task(), task = 0'), 'DEFERRED_ONCE_HELPER'],
  ['async initialization', source.replace('initSiteStatus = once(() =>', 'initSiteStatus = once(async () =>'), 'DEFERRED_INITIALIZER_SHAPE'],
  ['recursive initialization', source.replace('  initProtocols();\n  baseUrl', '  initProtocols();\n  initSiteStatus();\n  baseUrl'), 'DEFERRED_INITIALIZATION_CYCLE'],
];
for (const [name, text, code] of negativeCases) test(`diagnoses ${name} without stage evidence or transformation`, () => {
  const result = analyzeSource(text);
  assert.equal(result.target, null);
  assert.deepEqual(result.evidence, []);
  assert.equal(result.diagnostics[0].code, code, JSON.stringify(result));
  assert.equal(transformSource(text).transformation, null);
});

test('rejects a caught partial initialization of a required dependency before the root call', () => {
  const text = source.replace('initialize();\nasync function transport', 'try { initProtocols(); } catch {}\ninitialize();\nasync function transport');
  const result = analyzeSource(text);
  assert.deepEqual(result.evidence, []);
  assert.equal(result.diagnostics[0].code, 'DEFERRED_INITIALIZATION_ORDER');
});

test('accepts a dependency initialized by an earlier unconditional normally completed module call', () => {
  const text = source.replace('initialize();\nasync function transport', 'initMetadata();\ninitialize();\nasync function transport');
  assert.deepEqual(analyzeSource(text).evidence.map(entry => entry.kind), ['initialization', 'predicate', 'source', 'transport', 'response']);
});

test('rejects a deferred closure that later overwrites initialization data consumed by a dependency', () => {
  const text = source.replace("metadata = { name: 'synthetic' }", "metadata = { name: 'synthetic' }, globalCallback = () => { metadata = {}; }")
    .replace("['http:', 'https:']", '[metadata.name]');
  const result = analyzeSource(text);
  assert.deepEqual(result.evidence, []);
  assert.equal(result.diagnostics[0].code, 'DEFERRED_REASSIGNED_BINDING');
});

test('rejects a dependency read that is textually available but not initialized before its use', () => {
  const text = source.replace('var initialize = once(() => { initMetadata(); initProtocols(); initErrors(); initSiteStatus(); });', 'var earlyValue, initialize = once(() => { earlyValue = agentKey; initMetadata(); initProtocols(); initErrors(); initSiteStatus(); });');
  const result = analyzeSource(text);
  assert.deepEqual(result.evidence, []);
  assert.equal(result.diagnostics[0].code, 'DEFERRED_INITIALIZATION_ORDER');
});

test('rejects a second write to configuration data used by initializer dependencies', () => {
  const text = source.replace("['http:', 'https:']", '[metadata.name]') + '\nmetadata = {name:"replacement"};';
  const result = analyzeSource(text);
  assert.deepEqual(result.evidence, []);
  assert.equal(result.diagnostics[0].code, 'DEFERRED_REASSIGNED_BINDING');
});

test('rejects file-visible mutation of standard capabilities used during initialization', () => {
  for (const extra of [
    'Object.freeze = task => task();',
    'const alias = Object; alias.freeze = replacement;',
    'const change = Reflect.set; change(Object, "freeze", replacement);',
    'const {defineProperty: change} = Object; change(Object, "freeze", {});',
    'Set.prototype.add = replacement;',
    'globalThis.Object = replacement;',
    'let alias; alias = Object; alias.freeze = replacement;',
    'const {prototype: alias} = Set; alias.add = replacement;',
    'const alias = globalThis; alias.Object = replacement;',
    'globalThis["Obj" + "ect"] = replacement;',
  ]) {
    const result = analyzeSource(source + '\n' + extra);
    assert.deepEqual(result.evidence, [], extra);
    assert.equal(result.diagnostics[0].code, 'DEFERRED_HOST_MUTATION', extra);
  }
});

test('allows unrelated once initializers with independent external effects', () => {
  const text = source.replace('initialize();\nasync function transport', 'var initUnrelated = once(() => { unknown("unrelated"); });\ninitUnrelated();\ninitialize();\nasync function transport');
  assert.deepEqual(analyzeSource(text).evidence.map(entry => entry.kind), ['initialization', 'predicate', 'source', 'transport', 'response']);
});

test('rejects object coercion during initialization arithmetic', () => {
  const text = source.replace("metadata = { name: 'synthetic' }", "metadata = { valueOf: () => { initSiteStatus(); } }")
    .replace("protocols = Object.freeze(['http:', 'https:'])", 'protocols = metadata * 2');
  const result = analyzeSource(text);
  assert.deepEqual(result.evidence, []);
  assert.equal(result.diagnostics[0].code, 'DEFERRED_INITIALIZER_EFFECT');
});

test('rejects a relevant configuration read inside its initialization before the unique assignment', () => {
  const text = source.replace('  initProtocols();\n  baseUrl', '  initProtocols();\n  agentBlocked({});\n  baseUrl');
  const result = analyzeSource(text);
  assert.deepEqual(result.evidence, []);
  assert.equal(result.diagnostics[0].code, 'DEFERRED_CONDITIONAL_INITIALIZATION');
});
