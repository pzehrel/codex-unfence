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
const assumptions = [
  'ES2022 module syntax; finite dedicated site-status transport, request builder, strict agent predicate and cache/blocked consumption family.',
  'Standard URL, Map, Date, Object, Reflect, Error and JSON interfaces retain their standard behavior; runtime.fetch and response.json honor their host contracts.',
  'Unrelated imported modules and host code do not maliciously mutate this local chain or standard capabilities; no arbitrary bundle/dependency proof is claimed.',
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

  constructor(readonly context: SourceContext) {}

  private node(expected: E.Node, actual: E.Node): void {
    const bool = booleanValue(expected);
    if (bool !== undefined && booleanValue(actual) === bool) { this.matched.add(actual); return; }
    need(expected.type === actual.type, 'UNSUPPORTED_STRUCTURE', `Expected ${expected.type}, found ${actual.type}.`, actual);
    this.matched.add(actual);
    if (expected.type === 'Identifier' && actual.type === 'Identifier') {
      if (propertyIdentifier(expected, pattern)) {
        need(expected.name === actual.name, 'UNSUPPORTED_INTERFACE', `Expected property ${expected.name}.`, actual);
        return;
      }
      const from = pattern.bindings.get(expected), to = this.context.bindings.get(actual);
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
      const parent = pattern.parents.get(expected);
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

  match(name: string, actual: E.Node): void {
    const expected = pattern.nodes.find(node => node.type === 'FunctionDeclaration' && node.id?.name === name || node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.id.name === name);
    need(expected, 'INTERNAL_PATTERN', 'Missing finite pattern.');
    const target = expected.type === 'VariableDeclarator' && expected.init?.type === 'ClassExpression' ? expected.init : expected;
    this.node(target, actual);
    this.roots.set(name, actual);
  }

  binding(name: string): Variable {
    const expected = [...pattern.bindings.values()].find(binding => binding.name === name && binding.scope.type === 'module');
    const actual = expected && this.bindings.get(expected);
    need(actual, 'MISSING_CHAIN', `Missing related ${name} binding.`);
    return actual;
  }

  completeHelpers(): void {
    for (const name of ['agentBlocked', 'enabled', 'isRecord', 'requestFor', 'localHost', 'displayUrl', 'endpointFor', 'getMetadata']) {
      const actual = definition(this.binding(name));
      need(actual?.type === 'FunctionDeclaration', 'UNKNOWN_HELPER', 'Related helper must be a local function declaration.', actual ?? undefined);
      this.match(name, actual);
    }
    for (const [name, value] of [['baseUrl', 'https://chatgpt.com/backend-api'], ['agentKey', 'agent'], ['requestSource', 'codex_browser_use']] as const) {
      const binding = this.binding(name);
      const writes = binding.references.filter(ref => ref.isWrite());
      need(writes.length === 1, 'CONFIGURATION_WRITE', 'Related configuration needs exactly one constant initialization.');
      const identifier = writes[0]!.identifier;
      const parent = this.context.parents.get(identifier);
      const initializer = parent?.type === 'VariableDeclarator' ? parent.init : parent?.type === 'AssignmentExpression' && parent.operator === '=' ? parent.right : null;
      need(initializer?.type === 'Literal' && initializer.value === value, 'REQUEST_CONFIGURATION', 'Related configuration value is outside the finite pattern.', parent ?? identifier);
      this.matched.add(identifier);
    }
    const ttl = definition(this.binding('ttl'));
    need(ttl?.type === 'VariableDeclarator', 'CACHE_CONFIGURATION', 'Cache TTL must have a local constant initializer.');
    this.match('ttl', ttl);
  }

  closeReferences(): void {
    for (const binding of this.bindings.values()) {
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
  need(entry, 'BLOCKED_CONSUMPTION', 'Policy needs its finite direct entry and blocking consumer.');
  match.match('checkSite', entry);
  const entryReferences = match.binding('checkSite').references.filter(ref => ref.isRead());
  need(entryReferences.length === 1, 'BLOCKED_CONSUMPTION', 'Entry must have one finite blocking consumer.', entry);
  const consumer = enclosing(context, entryReferences[0]!.identifier, 'FunctionDeclaration');
  need(consumer?.type === 'FunctionDeclaration', 'BLOCKED_CONSUMPTION', 'Unknown blocking consumer.', entryReferences[0]!.identifier);
  match.match('enforce', consumer);
  match.completeHelpers();
  // Public invocation of the terminal operation is allowed; its local definition
  // cannot itself be replaced. All intermediate values have closed references.
  const terminal = match.binding('enforce');
  for (const ref of terminal.references) {
    const parent = context.parents.get(ref.identifier);
    need(ref.isRead() && parent?.type === 'CallExpression' && parent.callee === ref.identifier, 'RELATED_ESCAPE', 'Blocking operation is reassigned or escapes.', ref.identifier);
    match.matched.add(ref.identifier);
  }
  match.closeReferences();
  const target = context.nodes.find(node => node.type === 'AwaitExpression' && inside(node, transport));
  need(target, 'NO_TARGET', 'Missing awaited transport expression.', transport);
  const evidence: Evidence[] = [
    { kind: 'source', range: range(match.roots.get('requestFor')!), description: 'Finite URL filtering, normalized cache key and site-status endpoint with conversation/turn/source provenance.' },
    { kind: 'transport', range: range(transport), description: 'Unique guarded member fetch preserves runtime receiver, endpoint, GET options and original await.' },
    { kind: 'response', range: range(owner), description: 'Same response supplies ok and awaited no-argument json; unchanged body reaches strict agent predicate.' },
    { kind: 'predicate', range: range(match.roots.get('enabled')!), description: 'Own response chain uses feature_status and the initialized agent key with strict true comparison.' },
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
      catch (error) { if (error instanceof Unsupported) failures.push(error); else throw error; }
    }
    need(proofs.length <= 1, 'AMBIGUOUS_TARGET', 'Multiple complete dedicated site-status channels found.');
    if (!proofs.length) throw failures[0] ?? new Unsupported('NO_TARGET', 'No complete supported channel found.');
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
