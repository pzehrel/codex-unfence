import { parse } from 'acorn';
import type * as E from 'estree';
import type { Variable } from 'eslint-scope';
import { parseSourceContext } from './source-context.js';
import type { SourceContext } from './source-context.js';
import { CUA_SCHEME } from './cua-contract.js';
import type { CuaDerivation, Evidence, Range } from './cua-contract.js';
import { wrapCuaResponse } from './cua-recipe.js';

// Independently authored syntax patterns, not installed source or hash gates.
// AST matching below uses lexical binding identity, never these identifier names
// as anchors in the input. This finite family includes the complete cache path.
const patternSource = `
const baseUrl = 'https://chatgpt.com/backend-api', agentKey = 'agent', requestSource = 'codex_browser_use';
function isRecord(value) { return typeof value == 'object' && value != null; }
function enabled(body, key) {
  if (!isRecord(body)) return false;
  let flags = body.feature_status;
  return isRecord(flags) ? flags[key] === true : false;
}
function agentBlocked(body) { return enabled(body, agentKey); }
function localHost(host) { return host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '[::1]' || host === '::1'; }
function displayUrl(url) { let copy = new URL(url.origin); copy.pathname = url.pathname; let text = copy.toString(); return copy.pathname === '/' ? text.slice(0, -1) : text; }
function endpointFor(url, { conversationId, turnId, urlRequestSource }) {
  let copy = new URL(url.origin);
  copy.pathname = url.pathname, copy.search = url.search;
  let endpoint = new URL(\`\${baseUrl}/aura/site_status\`);
  return endpoint.searchParams.set('site_url', copy.toString()), endpoint.searchParams.set('url_request_source', urlRequestSource), conversationId != null && endpoint.searchParams.set('conversation_id', conversationId), turnId != null && endpoint.searchParams.set('turn_id', turnId), endpoint.toString();
}
function requestFor(site, { conversationId, turnId, urlRequestSource = requestSource } = {}) {
  let url;
  try { url = new URL(site); } catch { throw new Error('Invalid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  let host = url.hostname.trim().toLowerCase();
  if (host.length === 0) throw new Error('Missing host');
  return localHost(host) ? null : { cacheKey: host.startsWith('www.') ? host.slice(4) : host, displayUrl: displayUrl(url), endpoint: endpointFor(url, { conversationId, turnId, urlRequestSource }) };
}
async function transport(runtime, endpoint, options) {
  if (typeof runtime.fetch !== 'function') throw new Error('Missing fetch');
  return await runtime.fetch(endpoint, options);
}
function getMetadata(runtime) { return runtime.turn; }
const ttl = 1440 * 60 * 1e3;
const SitePolicy = class {
  constructor(now = Date.now, turnMetadata = getMetadata) { this.now = now; this.getTurnMetadata = turnMetadata; }
  now;
  getTurnMetadata;
  cache = new Map;
  inflightRequests = new Map;
  async checkUrl(runtime, site, backend) {
    let metadata = this.getTurnMetadata(runtime), request = requestFor(site, { conversationId: metadata?.session_id, turnId: metadata?.turn_id, urlRequestSource: backend == null ? requestSource : \`\${requestSource}:\${backend}\` });
    if (request == null) return;
    let result;
    try { result = await this.isBlocked(runtime, request); } catch { return; }
    return { request, result };
  }
  async isBlocked(runtime, request) {
    let pending = this.fetchBlocked(runtime, request), cached = this.cachedBlocked(request.cacheKey);
    if (cached != null) return pending.catch(() => {}), { blocked: cached, cached: true };
    let previous = this.inflightRequests.get(request.cacheKey);
    if (previous != null) return pending.catch(() => {}), { blocked: await previous, cached: false };
    let current = pending.then(blocked => (this.cache.set(request.cacheKey, { blocked, timestampMs: this.now() }), blocked)).finally(() => { this.inflightRequests.get(request.cacheKey) === current && this.inflightRequests.delete(request.cacheKey); });
    return this.inflightRequests.set(request.cacheKey, current), { blocked: await current, cached: false };
  }
  cachedBlocked(key) {
    let entry = this.cache.get(key);
    return entry == null || this.now() - entry.timestampMs >= ttl ? (entry != null && this.cache.delete(key), null) : entry.blocked;
  }
  async fetchBlocked(runtime, request) {
    let response = await transport(runtime, request.endpoint, { method: 'GET' });
    if (!response.ok) throw new Error('Site status request failed');
    let body = await response.json();
    return agentBlocked(body);
  }
};
const policy = new SitePolicy;
function checkSite(runtime, site, backend) { return policy.checkUrl(runtime, site, backend); }
async function enforce(runtime, site, backend) {
  let status = await checkSite(runtime, site, backend);
  if (status == null) return;
  if (status.result.blocked) throw new Error('Site status blocked');
}
`;

const pattern = parseSourceContext(patternSource).context!;
const guardedPattern = parseSourceContext(`
function bypass(runtime, check) { return false; }
function display(browser) { return browser?.name ?? 'synthetic'; }
function origin(site) { return new URL(site).origin; }
function log(event) { event(); }
class SiteError extends Error {}
const policy = class {
  async throwIfBlocksUrl(runtime, site, backend, browser, authorization = 'browser-origin-access') {
    if (bypass(runtime, 'check-url-site-status') || typeof site != 'string') return;
    let status = await this.checkUrl(runtime, site, backend);
    if (status == null) return;
    let { request, result } = status, label = display(browser), family = browser?.browserFamily;
    if (result.blocked) throw log(() => ({ authorization, backend, browserFamily: family, check: 'check-url-site-status', origin: origin(site) ?? void 0, permissionSource: 'site-status', outcome: 'denied', reason: 'site_status_blocked', ...result.cached ? { cached: true } : {} })), new SiteError('site_status_blocked', \`\${label} blocked on \${request.displayUrl}\`);
  }
};
`).context!;
const metadataPattern = parseSourceContext(`function getMetadata(runtime) {
  let value = runtime.requestMeta?.['x-codex-turn-metadata'];
  if (typeof value == 'string') try { value = JSON.parse(value); } catch { return; }
  if (!(value == null || typeof value != 'object' || Array.isArray(value))) return value;
}`).context!;
const callbackPattern = parseSourceContext(`
function checkSite(runtime, site, backend) { return policy.checkUrl(runtime, site, backend); }
const controller = { validate: async site => {
  if ((await checkSite(this.runtime, site, this.browserBackend))?.result.blocked)
    throw new SiteError('siteStatus', 'site_status_blocked', 'Blocked', { origin: origin(site) ?? void 0, source: 'site-status' });
} };
`).context!;
const assumptions = [
  'ES2022 module syntax; finite dedicated site-status transport, request builder, strict agent predicate and cache/blocked consumption family.',
  'Standard URL, Map, Date, Object, Reflect, Error and JSON interfaces retain their standard behavior; runtime.fetch and response.json honor their host contracts.',
  'Unrelated imported modules and host code do not maliciously mutate this local chain or standard capabilities; no arbitrary bundle/dependency proof is claimed.',
  'Bound error-message formatters receive only a literal string on the existing throwing path; their display behavior is opaque and assumed not to mutate closed chain or standard host capabilities.',
  'Finite terminal bypass/display/origin/log helpers and local Error constructors retain their original calls and return uses. Their presentation/telemetry behavior is not recursively audited; visible mutations of the chain or standard capabilities still reject.',
];

class Unsupported extends Error {
  constructor(readonly code: string, message: string, readonly node?: E.Node) { super(message); }
}

function need(value: unknown, code: string, message: string, node?: E.Node): asserts value {
  if (!value) throw new Unsupported(code, message, node);
}

function range(node: E.Node): Range {
  const located = node as E.Node & { start: number; end: number };
  return { start: located.start, end: located.end, unit: 'utf16' };
}

function inside(node: E.Node, owner: E.Node): boolean {
  return range(node).start >= range(owner).start && range(node).end <= range(owner).end;
}

function propertyIdentifier(node: E.Node, context: SourceContext): boolean {
  const parent = context.parents.get(node);
  return !!parent && (parent.type === 'MemberExpression' && parent.property === node && !parent.computed ||
    (parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') && parent.key === node && !parent.computed);
}

function booleanValue(node: E.Node): boolean | undefined {
  if (node.type === 'Literal' && typeof node.value === 'boolean') return node.value;
  if (node.type === 'UnaryExpression' && node.operator === '!' && node.argument.type === 'Literal' && (node.argument.value === 0 || node.argument.value === 1)) return !node.argument.value;
  return undefined;
}

function definition(binding: Variable): E.Node | null {
  const def = binding.defs[0];
  if (binding.defs.length !== 1 || !def) return null;
  return def.node;
}

/** An alpha-equivalent AST graph matcher with closed lexical references. */
class Match {
  readonly bindings = new Map<Variable, Variable>();
  readonly matched = new Set<E.Node>();
  readonly roots = new Map<string, E.Node>();
  private readonly pendingInitialization: E.Identifier[] = [];

  constructor(readonly context: SourceContext, readonly syntax: SourceContext = pattern) {}

  private node(expected: E.Node, actual: E.Node): void {
    const parent = this.syntax.parents.get(expected);
    if (expected.type === 'Literal' && typeof expected.value === 'string' && parent?.type === 'NewExpression' && parent.callee.type === 'Identifier' && parent.callee.name === 'Error' && actual.type === 'CallExpression') {
      need(actual.callee.type === 'Identifier' && actual.arguments.length === 1 && actual.arguments[0]?.type === 'Literal' && typeof actual.arguments[0].value === 'string', 'ERROR_FORMATTER', 'Error formatter must receive only one literal message.', actual);
      const binding = this.context.bindings.get(actual.callee);
      need(binding && definition(binding)?.type === 'FunctionDeclaration' && binding.references.every(ref => !ref.isWrite() || ref.init), 'ERROR_FORMATTER', 'Error formatter must be an unchanged local function.', actual);
      this.matched.add(actual);
      return;
    }
    const bool = booleanValue(expected);
    if (bool !== undefined && booleanValue(actual) === bool) { this.matched.add(actual); return; }
    need(expected.type === actual.type, 'UNSUPPORTED_STRUCTURE', `Expected ${expected.type}, found ${actual.type}.`, actual);
    this.matched.add(actual);
    if (expected.type === 'ClassBody' && actual.type === 'ClassBody' && this.syntax === pattern && actual.body.length === expected.body.length + 1) {
      const methods = actual.body.filter(node => node.type === 'MethodDefinition' && node.key.type === 'Identifier' && node.key.name === 'throwIfBlocksUrl');
      need(methods.length === 1, 'BLOCKED_CONSUMPTION', 'Only the finite guarded blocked-consumer extension is supported.', actual);
      const consumer = methods[0]!;
      const guarded = new Match(this.context, guardedPattern);
      const template = guardedPattern.nodes.find(node => node.type === 'MethodDefinition')!;
      guarded.node(template, consumer);
      for (const role of ['bypass', 'display', 'origin', 'log', 'SiteError']) {
        const helper = guarded.binding(role), declared = definition(helper);
        if (role === 'SiteError' && declared?.type === 'VariableDeclarator') {
          const writes = helper.references.filter(ref => ref.isWrite());
          const assignment = writes.length === 1 ? this.context.parents.get(writes[0]!.identifier) : null;
          const value = assignment?.type === 'VariableDeclarator' ? assignment.init : assignment?.type === 'AssignmentExpression' && assignment.operator === '=' ? assignment.right : null;
          need(value?.type === 'ClassExpression' && value.superClass?.type === 'Identifier' && value.superClass.name === 'Error' && !this.context.bindings.has(value.superClass), 'CONSUMER_HELPER', 'Terminal error class must have one local standard-Error initialization.', consumer);
          this.pendingInitialization.push(writes[0]!.identifier);
        } else need(declared && (declared.type === 'FunctionDeclaration' || role === 'SiteError' && declared.type === 'ClassDeclaration') && helper.references.every(ref => !ref.isWrite() || ref.init), 'CONSUMER_HELPER', 'Guarded consumer helpers must have unchanged local bindings.', consumer);
      }
      for (const node of guarded.matched) this.matched.add(node);
      this.roots.set('guardedConsumer', consumer);
      const remaining = actual.body.filter(node => node !== consumer);
      expected.body.forEach((node, index) => this.node(node, remaining[index]!));
      return;
    }
    if (expected.type === 'TemplateLiteral' && actual.type === 'TemplateLiteral' && this.syntax === guardedPattern) {
      need(expected.expressions.length === actual.expressions.length, 'CONSUMER_MESSAGE', 'Error message must retain the display and request fields.', actual);
      expected.expressions.forEach((node, index) => this.node(node, actual.expressions[index]!));
      return;
    }
    if (this.syntax === callbackPattern && expected.type === 'Identifier' && actual.type === 'Identifier' && ['SiteError', 'origin'].includes(expected.name) && !this.syntax.bindings.has(expected) && !propertyIdentifier(expected, this.syntax)) {
      const binding = this.context.bindings.get(actual), declared = binding && definition(binding);
      if (expected.name === 'SiteError' && declared?.type === 'VariableDeclarator' && binding) {
        const writes = binding.references.filter(ref => ref.isWrite()), assignment = writes.length === 1 ? this.context.parents.get(writes[0]!.identifier) : null;
        const value = assignment?.type === 'VariableDeclarator' ? assignment.init : assignment?.type === 'AssignmentExpression' && assignment.operator === '=' ? assignment.right : null;
        need(value?.type === 'ClassExpression' && value.superClass?.type === 'Identifier' && value.superClass.name === 'Error' && !this.context.bindings.has(value.superClass), 'CONSUMER_HELPER', 'Callback error needs one standard Error class initializer.', actual);
        this.pendingInitialization.push(writes[0]!.identifier);
      } else need(binding && declared && binding.references.every(ref => !ref.isWrite() || ref.init) && (expected.name === 'origin' ? declared.type === 'FunctionDeclaration' : declared.type === 'ClassDeclaration' || declared.type === 'FunctionDeclaration'), 'CONSUMER_HELPER', 'Callback terminal helper must be a stable local binding.', actual);
      return;
    }
    if (this.syntax === callbackPattern && expected.type === 'Literal' && actual.type === 'Literal' && expected.value === 'Blocked') {
      need(typeof actual.value === 'string', 'CONSUMER_MESSAGE', 'Callback error message must be literal.', actual);
      return;
    }
    if (expected.type === 'Identifier' && actual.type === 'Identifier') {
      if (propertyIdentifier(expected, this.syntax)) {
        need(expected.name === actual.name, 'UNSUPPORTED_INTERFACE', `Expected property ${expected.name}.`, actual);
        return;
      }
      const from = this.syntax.bindings.get(expected), to = this.context.bindings.get(actual);
      if (!from) {
        need(!to && expected.name === actual.name, 'SHADOWED_CAPABILITY', `Expected unshadowed ${expected.name}.`, actual);
        return;
      }
      need(to, 'UNKNOWN_BINDING', 'A related local binding is unresolved.', actual);
      const previous = this.bindings.get(from);
      need(previous ? previous === to : ![...this.bindings.values()].includes(to), 'MIXED_BINDING', 'Related values use different or merged lexical bindings.', actual);
      this.bindings.set(from, to);
      return;
    }
    if (expected.type === 'Literal' && actual.type === 'Literal') {
      const parent = this.syntax.parents.get(expected);
      const errorText = parent?.type === 'NewExpression' && parent.callee.type === 'Identifier' && parent.callee.name === 'Error';
      need(errorText ? typeof actual.value === 'string' : expected.value === actual.value, 'UNSUPPORTED_VALUE', 'A related literal differs from the finite pattern.', actual);
      return;
    }
    const left = expected as unknown as Record<string, unknown>;
    const right = actual as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(left)) {
      if (['start', 'end', 'range', 'loc', 'raw', 'shorthand', 'sourceFile'].includes(key)) continue;
      if (key === 'kind' && expected.type === 'VariableDeclaration') continue;
      const other = right[key];
      if (key === 'operator' && expected.type === 'BinaryExpression' && expected.operator === '!==' && expected.left.type === 'UnaryExpression' && expected.left.operator === 'typeof' && (other === '!=' || other === '!==')) continue;
      if (Array.isArray(value)) {
        need(Array.isArray(other) && value.length === other.length, 'UNSUPPORTED_STRUCTURE', 'Related statement, argument or property count changed.', actual);
        value.forEach((child: unknown, index) => this.value(child, other[index], actual));
      } else this.value(value, other, actual);
    }
  }

  private value(expected: unknown, actual: unknown, owner: E.Node): void {
    if (expected && typeof expected === 'object' && 'type' in expected) {
      need(actual && typeof actual === 'object' && 'type' in actual, 'UNSUPPORTED_STRUCTURE', 'Related syntax node is missing.', owner);
      this.node(expected as E.Node, actual as E.Node);
    } else if (expected && typeof expected === 'object') {
      need(actual && typeof actual === 'object', 'UNSUPPORTED_STRUCTURE', 'Related syntax value is missing.', owner);
      for (const [key, value] of Object.entries(expected)) {
        if (key !== 'raw') this.value(value, (actual as Record<string, unknown>)[key], owner);
      }
    } else need(expected === actual, 'UNSUPPORTED_STRUCTURE', 'Related syntax or control flow changed.', owner);
  }

  callback(actual: E.ArrowFunctionExpression, entry: Variable): void {
    const callback = new Match(this.context, callbackPattern);
    const templateEntry = callbackPattern.nodes.find(node => node.type === 'FunctionDeclaration')!;
    const binding = callbackPattern.bindings.get((templateEntry as E.FunctionDeclaration).id!)!;
    callback.bindings.set(binding, entry);
    callback.node(callbackPattern.nodes.find(node => node.type === 'ArrowFunctionExpression')!, actual);
    for (const [expected, value] of callback.bindings) {
      if (expected !== binding) for (const ref of value.references) need(callback.matched.has(ref.identifier), 'RELATED_ESCAPE', 'Callback input escapes its finite guard.', ref.identifier);
    }
    for (const node of callback.matched) this.matched.add(node);
    this.pendingInitialization.push(...callback.pendingInitialization);
  }

  match(name: string, actual: E.Node): void {
    const expected = this.syntax.nodes.find(node => node.type === 'FunctionDeclaration' && node.id?.name === name || node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.id.name === name);
    need(expected, 'INTERNAL_PATTERN', 'Missing finite pattern.');
    const target = expected.type === 'VariableDeclarator' && expected.init?.type === 'ClassExpression' ? expected.init : expected;
    this.node(target, actual);
    this.roots.set(name, actual);
  }

  binding(name: string): Variable {
    const expected = [...this.syntax.bindings.values()].find(binding => binding.name === name && binding.scope.type === 'module');
    const actual = expected && this.bindings.get(expected);
    need(actual, 'MISSING_CHAIN', `Missing related ${name} binding.`);
    return actual;
  }

  private initialized(identifier: E.Identifier): void {
    const parent = this.context.parents.get(identifier);
    const top = parent?.type === 'VariableDeclarator' ? this.context.parents.get(this.context.parents.get(parent)!) : null;
    if (top === this.context.program) {
      const instance = definition(this.binding('policy'));
      need(instance && range(parent!).end < range(instance).start, 'CONFIGURATION_INITIALIZATION', 'Direct configuration must be initialized before policy construction and consumption.', identifier);
      return;
    }
    const initializer = enclosing(this.context, identifier, 'ArrowFunctionExpression');
    need(initializer?.type === 'ArrowFunctionExpression', 'CONFIGURATION_INITIALIZATION', 'Configuration needs a top-level constant or finite once initializer.', identifier);
    let position: E.Node = identifier;
    while (this.context.parents.get(position)?.type === 'AssignmentExpression' || this.context.parents.get(position)?.type === 'SequenceExpression') position = this.context.parents.get(position)!;
    const assignmentStatement = this.context.parents.get(position);
    need(assignmentStatement?.type === 'ExpressionStatement' && this.context.parents.get(assignmentStatement) === initializer.body, 'CONFIGURATION_INITIALIZATION', 'Configuration assignment must be unconditional in its initializer.', identifier);
    need(initializer.body.type === 'BlockStatement' && initializer.body.body.slice(0, initializer.body.body.indexOf(assignmentStatement)).every(node => node.type === 'ExpressionStatement' && ['CallExpression', 'SequenceExpression', 'Literal'].includes(node.expression.type)), 'CONFIGURATION_INITIALIZATION', 'Initializer prefix has unknown or abrupt control flow before configuration assignment.', identifier);
    const creation = this.context.parents.get(initializer);
    need(creation?.type === 'CallExpression' && creation.arguments.length === 1 && creation.arguments[0] === initializer && creation.callee.type === 'Identifier', 'CONFIGURATION_INITIALIZATION', 'Deferred configuration must use a local once constructor.', initializer);
    const once = this.context.bindings.get(creation.callee), onceDefinition = once && definition(once);
    need(onceDefinition?.type === 'VariableDeclarator' && onceDefinition.init?.type === 'ArrowFunctionExpression', 'CONFIGURATION_INITIALIZATION', 'Unknown once constructor.', creation);
    // The finite once combinator is matched structurally, including task clearing.
    const parsed = parseSourceContext('const once = (task, value) => () => (task && (value = task(task = 0)), value);').context!;
    const canonical = parsed.nodes.find(node => node.type === 'ArrowFunctionExpression')!;
    const alpha = (expected: E.Node, actual: E.Node, names = new Map<string, string>()): boolean => {
      if (expected.type !== actual.type) return false;
      if (expected.type === 'Identifier' && actual.type === 'Identifier') {
        const previous = names.get(expected.name);
        if (previous) return previous === actual.name;
        if ([...names.values()].includes(actual.name)) return false;
        names.set(expected.name, actual.name); return true;
      }
      for (const [key, value] of Object.entries(expected)) {
        if (['start', 'end', 'range', 'loc', 'raw'].includes(key)) continue;
        const other = (actual as unknown as Record<string, unknown>)[key];
        if (Array.isArray(value)) {
          if (!Array.isArray(other) || other.length !== value.length || !value.every((item: E.Node, index) => alpha(item, other[index] as E.Node, names))) return false;
        } else if (value && typeof value === 'object' && 'type' in value) {
          if (!other || typeof other !== 'object' || !('type' in other) || !alpha(value as E.Node, other as E.Node, names)) return false;
        } else if (value !== other) return false;
      }
      return true;
    };
    need(alpha(canonical, onceDefinition.init), 'CONFIGURATION_INITIALIZATION', 'Once constructor differs from supported task-clearing semantics.', onceDefinition);
    need(once!.references.every(ref => ref.isRead() || ref.init), 'CONFIGURATION_INITIALIZATION', 'Once constructor is reassigned.', onceDefinition);
    const output = this.context.parents.get(creation);
    need(output?.type === 'VariableDeclarator' && output.id.type === 'Identifier', 'CONFIGURATION_INITIALIZATION', 'Initializer must have a local binding.', creation);
    const reachable = (binding: Variable, seen: Set<Variable>): boolean => {
      if (seen.has(binding)) return false;
      seen.add(binding);
      for (const ref of binding.references) {
        if (!ref.isRead()) { need(ref.init, 'CONFIGURATION_INITIALIZATION', 'Initializer binding is reassigned.', ref.identifier); continue; }
        const call = this.context.parents.get(ref.identifier);
        need(call?.type === 'CallExpression' && call.callee === ref.identifier && !call.arguments.length, 'CONFIGURATION_INITIALIZATION', 'Initializer escapes or has unknown arguments.', ref.identifier);
        const statement = this.context.parents.get(call);
        if (statement?.type === 'ExpressionStatement' && this.context.parents.get(statement) === this.context.program) {
          const instance = definition(this.binding('policy'));
          if (instance && range(statement).end < range(instance).start) return true;
        }
        const fn = enclosing(this.context, call, 'ArrowFunctionExpression');
        let direct: E.Node = call;
        while (this.context.parents.get(direct)?.type === 'SequenceExpression') direct = this.context.parents.get(direct)!;
        const directStatement = this.context.parents.get(direct);
        if (fn?.type !== 'ArrowFunctionExpression' || fn.body.type !== 'BlockStatement' || directStatement?.type !== 'ExpressionStatement' || this.context.parents.get(directStatement) !== fn.body) continue;
        const preceding = fn.body.body.slice(0, fn.body.body.indexOf(directStatement));
        if (!preceding.every(node => node.type === 'ExpressionStatement' && (node.expression.type === 'CallExpression' || node.expression.type === 'SequenceExpression' || node.expression.type === 'Literal'))) continue;
        const invoke = fn && this.context.parents.get(fn), declaration = invoke && this.context.parents.get(invoke);
        if (invoke?.type === 'CallExpression' && invoke.callee.type === 'Identifier' && this.context.bindings.get(invoke.callee) === once && declaration?.type === 'VariableDeclarator' && declaration.id.type === 'Identifier') {
          const outer = this.context.bindings.get(declaration.id);
          if (outer && reachable(outer, seen)) return true;
        }
      }
      return false;
    };
    const binding = this.context.bindings.get(output.id);
    need(binding && reachable(binding, new Set()), 'CONFIGURATION_INITIALIZATION', 'Configuration initializer is not reached by an unconditional module call.', identifier);
  }

  completeHelpers(): void {
    for (const identifier of this.pendingInitialization) this.initialized(identifier);
    for (const name of ['agentBlocked', 'enabled', 'isRecord', 'requestFor', 'localHost', 'displayUrl', 'endpointFor', 'getMetadata']) {
      const actual = definition(this.binding(name));
      need(actual?.type === 'FunctionDeclaration', 'UNKNOWN_HELPER', 'Related helper must be a local function declaration.', actual ?? undefined);
      if (name === 'getMetadata' && actual.body.body.length === 3) {
        const metadata = new Match(this.context, metadataPattern);
        metadata.match(name, actual);
        for (const node of metadata.matched) this.matched.add(node);
        for (const [expected, binding] of metadata.bindings) {
          if (expected.scope.type !== 'module') for (const ref of binding.references) need(metadata.matched.has(ref.identifier), 'METADATA_ESCAPE', 'Metadata value escapes its supported parser.', ref.identifier);
        }
        this.roots.set(name, actual);
      } else this.match(name, actual);
    }
    for (const [name, value] of [['baseUrl', 'https://chatgpt.com/backend-api'], ['agentKey', 'agent'], ['requestSource', 'codex_browser_use']] as const) {
      const binding = this.binding(name);
      const writes = binding.references.filter(ref => ref.isWrite());
      need(writes.length === 1, 'CONFIGURATION_WRITE', 'Related configuration needs exactly one constant initialization.');
      const identifier = writes[0]!.identifier;
      const parent = this.context.parents.get(identifier);
      const initializer = parent?.type === 'VariableDeclarator' ? parent.init : parent?.type === 'AssignmentExpression' && parent.operator === '=' ? parent.right : null;
      need(initializer?.type === 'Literal' && initializer.value === value, 'REQUEST_CONFIGURATION', 'Related configuration value is outside the finite pattern.', parent ?? identifier);
      this.initialized(identifier);
      this.matched.add(identifier);
    }
    const ttl = definition(this.binding('ttl'));
    need(ttl?.type === 'VariableDeclarator', 'CACHE_CONFIGURATION', 'Cache TTL must have a local constant initializer.');
    this.match('ttl', ttl);
  }

  private capabilityEffects(): void {
    const standards = new Set(['URL', 'Map', 'Date', 'Object', 'Reflect', 'JSON', 'Error']);
    const capabilities = new Set<Variable>(), globalAliases = new Set<Variable>();
    const globalRoot = (node: E.Node): boolean => node.type === 'Identifier' && (this.context.bindings.has(node) ? globalAliases.has(this.context.bindings.get(node)!) : ['globalThis', 'global', 'window', 'self'].includes(node.name));
    const root = (node: E.Node): boolean => {
      if (node.type === 'Identifier') {
        const binding = this.context.bindings.get(node);
        return binding ? capabilities.has(binding) : standards.has(node.name);
      }
      if (node.type === 'MemberExpression' && globalRoot(node.object)) {
        const key = node.computed ? node.property.type === 'Literal' ? node.property.value : null : node.property.type === 'Identifier' ? node.property.name : null;
        return key === null || standards.has(String(key));
      }
      return node.type === 'MemberExpression' && root(node.object);
    };
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of this.context.nodes) {
        if (node.type !== 'VariableDeclarator' || !node.init) continue;
        if (node.id.type === 'Identifier') {
          const binding = this.context.bindings.get(node.id);
          if (binding && root(node.init) && !capabilities.has(binding)) { capabilities.add(binding); changed = true; }
          if (binding && globalRoot(node.init) && !globalAliases.has(binding)) { globalAliases.add(binding); changed = true; }
        } else if (node.id.type === 'ObjectPattern' && (root(node.init) || globalRoot(node.init))) {
          for (const item of node.id.properties) {
            need(item.type === 'Property' && !item.computed && item.value.type === 'Identifier', 'CAPABILITY_ALIAS', 'Dynamic capability destructuring is unsupported.', item);
            const name = item.key.type === 'Identifier' ? item.key.name : item.key.type === 'Literal' ? item.key.value : null;
            if (globalRoot(node.init) && ['globalThis', 'global', 'window', 'self'].includes(String(name))) {
              const binding = this.context.bindings.get(item.value);
              if (binding && !globalAliases.has(binding)) { globalAliases.add(binding); changed = true; }
            }
            if (root(node.init) || standards.has(String(name))) {
              const binding = this.context.bindings.get(item.value);
              if (binding && !capabilities.has(binding)) { capabilities.add(binding); changed = true; }
            }
          }
        }
      }
    }
    for (const node of this.context.nodes) {
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && ['eval', 'Function'].includes(node.callee.name) && !this.context.bindings.has(node.callee)) throw new Unsupported('DYNAMIC_SCOPE', 'Dynamic code can mutate the related chain.', node);
      const written = node.type === 'AssignmentExpression' ? node.left : node.type === 'UpdateExpression' ? node.argument : node.type === 'UnaryExpression' && node.operator === 'delete' ? node.argument : null;
      need(!written || !root(written), 'CAPABILITY_MUTATION', 'Visible mutation of a standard capability or its alias is unsupported.', written ?? undefined);
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression') {
        const key = node.callee.computed ? node.callee.property.type === 'Literal' ? node.callee.property.value : null : node.callee.property.type === 'Identifier' ? node.callee.property.name : null;
        const reflective = ['defineProperty', 'defineProperties', 'setPrototypeOf', 'assign', 'set', 'deleteProperty'].includes(String(key));
        need(!reflective || !node.arguments.some(argument => root(argument)), 'CAPABILITY_MUTATION', 'Reflective modification of a related standard capability is unsupported.', node);
      }
      if (!this.matched.has(node) && node.type === 'CallExpression') {
        const inspect = node.callee.type === 'MemberExpression' && node.callee.object.type === 'Identifier' && !this.context.bindings.has(node.callee.object) && ['Object', 'Reflect'].includes(node.callee.object.name) && node.callee.property.type === 'Identifier' && ['getOwnPropertyDescriptor', 'getOwnPropertyDescriptors', 'getPrototypeOf', 'ownKeys', 'hasOwn', 'keys', 'values', 'entries', 'isFrozen'].includes(node.callee.property.name);
        need(inspect || !node.arguments.some(argument => root(argument)), 'CAPABILITY_ESCAPE', 'A standard capability escapes to an unknown local call.', node);
      }
    }
  }

  closeReferences(): void {
    this.capabilityEffects();
    for (const binding of this.bindings.values()) {
      for (const def of binding.defs) {
        let node: E.Node | undefined = def.node;
        while (node && node !== this.context.program) {
          need(node.type !== 'ExportNamedDeclaration' && node.type !== 'ExportDefaultDeclaration', 'RELATED_EXPORT', 'Related bindings cannot be exported to unknown consumers.', node);
          node = this.context.parents.get(node);
        }
      }
      for (const reference of binding.references) {
        need(this.matched.has(reference.identifier), 'RELATED_ESCAPE', 'A related binding has an additional use, assignment or escaped receiver.', reference.identifier);
      }
    }
  }
}

function enclosing(context: SourceContext, node: E.Node, type: E.Node['type']): E.Node | undefined {
  let current: E.Node | undefined = node;
  while (current && current.type !== type) current = context.parents.get(current);
  return current;
}

function prove(context: SourceContext, transport: E.FunctionDeclaration): { target: E.Node; evidence: Evidence[] } {
  const match = new Match(context);
  match.match('transport', transport);
  const references = match.binding('transport').references.filter(ref => ref.isRead());
  need(references.length === 1, 'TRANSPORT_CONSUMER', 'Dedicated transport must have exactly one local consumer.', transport);
  const owner = enclosing(context, references[0]!.identifier, 'ClassExpression');
  need(owner?.type === 'ClassExpression', 'RESPONSE_CONSUMER', 'Transport consumer must belong to the supported policy class.', references[0]!.identifier);
  match.match('SitePolicy', owner);
  const ownerDeclaration = context.parents.get(owner);
  need(ownerDeclaration?.type === 'VariableDeclarator' && ownerDeclaration.id.type === 'Identifier', 'POLICY_RECEIVER', 'Policy class needs a local binding.', owner);
  // Class binding is outside the class expression itself.
  const constructions = context.nodes.filter((node): node is E.NewExpression => node.type === 'NewExpression' && node.callee.type === 'Identifier' && context.bindings.get(node.callee) === context.bindings.get(ownerDeclaration.id));
  need(constructions.length === 1 && !constructions[0]!.arguments.length, 'POLICY_RECEIVER', 'Policy must have one default local instance.', owner);
  const instance = context.parents.get(constructions[0]!);
  need(instance?.type === 'VariableDeclarator', 'POLICY_RECEIVER', 'Policy instance must have a local binding.', constructions[0]);
  match.match('policy', instance);
  match.matched.add(ownerDeclaration.id);
  const entry = context.nodes.find((node): node is E.FunctionDeclaration => node.type === 'FunctionDeclaration' && node.body.body.some(statement => statement.type === 'ReturnStatement' && statement.argument?.type === 'CallExpression' && statement.argument.callee.type === 'MemberExpression' && statement.argument.callee.object.type === 'Identifier' && context.bindings.get(statement.argument.callee.object) === match.binding('policy')));
  const guardedConsumer = match.roots.get('guardedConsumer');
  need(entry || guardedConsumer, 'BLOCKED_CONSUMPTION', 'Policy needs its finite direct entry and blocking consumer.');
  let consumer: E.Node;
  if (guardedConsumer && !entry) {
    consumer = guardedConsumer;
    const policy = match.binding('policy');
    for (const ref of policy.references) {
      if (ref.isWrite()) continue;
      const member = context.parents.get(ref.identifier), call = member && context.parents.get(member);
      need(member?.type === 'MemberExpression' && member.object === ref.identifier && !member.computed && member.property.type === 'Identifier' && member.property.name === 'throwIfBlocksUrl' && call?.type === 'CallExpression' && call.callee === member, 'POLICY_RECEIVER', 'Instance escapes or uses an unknown method.', ref.identifier);
      match.matched.add(ref.identifier);
    }
  } else {
  match.match('checkSite', entry!);
  const entryReferences = match.binding('checkSite').references.filter(ref => ref.isRead());
  need(entryReferences.length === 1, 'BLOCKED_CONSUMPTION', 'Entry must have one finite blocking consumer.', entry);
  const arrowConsumer = enclosing(context, entryReferences[0]!.identifier, 'ArrowFunctionExpression');
  if (arrowConsumer?.type === 'ArrowFunctionExpression') {
    need(guardedConsumer, 'BLOCKED_CONSUMPTION', 'Callback family needs its corresponding guarded policy class.', arrowConsumer);
    match.callback(arrowConsumer, match.binding('checkSite'));
    consumer = arrowConsumer;
  } else {
  const externalConsumer = enclosing(context, entryReferences[0]!.identifier, 'FunctionDeclaration');
  need(externalConsumer?.type === 'FunctionDeclaration', 'BLOCKED_CONSUMPTION', 'Unknown blocking consumer.', entryReferences[0]!.identifier);
  consumer = externalConsumer;
  match.match('enforce', consumer);
  // Public invocation of the terminal operation is allowed; its local definition
  // cannot itself be replaced. All intermediate values have closed references.
  const terminal = match.binding('enforce');
  for (const ref of terminal.references) {
    const parent = context.parents.get(ref.identifier);
    need(ref.isRead() && parent?.type === 'CallExpression' && parent.callee === ref.identifier, 'RELATED_ESCAPE', 'Blocking operation is reassigned or escapes.', ref.identifier);
    match.matched.add(ref.identifier);
  }
  }
  }
  match.completeHelpers();
  match.closeReferences();
  const target = context.nodes.find(node => node.type === 'AwaitExpression' && inside(node, transport));
  need(target, 'NO_TARGET', 'Missing awaited transport expression.', transport);
  const evidence: Evidence[] = [
    { kind: 'source', range: range(match.roots.get('requestFor')!), description: 'Finite URL filtering, normalized cache key and site-status endpoint with conversation/turn/source provenance.' },
    { kind: 'transport', range: range(transport), description: 'Unique guarded member fetch preserves runtime receiver, endpoint, GET options and original await.' },
    { kind: 'response', range: range(owner), description: 'Same response supplies ok and awaited no-argument json; unchanged body reaches strict agent predicate.' },
    { kind: 'predicate', range: range(match.roots.get('enabled')!), description: 'Original predicate reads feature_status and the initialized agent key with strict true comparison; wrapper own-data constraints are separate.' },
    { kind: 'consumption', range: range(consumer), description: 'Blocked result flows through unchanged cache/inflight and a corresponding throwing guard.' },
    { kind: 'receiver', range: range(owner), description: 'Finite class state, default constructor, unique local instance and closed related lexical references.' },
  ];
  return { target, evidence };
}

/** Pure finite structural admission. Never reads files or executes the input. */
export function deriveCua(source: string): CuaDerivation {
  const base = { scheme: CUA_SCHEME, recipeVersion: 1 as const, runtime: 'not-verified' as const, assumptions };
  try {
    const parsed = parseSourceContext(source);
    need(parsed.context, 'PARSE_ERROR', parsed.parseError ?? 'Invalid JavaScript.');
    const context = parsed.context;
    const candidates = context.nodes.filter((node): node is E.FunctionDeclaration => node.type === 'FunctionDeclaration' && node.async === true && context.nodes.some(child => child.type === 'AwaitExpression' && inside(child, node) && child.argument.type === 'CallExpression' && child.argument.callee.type === 'MemberExpression' && !child.argument.callee.computed && child.argument.callee.property.type === 'Identifier' && child.argument.callee.property.name === 'fetch'));
    need(candidates.length, 'NO_TARGET', 'No dedicated awaited member-fetch transport found.');
    const proofs: ReturnType<typeof prove>[] = [];
    const failures: Unsupported[] = [];
    for (const candidate of candidates) {
      try { proofs.push(prove(context, candidate)); }
      catch (error) {
        if (!(error instanceof Unsupported)) throw error;
        const binding = candidate.id && context.bindings.get(candidate.id);
        const related = binding?.references.some(ref => {
          const owner = enclosing(context, ref.identifier, 'ClassExpression');
          return owner && context.nodes.some(node => inside(node, owner) && node.type === 'MemberExpression' && (node.computed ? node.property.type === 'Literal' && node.property.value === 'blocked' : node.property.type === 'Identifier' && node.property.name === 'blocked'));
        });
        if (related) failures.push(error);
      }
    }
    need(proofs.length <= 1, 'AMBIGUOUS_TARGET', 'Multiple complete dedicated site-status channels found.');
    if (!proofs.length) throw failures[0] ?? new Unsupported('NO_TARGET', 'No complete supported channel found.');
    need(!failures.length, 'UNPROVEN_CANDIDATE', 'Another plausible blocked-consumption channel is outside the supported family.', failures[0]?.node);
    const proof = proofs[0]!;
    const selected = range(proof.target), before = source.slice(selected.start, selected.end), after = wrapCuaResponse(before);
    const patchedSource = source.slice(0, selected.start) + after + source.slice(selected.end);
    parse(patchedSource, { ecmaVersion: 2022, sourceType: 'module' });
    return { ...base, support: 'supported', diagnostics: [], evidence: proof.evidence, change: { range: selected, before, after, patchedSource, localDiff: `Expression UTF-16 [${selected.start}, ${selected.end})\n- ${before}\n+ ${after}\n` } };
  } catch (error) {
    const failure = error instanceof Unsupported ? error : new Unsupported('PARSE_ERROR', error instanceof Error ? error.message : 'Unable to parse and bind source.');
    return { ...base, support: 'unsupported', evidence: [], diagnostics: [{ code: failure.code, severity: 'error', message: failure.message, ...(failure.node ? { range: range(failure.node) } : {}) }], change: null };
  }
}
