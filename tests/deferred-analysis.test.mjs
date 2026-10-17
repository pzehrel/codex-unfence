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
  assert.deepEqual(result.evidence.map(entry => entry.kind), ['initialization', 'predicate']);
  assert.match(result.evidence[0].description, /normal completion/i);
  assert.match(result.evidence[1].description, /strict.*true/i);
  assert.deepEqual(result.diagnostics.map(entry => entry.code), ['UNPROVEN_REQUEST_CHAIN', 'UNPROVEN_CACHE_POLICY', 'DEFERRED_TRANSFORM_DISABLED']);
  for (const entry of [...result.evidence, ...result.diagnostics]) {
    assert.equal(entry.range.unit, 'utf16');
    assert.ok(source.slice(entry.range.start, entry.range.end).length > 0);
  }
  assert.equal(transformSource(source).transformation, null);
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
  assert.deepEqual(result.evidence.map(entry => entry.kind), ['initialization', 'predicate']);
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
  assert.deepEqual(analyzeSource(text).evidence.map(entry => entry.kind), ['initialization', 'predicate']);
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
  assert.deepEqual(analyzeSource(text).evidence.map(entry => entry.kind), ['initialization', 'predicate']);
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
