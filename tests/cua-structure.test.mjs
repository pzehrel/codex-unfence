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
