import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { setImmediate } from 'node:timers';
import { analyzeSource, transformSource } from '../dist/analysis.js';

const source = await readFile(new URL('./fixtures/deferred-site-status.js.txt', import.meta.url), 'utf8');

test('complete finite deferred proof enables only the JSON response argument transform', () => {
  const { analysis, transformation } = transformSource(source);
  assert.equal(analysis.patternVersion, 'site-status-deferred-v1');
  assert.equal(analysis.compatibility, 'compatible');
  assert.equal(analysis.runtime, 'not-verified');
  assert.deepEqual(analysis.diagnostics, []);
  assert.deepEqual(analysis.evidence.map(entry => entry.kind), ['initialization', 'predicate', 'source', 'transport', 'response', 'receiver', 'cache', 'consumption']);
  assert.ok(transformation);
  assert.deepEqual(analysis.target, transformation.range);
  assert.equal(transformation.before, 'body');
  assert.equal(transformation.after, '({...body,feature_status:{...body?.feature_status,agent:false}})');
  assert.equal(transformation.patchedSource, source.replace('return agentBlocked(body);', 'return agentBlocked(({...body,feature_status:{...body?.feature_status,agent:false}}));'));
});

// Execute only this independently authored fixture. The exposed callable boundary
// and host clock/fetch adapters do not expose analyzer internals or AST state.
function fixtureRuntime(text = source) {
  let time = 1000;
  const requests = [];
  const context = { URL, basename: value => value, Date: { now: () => time } };
  runInNewContext(text.replace("import { basename } from 'node:path';", '') + '\n globalThis.fixture = {checkSite, enforce};', context);
  const runtime = {
    turn: { session_id: 'conversation', turn_id: 'turn' },
    fetch(endpoint, options) {
      assert.equal(this, runtime);
      let resolve, reject;
      const response = new Promise((yes, no) => { resolve = yes; reject = no; });
      requests.push({ endpoint, method: options.method, resolve: blocked => resolve({ ok: true, json: async () => ({feature_status: {agent: blocked}}) }), resolveBody: body => resolve({ok: true, json: async () => body}), failHttp: () => resolve({ok: false}), failJson: () => resolve({ok: true, json: async () => { throw new Error('json'); }}), reject });
      return response;
    },
  };
  return { requests, runtime, setTime: value => { time = value; }, check: site => context.fixture.checkSite(runtime, site, 'test'), enforce: site => context.fixture.enforce(runtime, site, 'test') };
}

const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

test('refuses deferred selection beside a complete or unknown legacy blocking candidate', async () => {
  let legacy = await readFile(new URL('./fixtures/site-status.js.txt', import.meta.url), 'utf8');
  for (const name of ['feature', 'record', 'enabled', 'agentBlocked', 'requestFor', 'transport', 'Policy']) legacy = legacy.replace(new RegExp(`\\b${name}\\b`, 'g'), `legacy_${name}`);
  for (const extra of [legacy, 'class UnknownPolicy { check(result) { if (result.blocked) throw new Error("blocked"); } }']) {
    const result = transformSource(source + '\n' + extra);
    assert.equal(result.analysis.compatibility, 'incompatible');
    assert.equal(result.analysis.target, null);
    assert.equal(result.transformation, null);
    assert.equal(result.analysis.diagnostics[0].code, 'AMBIGUOUS_PATTERN');
  }
});

test('deferred transform preserves UTF-8 bytes outside its UTF-16 range with BOM, CRLF and Unicode identifiers', () => {
  const text = '﻿/* 中文 😀 */\r\n' + source.replace(/\bbody\b/g, '响应𐐀').replaceAll('\n', '\r\n');
  const {analysis, transformation: change} = transformSource(text);
  assert.equal(analysis.compatibility, 'compatible');
  assert.equal(change.before, '响应𐐀');
  assert.equal(change.after, '({...响应𐐀,feature_status:{...响应𐐀?.feature_status,agent:false}})');
  assert.equal(change.range.end - change.range.start, 4);
  const prefix = Buffer.from(text.slice(0, change.range.start)), suffix = Buffer.from(text.slice(change.range.end)), patched = Buffer.from(change.patchedSource);
  assert.deepEqual(patched.subarray(0, prefix.length), prefix);
  assert.deepEqual(patched.subarray(patched.length - suffix.length), suffix);
  assert.deepEqual(patched.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
  assert.equal(patched.length, Buffer.byteLength(text) - Buffer.byteLength(change.before) + Buffer.byteLength(change.after));
  for (const evidence of analysis.evidence) assert.ok(text.slice(evidence.range.start, evidence.range.end).length);
});

test('deferred response copy changes only the local agent input and preserves original fields and policy sentinel', async () => {
  const patched = transformSource(source).transformation.patchedSource;
  // Exercise the generated expression directly as well as the whole fixture.
  const context = {};
  runInNewContext(`globalThis.copy = body => ${transformSource(source).transformation.after}`, context);
  const other = {retained: true};
  for (const agent of [true, false, 1, 'true', null, undefined]) {
    const flags = Object.freeze({agent, comment: true, other}), body = Object.freeze({feature_status: flags, metadata: other});
    const copy = context.copy(body);
    assert.notEqual(copy, body);
    assert.notEqual(copy.feature_status, flags);
    assert.equal(copy.feature_status.agent, false);
    assert.equal(copy.feature_status.comment, true);
    assert.equal(copy.feature_status.other, other);
    assert.equal(copy.metadata, other);
    assert.equal(body.feature_status.agent, agent);
    for (const [text, expected] of [[source, agent === true], [patched, false]]) {
      const box = fixtureRuntime(text), checked = box.check('https://semantics.test/');
      box.requests[0].resolveBody(body);
      assert.equal((await checked).result.blocked, expected);
      assert.equal(body.feature_status.agent, agent);
      assert.equal(body.feature_status.comment, true);
    }
  }
  for (const body of [null, {}, {feature_status: null}, {feature_status: {comment: true}}]) {
    const box = fixtureRuntime(patched), checked = box.check('https://missing.test/');
    box.requests[0].resolveBody(body);
    assert.equal((await checked).result.blocked, false);
  }
  for (const [text, denied] of [[source, true], [patched, false]]) {
    const box = fixtureRuntime(text), checking = box.enforce('https://sentinel.test/').then(() => { throw new Error('User authorization still required'); });
    box.requests[0].resolve(true);
    await assert.rejects(checking, denied ? /Site status blocked/ : /User authorization still required/);
  }
});

test('before and after deferred transform retain request, cache, inflight, completion clock and error effects', async () => {
  for (const [text, expected] of [[source, true], [transformSource(source).transformation.patchedSource, false]]) {
    const box = fixtureRuntime(text), site = 'https://user:secret@www.effects.test/path?q=1#private';
    const first = box.check(site), reused = box.check(site);
    assert.equal(box.requests.length, 2);
    box.requests[1].reject(new Error('discarded inflight'));
    box.setTime(9000);
    box.requests[0].resolve(true);
    assert.deepEqual(plain((await first).result), {blocked: expected, cached: false});
    assert.deepEqual(plain((await reused).result), {blocked: expected, cached: false});
    box.setTime(9000 + 86400000 - 1);
    assert.deepEqual(plain((await box.check(site)).result), {blocked: expected, cached: true});
    box.requests[2].reject(new Error('discarded cache'));
    box.setTime(9000 + 86400000);
    const expired = box.check(site);
    box.requests[3].resolve(true);
    assert.deepEqual(plain((await expired).result), {blocked: expected, cached: false});
    assert.equal(box.requests.length, 4);
    for (const request of box.requests) {
      assert.equal(request.endpoint, 'https://chatgpt.com/backend-api/aura/site_status?site_url=https%3A%2F%2Fwww.effects.test%2Fpath%3Fq%3D1&url_request_source=codex_browser_use%3Atest&conversation_id=conversation&turn_id=turn');
      assert.equal(request.method, 'GET');
    }
    for (const failure of ['failHttp', 'failJson', 'reject']) {
      const next = box.check(`https://${failure.toLowerCase()}.test/`);
      box.requests.at(-1)[failure](new Error('network'));
      assert.equal(await next, undefined);
      const retry = box.check(`https://${failure.toLowerCase()}.test/`);
      box.requests.at(-1).resolve(true);
      assert.deepEqual(plain((await retry).result), {blocked: expected, cached: false});
    }
    await assert.rejects(box.check('not a URL'), /Invalid URL/);
    const count = box.requests.length;
    for (const address of ['file:///path', 'https://localhost/', 'https://a.localhost/', 'http://127.0.0.1/', 'http://[::1]/']) assert.equal(await box.check(address), undefined);
    assert.equal(box.requests.length, count);
    await new Promise(resolve => setImmediate(resolve));
  }
});

test('self-authored fixture starts every request, keeps cache until inclusive TTL and timestamps completion', async () => {
  const box = fixtureRuntime(), site = 'https://www.example.test/path?q=1#fragment';
  const first = box.check(site);
  assert.equal(box.requests.length, 1);
  const endpoint = new URL(box.requests[0].endpoint);
  assert.equal(endpoint.pathname, '/backend-api/aura/site_status');
  assert.equal(endpoint.searchParams.get('site_url'), 'https://www.example.test/path?q=1');
  assert.equal(endpoint.searchParams.get('conversation_id'), 'conversation');
  assert.equal(endpoint.searchParams.get('turn_id'), 'turn');
  assert.equal(endpoint.searchParams.get('url_request_source'), 'codex_browser_use:test');
  assert.equal(box.requests[0].method, 'GET');
  box.setTime(5000);
  box.requests[0].resolve(true);
  assert.deepEqual(plain((await first).result), {blocked: true, cached: false});
  box.setTime(5000 + 86400000 - 1);
  const hit = await box.check(site);
  assert.equal(box.requests.length, 2);
  assert.deepEqual(plain(hit.result), {blocked: true, cached: true});
  box.requests[1].resolve(false);
  box.setTime(5000 + 86400000);
  const expired = box.check(site);
  assert.equal(box.requests.length, 3);
  box.requests[2].resolve(false);
  assert.deepEqual(plain((await expired).result), {blocked: false, cached: false});
  const refreshed = await box.check(site);
  assert.equal(box.requests.length, 4);
  assert.deepEqual(plain(refreshed.result), {blocked: false, cached: true});
  box.requests[3].resolve(true);
});

test('self-authored fixture reuses old inflight while discarding new requests and clears settled failures for retry', async () => {
  const box = fixtureRuntime(), site = 'https://inflight.test/';
  const first = box.check(site), second = box.check(site);
  assert.equal(box.requests.length, 2);
  box.requests[1].reject(new Error('discarded new request'));
  box.requests[0].resolve(true);
  assert.deepEqual(plain((await first).result), {blocked: true, cached: false});
  assert.deepEqual(plain((await second).result), {blocked: true, cached: false});
  const cached = await box.check(site);
  assert.equal(box.requests.length, 3);
  assert.deepEqual(plain(cached.result), {blocked: true, cached: true});
  box.requests[2].reject(new Error('discarded cached request'));
  // Give unhandled-rejection reporting a turn; neither discarded rejection escapes.
  await new Promise(resolve => setImmediate(resolve));
  const failure = box.check('https://retry.test/');
  box.requests[3].reject(new Error('network'));
  assert.equal(await failure, undefined);
  const retry = box.check('https://retry.test/');
  assert.equal(box.requests.length, 5);
  box.requests[4].resolve(false);
  assert.deepEqual(plain((await retry).result), {blocked: false, cached: false});
});

test('self-authored entry preserves HTTP/JSON/network catches, invalid-input throws and actual blocked policy denial', async () => {
  for (const failure of ['failHttp', 'failJson', 'reject']) {
    const box = fixtureRuntime(), checking = box.check('https://failure.test/');
    box.requests[0][failure](new Error('network'));
    assert.equal(await checking, undefined);
  }
  const box = fixtureRuntime();
  await assert.rejects(box.check('not a URL'), /Invalid URL/);
  assert.equal(await box.check('file:///path'), undefined);
  assert.equal(await box.check('https://localhost/'), undefined);
  assert.equal(box.requests.length, 0);
  const denied = box.enforce('https://denied.test/');
  box.requests[0].resolve(true);
  await assert.rejects(denied, /Site status blocked/);
  const allowed = box.enforce('https://allowed.test/');
  box.requests[1].resolve(false);
  assert.equal(await allowed, undefined);
});

test('self-authored reentrant fetch preserves the first installed inflight result and retries after expiry', async () => {
  const box = fixtureRuntime(), site = 'https://overlap.test/';
  // Reenter at fetch, the authorized runtime boundary, before the outer call
  // installs its inflight value. No internal Map or method is exposed to tests.
  const fetch = box.runtime.fetch;
  let inner, reenter = true;
  box.runtime.fetch = function(endpoint, options) {
    const pending = fetch.call(this, endpoint, options);
    if (reenter) { reenter = false; inner = box.check(site); }
    return pending;
  };
  const outer = box.check(site);
  assert.equal(box.requests.length, 2);
  box.requests[1].resolve(true);
  assert.deepEqual(plain((await inner).result), {blocked: true, cached: false});
  // Outer reused inner, so both results still come from the original inflight.
  assert.deepEqual(plain((await outer).result), {blocked: true, cached: false});
  box.requests[0].reject(new Error('discarded reentrant request'));
  await new Promise(resolve => setImmediate(resolve));
  box.setTime(1000 + 86400000);
  const next = box.check(site);
  assert.equal(box.requests.length, 3);
  box.requests[2].resolve(false);
  assert.deepEqual(plain((await next).result), {blocked: false, cached: false});
});

test('retains full evidence after state-field, method, bridge, callback and local renames', () => {
  let text = source;
  for (const [before, after] of Object.entries({now:'clock0', getTurnMetadata:'metadata0', cache:'cache0', inflightRequests:'flights0', cachedBlocked:'cached0', getMetadata:'accessor0', ttl:'ttl0', checkSite:'bridge0', enforce:'policy0', policy:'instance0', pending:'pending0', cached:'hit0', previous:'old0', current:'current0', blocked:'blocked0'})) {
    // blocked/cached are public result schema; their local bindings may be renamed
    // with explicit keys without changing schema fields.
    if (before === 'blocked' || before === 'cached') continue;
    text = text.replace(new RegExp(`\\b${before}\\b`, 'g'), after);
  }
  text = text.replace('Date.clock0', 'Date.now');
  text = text.replace('blocked => (', 'value0 => (').replace('{ blocked, timestampMs:', '{ blocked: value0, timestampMs:').replace(' }), blocked)).finally', ' }), value0)).finally');
  const result = analyzeSource(text);
  assert.equal(result.evidence.length, 8, JSON.stringify(result.diagnostics));
});

test('reports finite once initialization and strict agent evidence for a complete compatible chain', () => {
  const result = analyzeSource(source);
  assert.equal(result.patternVersion, 'site-status-deferred-v1');
  assert.equal(result.compatibility, 'compatible');
  assert.equal(result.runtime, 'not-verified');
  assert.equal(source.slice(result.target.start, result.target.end), 'body');
  assert.deepEqual(result.evidence.map(entry => entry.kind), ['initialization', 'predicate', 'source', 'transport', 'response', 'receiver', 'cache', 'consumption']);
  assert.match(result.evidence[0].description, /normal completion/i);
  assert.match(result.evidence[1].description, /strict.*true/i);
  assert.deepEqual(result.diagnostics, []);
  for (const entry of [...result.evidence, ...result.diagnostics]) {
    assert.equal(entry.range.unit, 'utf16');
    assert.ok(source.slice(entry.range.start, entry.range.end).length > 0);
  }
  assert.ok(transformSource(source).transformation);
});

test('proves URL input, request metadata, guarded receiver transport and same HTTP JSON binding', () => {
  const result = analyzeSource(source);
  assert.deepEqual(result.evidence.map(entry => entry.kind), ['initialization', 'predicate', 'source', 'transport', 'response', 'receiver', 'cache', 'consumption']);
  assert.deepEqual(result.diagnostics, []);
  const [input, transport, response] = result.evidence.slice(2);
  assert.ok(source.slice(input.range.start, input.range.end).startsWith('function requestFor('));
  assert.match(input.description, /origin.*pathname.*search/);
  assert.match(input.description, /conversation_id.*turn_id/);
  assert.ok(source.slice(transport.range.start, transport.range.end).startsWith('async function transport('));
  assert.match(transport.description, /receiver.*GET/);
  assert.ok(source.slice(response.range.start, response.range.end).startsWith('async fetchBlocked('));
  assert.match(response.description, /same HTTP.*JSON.*binding/);
  assert.equal(result.compatibility, 'compatible');
  assert.equal(source.slice(result.target.start, result.target.end), 'body');
  assert.ok(transformSource(source).transformation);
});

test('proves constructor defaults, fresh state fields and the unique class receiver', () => {
  const result = analyzeSource(source);
  const receiver = result.evidence.find(entry => entry.kind === 'receiver');
  assert.ok(receiver, JSON.stringify(result.diagnostics));
  assert.match(receiver.description, /constructor.*Date\.now.*metadata/i);
  assert.match(receiver.description, /fresh.*Map.*unique.*instance/i);
  assert.ok(source.slice(receiver.range.start, receiver.range.end).startsWith('class {'));
  assert.equal(source.slice(result.target.start, result.target.end), 'body');
  assert.ok(transformSource(source).transformation);
});

test('proves request-first cache hits, TTL, inflight reuse and identity-checked cleanup through the policy consumer', () => {
  const result = analyzeSource(source);
  assert.deepEqual(result.evidence.map(entry => entry.kind), ['initialization', 'predicate', 'source', 'transport', 'response', 'receiver', 'cache', 'consumption']);
  assert.deepEqual(result.diagnostics, []);
  assert.match(result.evidence[6].description, /before.*cache.*inflight/i);
  assert.match(result.evidence[6].description, /86400000.*same.*promise.*discarded/i);
  assert.match(result.evidence[7].description, /checkUrl.*result\.blocked.*catch/i);
  assert.equal(result.compatibility, 'compatible');
  assert.equal(source.slice(result.target.start, result.target.end), 'body');
  assert.ok(transformSource(source).transformation);
});

test('rejects changed constructor, fields, metadata, TTL and every finite cache branch', () => {
  for (const [before, after, code] of [
    ['now = Date.now', 'now = otherClock', 'CLASS_CONSTRUCTOR'],
    ['this.now = now;', 'this.now = turnMetadata;', 'CLASS_CONSTRUCTOR'],
    ['return runtime.turn;', 'return other.turn;', 'METADATA_ACCESSOR'],
    ['cache = new Map;', 'cache = other;', 'CLASS_FIELDS'],
    ['inflightRequests = new Map;', 'inflightRequests = this.cache;', 'CLASS_FIELDS'],
    ['ttl = 1440 * 60 * 1e3', 'ttl = 1440 * 60 * 1e2', 'CACHE_TTL'],
    ['this.now() - entry.timestampMs >= ttl', 'this.now() - entry.timestampMs > ttl', 'CACHE_TTL'],
    ['entry != null && this.cache.delete(key)', 'entry == null && this.cache.delete(key)', 'CACHE_TTL'],
    ['null) : entry.blocked', 'null) : false', 'CACHE_TTL'],
    ['pending.catch(() => {}), { blocked: cached', 'pending, { blocked: cached', 'CACHE_DISCARDED_REQUEST'],
    ['pending.catch(() => {}), { blocked: await previous', 'pending.catch(() => { throw new Error("discarded"); }), { blocked: await previous', 'CACHE_DISCARDED_REQUEST'],
    ['blocked: await previous, cached: false', 'blocked: await pending, cached: false', 'CACHE_DISCARDED_REQUEST'],
    ['{ blocked, timestampMs: this.now() }', '{ blocked: false, timestampMs: this.now() }', 'CACHE_RECORD'],
    ['=== current && this.inflightRequests.delete', '!== current && this.inflightRequests.delete', 'CACHE_CLEANUP'],
    ['=== current && this.inflightRequests.delete(request.cacheKey)', '=== current && this.cache.delete(request.cacheKey)', 'CACHE_CLEANUP'],
    ['set(request.cacheKey, current), { blocked: await current', 'set(request.cacheKey, pending), { blocked: await current', 'CACHE_INFLIGHT'],
    ['status.result.blocked', 'status.request.blocked', 'POLICY_BLOCKED'],
    ['let status = await checkSite(runtime, site, backend);', 'let status = await checkSite(runtime, other, backend);', 'POLICY_CONNECTION'],
    ['function checkSite(runtime, site, backend) { return policy.checkUrl(runtime, site, backend); }', 'function checkSite(runtime, site, backend) { return policy.isBlocked(runtime, site, backend); }', 'POLICY_CONNECTION'],
  ]) {
    assert.ok(source.includes(before), before);
    const text = source.replace(before, after), result = analyzeSource(text);
    assert.deepEqual(result.evidence, [], after);
    assert.equal(result.diagnostics[0].code, `DEFERRED_${code}`, JSON.stringify(result));
    assert.equal(result.target, null);
    assert.equal(transformSource(text).transformation, null);
  }
});

test('rejects additional class state effects, extra methods, nested dynamic receivers and cache host mutation', () => {
  for (const extra of [
    'this.cache = new Map;', 'this.now = replacement;', 'this.inflightRequests.clear();',
    'unknown(this.cache);', 'unknown(this.now);',
  ]) {
    const text = source.replace('let previous = this.inflightRequests', `${extra} let previous = this.inflightRequests`);
    const result = analyzeSource(text);
    assert.deepEqual(result.evidence, [], extra);
    assert.match(result.diagnostics[0].code, /^DEFERRED_(CACHE|REQUEST_RECEIVER)/, extra);
  }
  for (const extra of [
    'mutate() { this.cache.clear(); }',
    'cachedBlocked() { return false; }',
    'get now() { return replacement; }',
    'extra = unknown();',
    'escape() { return this.cache; }',
  ]) {
    const result = analyzeSource(source.replace('  now;\n  getTurnMetadata;', `  ${extra}\n  now;\n  getTurnMetadata;`));
    assert.deepEqual(result.evidence, [], extra);
  }
  for (const extra of [
    'Map.prototype.get = replacement;', 'Date.now = replacement;', 'Promise.prototype.then = replacement;',
    'const root = globalThis; const {Map: alias} = root; unknown(alias);',
    'const mutate = Reflect.set; mutate(Promise.prototype, "finally", replacement);',
  ]) {
    const result = analyzeSource(source + '\n' + extra);
    assert.deepEqual(result.evidence, [], extra);
    assert.equal(result.diagnostics[0].code, 'DEFERRED_HOST_MUTATION', extra);
  }
});

test('rejects class/instance/bridge aliases, borrowed methods, shadowing and multiple complete candidates', () => {
  for (const extra of [
    'const alias = SitePolicy; Reflect.set(alias.prototype, "cachedBlocked", replacement);',
    'const {prototype: alias} = SitePolicy; alias.now = replacement;',
    'class Child extends SitePolicy {}', 'unknown(policy);', 'export {policy};',
    'const borrowed = policy.checkUrl; borrowed(runtime, site, backend);',
    'policy.checkUrl.call(other, runtime, site, backend);',
    'const otherPolicy = new SitePolicy;', 'unknown(checkSite);', 'checkSite = replacement;',
    'ttl = 1;',
  ]) {
    const result = analyzeSource(source + '\n' + extra);
    assert.deepEqual(result.evidence, [], extra);
    assert.equal(result.target, null);
  }
  const unused = source.slice(0, source.indexOf('async function enforce('));
  assert.deepEqual(analyzeSource(unused).evidence, []);
  const duplicate = source + '\n' + source.slice(source.indexOf('var ttl')).replace(/\b(SitePolicy|policy|checkSite|enforce|ttl)\b/g, '$1Other');
  assert.equal(analyzeSource(duplicate).diagnostics[0].code, 'AMBIGUOUS_DEFERRED_STAGE');
});

test('rejects generator methods that do not execute the claimed async lifecycle', () => {
  for (const name of ['isBlocked', 'checkUrl']) {
    const result = analyzeSource(source.replace(`async ${name}(`, `async *${name}(`));
    assert.deepEqual(result.evidence, [], name);
  }
});

test('proves the finite guarded string-or-object request metadata accessor with throwing JSON parse fallback', () => {
  const accessor = `function getMetadata(runtime) {
    let value = runtime.requestMeta?.['x-codex-turn-metadata'];
    if (typeof value == 'string') try { value = JSON.parse(value); } catch { return; }
    if (!(value == null || typeof value != 'object' || Array.isArray(value))) return value;
  }`;
  const text = source.replace('function getMetadata(runtime) { return runtime.turn; }', accessor);
  const result = analyzeSource(text);
  assert.equal(result.evidence.length, 8, JSON.stringify(result.diagnostics));
  for (const changed of [
    accessor.replace('JSON.parse(value)', 'JSON.parse(other)'),
    accessor.replace('Array.isArray(value)', 'Array.isArray(other)'),
    accessor.replace('catch { return; }', 'catch { value = {}; }'),
    accessor.replace('return value;', 'return other;'),
  ]) assert.deepEqual(analyzeSource(source.replace('function getMetadata(runtime) { return runtime.turn; }', changed)).evidence, []);
});

test('proves an inline awaited policy callback and refuses an unused helper as its substitute', () => {
  const inline = source.slice(0, source.indexOf('async function enforce(')) + `
    var Gate = class {
      policies = {siteStatus: async site => {
        if ((await checkSite(this.runtime, site, this.backend))?.result.blocked) throw new Error('Site status blocked');
      }};
    };`;
  // Preserve the original accepted literal-only input as an explicit regression:
  // no outer instance or entry exists, so this no longer proves actual use.
  const unusedInline = transformSource(inline);
  assert.equal(unusedInline.analysis.diagnostics[0].code, 'DEFERRED_POLICY_LIFECYCLE');
  assert.equal(unusedInline.analysis.compatibility, 'incompatible');
  assert.equal(unusedInline.transformation, null);
  const liveInline = inline + '\nvar gate = new Gate; gate.runtime = runtime; gate.backend = backend; gate.policies.siteStatus(site);';
  assert.equal(analyzeSource(liveInline).evidence.length, 8, JSON.stringify(analyzeSource(liveInline).diagnostics));
  const helper = 'async throwIfBlocksUrl(runtime, site, backend) { let result = await this.checkUrl(runtime, site, backend); if (result?.result.blocked) throw new Error("blocked"); }';
  const withHelper = liveInline.replace('  now;\n  getTurnMetadata;', `  ${helper}\n  now;\n  getTurnMetadata;`);
  assert.equal(analyzeSource(withHelper).evidence.length, 8, JSON.stringify(analyzeSource(withHelper).diagnostics));
  assert.deepEqual(analyzeSource(withHelper.slice(0, withHelper.indexOf('var Gate'))).evidence, []);
  assert.deepEqual(analyzeSource(withHelper.replace('this.checkUrl(runtime, site, backend)', 'this.cache.clear()')).evidence, []);
  for (const changed of [
    liveInline.replace('?.result.blocked', '?.result.cached'),
    liveInline.replace('await checkSite', 'checkSite'),
    liveInline.replace('this.runtime, site, this.backend', 'this.runtime, "fixed", this.backend'),
  ]) assert.deepEqual(analyzeSource(changed).evidence, []);
});

test('rejects replaced or escaped inline policy tables while preserving the live inline entry', async () => {
  const inline = source.slice(0, source.indexOf('async function enforce(')) + `
    var Gate = class {
      policies = {siteStatus: async site => {
        if ((await checkSite(this.runtime, site, this.backend))?.result.blocked) throw new Error('Blocked');
      }};
    };
    var gate = new Gate;
    gate.runtime = {turn: {}, fetch(endpoint) { globalThis.requestCount++; return Promise.resolve({ok: true, json: async () => ({feature_status: {agent: true}})}); }};
    gate.backend = null;
  `;
  const entry = '\nglobalThis.finished = gate.policies.siteStatus("https://inline.test/");';
  const run = async text => {
    const context = { URL, basename: value => value, requestCount: 0 };
    runInNewContext(text.replace("import { basename } from 'node:path';", ''), context);
    let error;
    try { await context.finished; } catch (caught) { error = caught; }
    return {error, requests: context.requestCount};
  };
  const safe = inline + entry, original = await run(safe);
  assert.match(String(original.error), /Blocked/);
  assert.equal(original.requests, 1);
  const transformed = transformSource(safe);
  assert.equal(transformed.analysis.compatibility, 'compatible', JSON.stringify(transformed.analysis.diagnostics));
  const patched = await run(transformed.transformation.patchedSource);
  assert.equal(patched.error, undefined);
  assert.equal(patched.requests, 1);
  for (const mutation of [
    'gate.policies = {siteStatus: async site => {}};',
    'gate.policies.siteStatus = async site => {};',
    'function overwrite(table) { table.siteStatus = async site => {}; } overwrite(gate.policies);',
  ]) {
    const text = inline + mutation + entry, observed = await run(text);
    assert.equal(observed.error, undefined);
    assert.equal(observed.requests, 0);
    const result = transformSource(text);
    assert.equal(result.analysis.compatibility, 'incompatible', mutation);
    assert.equal(result.analysis.diagnostics[0].code, 'DEFERRED_POLICY_RECEIVER', mutation);
    assert.equal(result.analysis.target, null);
    assert.equal(result.transformation, null);
  }
});

test('closes inline outer receiver, table and callback aliases while retaining renamed direct entries', () => {
  const inline = source.slice(0, source.indexOf('async function enforce(')) + `
    var Gate = class { policies = {siteStatus: async site => {
      if ((await checkSite(this.runtime, site, this.backend))?.result.blocked) throw new Error('Blocked');
    }}; };
    var gate = new Gate;
    gate.runtime = runtime; gate.backend = backend;
  `;
  const entry = '\ngate.policies.siteStatus(site);';
  let renamed = inline + entry;
  for (const [before, after] of Object.entries({Gate: 'Outer0', gate: 'outer0', policies: 'rules0', siteStatus: 'deny0', runtime: 'runtime0', backend: 'backend0'})) renamed = renamed.replace(new RegExp(`\\b${before}\\b`, 'g'), after);
  renamed = renamed.replaceAll('/backend0-api', '/backend-api');
  assert.equal(analyzeSource(renamed).compatibility, 'compatible', JSON.stringify(analyzeSource(renamed).diagnostics));
  assert.equal(analyzeSource(inline + '\nother.policies = {}; unknown(other);' + entry).compatibility, 'compatible');
  for (const mutation of [
    'const alias = gate; alias.policies = {};',
    'const {policies: alias} = gate; unknown(alias);',
    'const [alias] = [gate.policies]; unknown(alias);',
    'const alias = (0, gate.policies); unknown(alias);',
    'const alias = gate.policies.siteStatus; alias(site);',
    'gate.policies.siteStatus.call(other, site);',
    'gate.policies[dynamicKey] = replacement;',
    'gate[dynamicKey] = replacement;',
    'Reflect.set(gate.policies, "siteStatus", replacement);',
    'Object.setPrototypeOf(gate, other);',
    'delete gate.policies.siteStatus;',
    'unknown(() => gate.policies);',
    'export {gate};',
    'Gate.prototype.policies = {};',
    'class Child extends Gate {}',
    'var second = new Gate;',
    'gate = other;',
  ]) {
    const result = transformSource(inline + mutation + entry);
    assert.equal(result.analysis.compatibility, 'incompatible', mutation);
    assert.match(result.analysis.diagnostics[0].code, /^DEFERRED_(POLICY_(RECEIVER|LIFECYCLE)|REASSIGNED_BINDING)$/, mutation);
    assert.equal(result.transformation, null);
  }
  for (const changed of [
    inline + entry.replace('siteStatus(site)', 'siteStatus.call(other, site)'),
    inline + entry.replace('.siteStatus', '[dynamicKey]'),
    inline + entry.replace('gate.policies', 'gate?.policies'),
    inline.replace('class { policies', 'class extends Other { policies') + entry,
    inline.replace('policies =', 'constructor() { this.policies = {}; } policies =') + entry,
    inline.replace('policies =', 'runtime = unknown(this); policies =') + entry,
    inline.replace('new Gate', 'new Gate(argument)') + entry,
    inline,
  ]) {
    const result = transformSource(changed);
    assert.equal(result.analysis.compatibility, 'incompatible');
    assert.match(result.analysis.diagnostics[0].code, /^DEFERRED_POLICY_(RECEIVER|LIFECYCLE)$/);
    assert.equal(result.transformation, null);
  }
});

test('rejects a policy bridge redirected to an unrelated three-input method with five statements', () => {
  const text = source.replace('  now;\n  getTurnMetadata;', '  other(a,b,c) { let x; let y; let z; let w; return {result:{blocked:false}}; }\n  now;\n  getTurnMetadata;').replace('return policy.checkUrl(runtime, site, backend);', 'return policy.other(runtime, site, backend);');
  assert.deepEqual(analyzeSource(text).evidence, []);
});

test('rejects relevant standard capability escape through aggregate containers and returned prototype aliases', () => {
  for (const extra of [
    'unknown({capability: Map});',
    'unknown([Date]);',
    'unknown({capability: Promise.prototype});',
    'const alias = Object.getPrototypeOf(Map.prototype); alias.get = replacement;',
    'const alias = Object.getPrototypeOf(Promise.prototype); unknown(alias);',
    'new Unknown(Map);',
    'export const exposed = Map;',
  ]) {
    const result = analyzeSource(source + '\n' + extra);
    assert.deepEqual(result.evidence, [], extra);
    assert.equal(result.diagnostics[0].code, 'DEFERRED_HOST_MUTATION', extra);
  }
});

test('rejects host aliases propagated through destructuring, logical and sequence values', async () => {
  const extra = '\nconst [proto] = [URL.prototype]; proto.toString = function() { return "https://attacker.invalid/"; };';
  // Synthetic execution demonstrates the endpoint violation without mutating the
  // process URL prototype. The analyzer must refuse this visible host change.
  class PrivateURL extends URL {}
  const context = { URL: PrivateURL, basename: value => value };
  runInNewContext((source + extra).replace("import { basename } from 'node:path';", '') + '\nglobalThis.check = checkSite;', context);
  const endpoints = [];
  await context.check({turn: {}, fetch(endpoint) { endpoints.push(endpoint); return Promise.resolve({ok: true, json: async () => ({feature_status: {agent: true}})}); }}, 'https://original.test/', null);
  assert.deepEqual(endpoints, ['https://attacker.invalid/']);
  const result = transformSource(source + extra);
  assert.equal(result.analysis.compatibility, 'incompatible');
  assert.equal(result.analysis.diagnostics[0].code, 'DEFERRED_HOST_MUTATION');
  assert.equal(result.analysis.target, null);
  assert.equal(result.transformation, null);
});

test('rejects wrapped host and dynamic-code values without rejecting unrelated wrapped values', () => {
  const safe = source + '\nconst [local] = [{nested: {}}]; const alias = (0, local.nested) || {}; alias.value = 1; unknown(alias);';
  assert.equal(analyzeSource(safe).compatibility, 'compatible');
  for (const extra of [
    'const proto = URL.prototype || {}; proto.toString = replacement;',
    'const proto = (0, URL.prototype); proto.toString = replacement;',
    'const proto = URL.prototype && URL.prototype; proto.toString = replacement;',
    'const proto = URL.prototype ?? {}; proto.toString = replacement;',
    'const {nested: [proto]} = {nested: [URL.prototype]}; proto.toString = replacement;',
    'const [...protos] = [URL.prototype]; unknown(protos);',
    'let proto; [proto] = [URL.prototype]; proto.toString = replacement;',
    'const [proto = URL.prototype] = []; proto.toString = replacement;',
    'const {proto = URL.prototype} = {}; proto.toString = replacement;',
    'const { ["URL"]: ctor } = globalThis; ctor.prototype.toString = replacement;',
    'const [root] = [globalThis]; root.URL = replacement;',
    'const root = (0, globalThis) || {}; root.URL = replacement;',
    'const [root = globalThis] = []; unknown(root);',
    'unknown((0, URL.prototype));',
    'unknown(URL.prototype || {});',
    'unknown?.(URL.prototype || {});',
    'const proto = URL.prototype; proto?.__defineGetter__("toString", replacement);',
    'const make = Function; make?.("URL.prototype.toString = replacement")();',
    'unknown({...URL.prototype});',
    'const proto = await URL.prototype; proto.toString = replacement;',
    'const make = (0, Function) || replacement; make("URL.prototype.toString = replacement")();',
    'const [make] = [Function]; make("URL.prototype.toString = replacement")();',
    'const make = globalThis.Function; make("URL.prototype.toString = replacement")();',
    'const {["Function"]: make} = globalThis; make("URL.prototype.toString = replacement")();',
    'const [root] = [globalThis]; root.Function("URL.prototype.toString = replacement")();',
    'const make = Function.prototype.constructor; make("URL.prototype.toString = replacement")();',
    'function mutate(proto = URL.prototype) { proto.toString = replacement; } mutate();',
    'for (const proto of [URL.prototype]) { proto.toString = replacement; }',
    'try { throw URL.prototype; } catch (proto) { proto.toString = replacement; }',
    'function* expose() { yield URL.prototype; } unknown(expose());',
    'const proto = URL.prototype || {}; proto.__defineGetter__("toString", replacement);',
    'const proto = (0, URL.prototype); proto[dynamicKey](replacement);',
  ]) {
    const result = transformSource(source + '\n' + extra);
    assert.equal(result.analysis.compatibility, 'incompatible', extra);
    assert.match(result.analysis.diagnostics[0].code, /^DEFERRED_(HOST_MUTATION|DYNAMIC_SCOPE)$/, extra);
    assert.equal(result.analysis.target, null);
    assert.equal(result.transformation, null);
  }
});

test('retains refusal for a local handle bridge into opaque Wasm or callbacks', () => {
  for (const access of ['globalThis', 'globalThis[dynamicKey]']) {
    const text = source + `\nconst handles = []; const bridge = {store(value) { handles.push(value); return handles.length - 1; }, load(key) { return handles[key]; }}; const imports = {get: () => bridge.store(${access}), invoke: key => bridge.load(key)()}; opaqueInstantiate(imports);`;
    const result = analyzeSource(text);
    assert.deepEqual(result.evidence, []);
    assert.equal(result.diagnostics[0].code, 'DEFERRED_HOST_MUTATION');
    assert.equal(result.target, null);
  }
});

test('permits a uniquely established unrelated global cache key through conditional global aliases', () => {
  const safe = source + '\nvar cacheKey = "unrelatedCache", root = ready ? globalThis : {}; var value = root[cacheKey]; root[cacheKey] = {}; unknown(value);';
  assert.equal(analyzeSource(safe).evidence.length, 8, JSON.stringify(analyzeSource(safe).diagnostics));
  for (const text of [safe.replace('"unrelatedCache"', '"Map"'), safe + '\ncacheKey = dynamicKey;']) {
    assert.deepEqual(analyzeSource(text).evidence, []);
    assert.equal(analyzeSource(text).diagnostics[0].code, 'DEFERRED_HOST_MUTATION');
  }
});

test('rejects dynamic code and capability-returning callbacks that can reach relevant host state', () => {
  for (const extra of [
    'Function("Map.prototype.get = replacement")();',
    'const make = Function; make("Date.now = replacement")();',
    '(0, eval)("Promise.prototype.then = replacement");',
    'unknown(() => Map);',
    'unknown(() => globalThis);',
  ]) {
    const result = analyzeSource(source + '\n' + extra);
    assert.deepEqual(result.evidence, [], extra);
    assert.match(result.diagnostics[0].code, /^DEFERRED_(HOST_MUTATION|DYNAMIC_SCOPE)$/, extra);
  }
});

test('rejects initialization-time lifecycle substitutions and malformed policy returns', () => {
  for (const text of [
    source.replace('}, policy = new SitePolicy;', '}; if (ready) { var policy = new SitePolicy; }'),
    source.replace('}, policy = new SitePolicy;', '}, policy = new SitePolicy; policy = new SitePolicy;'),
    source.replace('return { request, result };', 'return { request, result: {blocked: false} };'),
    source.replace('} catch { return; }\n    return { request, result };', '} catch { return {result:{blocked:false}}; }\n    return { request, result };'),
    source.replace('now;\n  getTurnMetadata;', 'now;\n  getTurnMetadata;\n  cache;'),
    source.replace('ttl = 1440 * 60 * 1e3', 'ttl = 1440 * 60 * clock()'),
  ]) {
    const result = analyzeSource(text);
    assert.deepEqual(result.evidence, []);
    assert.equal(result.target, null);
  }
});

test('rejects indirect capability exports, tagged calls and storage on unknown objects', () => {
  for (const extra of [
    'const alias = Map; export {alias};',
    'function expose() { return Map; } unknown(expose);',
    'unknown.target = Map;',
    'unknown`capability ${Map}`;',
    'const alias = ready ? Date : Promise; unknown(alias);',
    'const alias = [Map]; unknown(alias[0]);',
  ]) {
    const result = analyzeSource(source + '\n' + extra);
    assert.deepEqual(result.evidence, [], extra);
    assert.equal(result.diagnostics[0].code, 'DEFERRED_HOST_MUTATION', extra);
  }
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
  assert.deepEqual(result.evidence.map(entry => entry.kind), ['initialization', 'predicate', 'source', 'transport', 'response', 'receiver', 'cache', 'consumption'], JSON.stringify(result.diagnostics));
  assert.ok(text.slice(result.evidence[2].range.start, result.evidence[2].range.end).startsWith('function r0('));
  assert.ok(text.slice(result.evidence[3].range.start, result.evidence[3].range.end).startsWith('async function r4('));
  assert.ok(text.slice(result.evidence[4].range.start, result.evidence[4].range.end).startsWith('async r15('));
  assert.equal(transformSource(text).transformation.before, 'r10');
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
  assert.deepEqual(analyzeSource(safe).evidence.map(entry => entry.kind), ['initialization', 'predicate', 'source', 'transport', 'response', 'receiver', 'cache', 'consumption']);
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
  assert.deepEqual(analyzeSource(text).evidence.map(entry => entry.kind), ['initialization', 'predicate', 'source', 'transport', 'response', 'receiver', 'cache', 'consumption']);
});

test('rejects a caught failed initialization attempt before the normal initialization path', () => {
  const text = source.replace('initialize();\nasync function transport', 'try { initialize(); } catch {}\ninitialize();\nasync function transport');
  const result = analyzeSource(text);
  assert.equal(result.compatibility, 'incompatible');
  assert.deepEqual(result.evidence, []);
  assert.equal(result.diagnostics[0].code, 'DEFERRED_INITIALIZATION_ORDER');
});

test('rejects premature once activation inside an unknown callback factory even when failure is swallowed', async () => {
  const declaration = "var metadata, initMetadata = once(() => { metadata = { name: 'synthetic' }; });";
  const early = 'function swallow(callback) { try { callback(); } catch {} }\nvar early = swallow(() => { initSiteStatus(); });\n';
  const text = source.replace(declaration, '').replace('var initErrors =', early + declaration + '\nvar initErrors =');
  const box = fixtureRuntime(text);
  await assert.rejects(box.check('https://original.test/'), /Invalid URL/);
  assert.equal(box.requests.length, 0);
  const result = transformSource(text);
  assert.equal(result.analysis.compatibility, 'incompatible');
  assert.equal(result.analysis.diagnostics[0].code, 'DEFERRED_INITIALIZATION_ORDER');
  assert.equal(result.analysis.target, null);
  assert.equal(result.transformation, null);
});

test('proves an independent upward once caller and its dependencies before permitting early activation', async () => {
  const upward = `var label, initLabel = once(() => { initMetadata(); label = 'upward'; });
var callerValue, upward = once(() => { 'use strict'; initProtocols(); initLabel(); callerValue = 7; });
upward();
`;
  const text = source.replace('var initErrors =', upward + 'var initErrors =');
  const result = transformSource(text);
  assert.equal(result.analysis.compatibility, 'compatible', JSON.stringify(result.analysis.diagnostics));
  assert.ok(result.transformation);
  for (const [program, expected] of [[text, true], [result.transformation.patchedSource, false]]) {
    const box = fixtureRuntime(program), checking = box.check('https://upward.test/');
    assert.equal(box.requests.length, 1);
    box.requests[0].resolve(true);
    assert.equal((await checking).result.blocked, expected);
  }
});

test('proves upward enumeration of a closed literal enum without invoking callbacks or getters', async () => {
  const declarations = `var choices, initChoices = once(() => {
  choices = (entry => (entry.Default = '', entry.Test = 'test', entry))(choices || {});
});
var values, setting, initSettings = once(() => {
  'use strict'; initProtocols(); initChoices(); values = Object.values(choices); setting = 'window';
});
initSettings();
`;
  const text = source.replace('var initErrors =', declarations + 'var initErrors =');
  const result = transformSource(text);
  assert.equal(result.analysis.compatibility, 'compatible', JSON.stringify(result.analysis.diagnostics));
  assert.ok(result.transformation);
  for (const [program, expected] of [[text, true], [result.transformation.patchedSource, false]]) {
    const box = fixtureRuntime(program), checking = box.check('https://enum.test/');
    box.requests[0].resolve(true);
    assert.equal((await checking).result.blocked, expected);
  }
});

test('rejects upward callers with unproved helpers, dependency effects, closure or activation order', () => {
  const upward = `var label, initLabel = once(() => { initMetadata(); label = 'upward'; });
var callerValue, upward = once(() => { initProtocols(); initLabel(); callerValue = 7; });
upward();
`;
  const control = source.replace('var initErrors =', upward + 'var initErrors =');
  assert.equal(analyzeSource(control).compatibility, 'compatible');
  for (const [text, code] of [
    [control.replace('upward = once', 'upward = unknown'), 'DEFERRED_INITIALIZATION_ORDER'],
    [control.replace("label = 'upward'", 'label = unknown()'), 'DEFERRED_INITIALIZER_EFFECT'],
    [control.replace('callerValue = 7', 'callerValue = unknown()'), 'DEFERRED_INITIALIZER_EFFECT'],
    [control.replace('callerValue = 7', 'callerValue = agentKey'), 'DEFERRED_INITIALIZATION_ORDER'],
    [control.replace('initLabel(); callerValue', 'if (ready) initLabel(); callerValue'), 'DEFERRED_CONDITIONAL_INITIALIZATION'],
    [control.replace("label = 'upward'", "upward(); label = 'upward'"), 'DEFERRED_INITIALIZATION_CYCLE'],
    [control.replace('upward();\nvar initErrors', 'try { upward(); } catch {}\nvar initErrors'), 'DEFERRED_INITIALIZATION_ORDER'],
    [control.replace('upward();\nvar initErrors', 'if (ready) upward();\nvar initErrors'), 'DEFERRED_INITIALIZATION_ORDER'],
    [control.replace('var label,', 'try { upward(); } catch {}\nvar label,'), 'DEFERRED_INITIALIZATION_ORDER'],
    [control + '\nunknown(upward);', 'DEFERRED_ESCAPED_BINDING'],
    [control + '\nupward = replacement;', 'DEFERRED_REASSIGNED_BINDING'],
    [control + '\nconst alias = initLabel; alias();', 'DEFERRED_ESCAPED_BINDING'],
    [control.replace('initLabel = once(() =>', 'initLabel = once(async () =>'), 'DEFERRED_INITIALIZER_SHAPE'],
  ]) {
    const result = transformSource(text);
    assert.equal(result.analysis.compatibility, 'incompatible', text);
    assert.equal(result.analysis.target, null);
    assert.equal(result.transformation, null);
    if (code) assert.equal(result.analysis.diagnostics[0].code, code, JSON.stringify(result.analysis.diagnostics));
  }
});

test('rejects an upward initializer assignment to an unresolved global setter', () => {
  const text = source.replace('var initErrors =', `var upward = once(() => { initProtocols(); globalSetting = 7; });
upward();
var initErrors =`);
  const result = transformSource(text);
  assert.equal(result.analysis.compatibility, 'incompatible');
  assert.equal(result.analysis.diagnostics[0].code, 'DEFERRED_INITIALIZER_EFFECT');
  assert.equal(result.analysis.target, null);
  assert.equal(result.transformation, null);
});

test('rejects swallowed failure reached through multiple proven upward once callers', async () => {
  const declaration = "var metadata, initMetadata = once(() => { metadata = { name: 'synthetic' }; });";
  const upward = `var first = once(() => { initSiteStatus(); });
var second = once(() => { first(); });
try { second(); } catch {}
`;
  const text = source.replace(declaration, '').replace('var initErrors =', upward + declaration + '\nvar initErrors =');
  const box = fixtureRuntime(text);
  await assert.rejects(box.check('https://caught-upward.test/'), /Invalid URL/);
  assert.equal(box.requests.length, 0);
  const result = transformSource(text);
  assert.equal(result.analysis.diagnostics[0].code, 'DEFERRED_INITIALIZATION_ORDER');
  assert.equal(result.analysis.target, null);
  assert.equal(result.transformation, null);
});

test('rejects upward enum getters, aliases, replacements, unknown sources and host mutation', () => {
  const upward = `var choices, initChoices = once(() => {
  choices = (entry => (entry.Default = '', entry.Test = 'test', entry))(choices || {});
});
var values, initSettings = once(() => { initProtocols(); initChoices(); values = Object.values(choices); });
initSettings();
`;
  const control = source.replace('var initErrors =', upward + 'var initErrors =');
  assert.equal(analyzeSource(control).compatibility, 'compatible');
  for (const text of [
    control.replace("choices = (entry => (entry.Default = '', entry.Test = 'test', entry))(choices || {})", 'choices = {get value() { initSiteStatus(); return 1; }}'),
    control.replace("entry.Test = 'test'", 'entry.Test = unknown()'),
    control.replace("entry.Test = 'test'", "entry.__proto__ = 'test'"),
    control.replace("entry.Test = 'test'", "entry[unknown()] = 'test'"),
    control.replace('Object.values(choices)', 'Object.values(foreign)'),
    control.replace('initChoices(); values', 'values'),
    control.replace('initChoices(); values', 'values = Object.values(choices); initChoices(); values'),
    control.replace('var choices,', 'var choices = foreign,'),
    control + '\nchoices.Test = replacement;',
    control + '\nObject.defineProperty(choices, "Test", {get: replacement});',
    control + '\nunknown(choices);',
    control + '\nconst alias = choices;',
    control + '\nchoices = {};',
    control + '\nObject.values = replacement;',
    control + '\nconst alias = Object; unknown?.(alias);',
  ]) {
    const result = transformSource(text);
    assert.equal(result.analysis.compatibility, 'incompatible', text);
    assert.equal(result.analysis.target, null);
    assert.equal(result.transformation, null);
  }
});

test('permits unknown callback creation after normal initialization and unrelated earlier callback work', () => {
  const after = source.replace('initialize();\nasync function transport', 'initialize();\nvar later = unknown(() => { initSiteStatus(); });\nasync function transport');
  const unrelated = source.replace('var initErrors =', 'var earlier = unknown(() => { unrelated.count++; });\nvar initErrors =');
  for (const text of [after, unrelated]) assert.equal(analyzeSource(text).compatibility, 'compatible', JSON.stringify(analyzeSource(text).diagnostics));
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
  assert.deepEqual(result.evidence.map(entry => entry.kind), ['initialization', 'predicate', 'source', 'transport', 'response', 'receiver', 'cache', 'consumption']);
  assert.equal(text.slice(result.evidence[0].range.start, result.evidence[0].range.end), 'z4()');
  assert.ok(text.slice(result.evidence[1].range.start, result.evidence[1].range.end).startsWith('function z9('));
  assert.equal(transformSource(text).transformation.before, 'z12');
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
  assert.deepEqual(analyzeSource(text).evidence.map(entry => entry.kind), ['initialization', 'predicate', 'source', 'transport', 'response', 'receiver', 'cache', 'consumption']);
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
  assert.deepEqual(analyzeSource(text).evidence.map(entry => entry.kind), ['initialization', 'predicate', 'source', 'transport', 'response', 'receiver', 'cache', 'consumption']);
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
