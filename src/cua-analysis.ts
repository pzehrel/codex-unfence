import { parse } from 'acorn';
import type * as E from 'estree';
import type { Variable } from 'eslint-scope';
import { parseSourceContext } from './source-context.js';
import type { SourceContext } from './source-context.js';
import { CUA_SCHEME } from './cua-contract.js';
import type { CuaDerivation, Evidence, Range } from './cua-contract.js';
import { wrapCuaResponse } from './cua-recipe.js';

const assumptions = [
  'Local site-status endpoint provenance and response ok/json usage are checked; request construction, policy classes, cache and blocking consumers are not matched to a whole-chain template.',
  'Standard Object and Reflect interfaces retain their standard semantics; fetch/json honor their host contracts. Unrelated code and dependencies are assumed not to mutate these capabilities or the selected channel.',
  'Static local call and property relationships identify the channel; runtime loading, endpoint configuration and website behavior remain not-verified.',
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
function key(node: E.MemberExpression | E.Property | E.MethodDefinition): string | null {
  const property = node.type === 'MemberExpression' ? node.property : node.key;
  return !node.computed && property.type === 'Identifier' ? property.name : property.type === 'Literal' && typeof property.value === 'string' ? property.value : null;
}
type Fn = E.FunctionDeclaration | E.FunctionExpression | E.ArrowFunctionExpression;
function isFunction(node: E.Node): node is Fn {
  return ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type);
}

/** Bounded local provenance, independent of policy/cache/request-builder shapes. */
class LocalChannel {
  private readonly owned = new Map<E.Node, E.Node[]>();
  private readonly owners = new Map<E.Node, Fn>();
  private readonly calls = new Map<Fn, E.CallExpression[]>();
  constructor(readonly context: SourceContext) {
    for (const node of context.nodes) {
      let parent = context.parents.get(node);
      while (parent && !isFunction(parent)) parent = context.parents.get(parent);
      if (parent && isFunction(parent)) {
        this.owners.set(node, parent);
        const nodes = this.owned.get(parent) ?? [];
        nodes.push(node);
        this.owned.set(parent, nodes);
      }
    }
    for (const node of context.nodes) {
      if (node.type !== 'CallExpression') continue;
      const fn = this.callee(node);
      if (fn) {
        const calls = this.calls.get(fn) ?? [];
        calls.push(node);
        this.calls.set(fn, calls);
      }
    }
  }
  nodes(fn: Fn): E.Node[] { return this.owned.get(fn) ?? []; }
  owner(node: E.Node): Fn | undefined { return this.owners.get(node); }
  binding(node: E.Node): Variable | undefined { return this.context.bindings.get(node); }
  enclosingClass(node: E.Node): E.ClassExpression | E.ClassDeclaration | undefined {
    for (let parent = this.context.parents.get(node); parent; parent = this.context.parents.get(parent)) {
      if (parent.type === 'ClassExpression' || parent.type === 'ClassDeclaration') return parent;
    }
    return undefined;
  }
  callee(call: E.CallExpression): Fn | undefined {
    if (call.callee.type === 'Identifier') {
      const binding = this.binding(call.callee);
      if (!binding || binding.references.some(ref => ref.isWrite() && !ref.init)) return;
      const node = binding.defs[0]?.node;
      if (node?.type === 'FunctionDeclaration') return node;
      if (node?.type === 'VariableDeclarator' && node.init && isFunction(node.init)) return node.init;
    }
    if (call.callee.type === 'MemberExpression' && call.callee.object.type === 'ThisExpression') {
      const owner = this.enclosingClass(call), name = key(call.callee);
      const methods = owner?.body.body.filter((node): node is E.MethodDefinition => node.type === 'MethodDefinition' && key(node) === name && node.kind === 'method' && !node.static);
      if (methods?.length === 1) return methods[0]!.value;
    }
    return undefined;
  }
  usages(fn: Fn): E.CallExpression[] { return this.calls.get(fn) ?? []; }
  private initializers(binding: Variable): E.Node[] {
    return binding.references.filter(ref => ref.isWrite()).flatMap(ref => {
      const parent = this.context.parents.get(ref.identifier);
      if (parent?.type === 'VariableDeclarator' && parent.init) return [parent.init];
      if (parent?.type === 'AssignmentExpression' && parent.operator === '=') return [parent.right];
      return [];
    });
  }
  /** Track only the requested property, never every argument of an unknown call. */
  endpoint(node: E.Node, path: readonly string[] = [], seen = new Set<string>(), depth = 0): boolean {
    if (depth > 32) return false;
    const token = `${range(node).start}:${range(node).end}:${path.join('.')}`;
    if (seen.has(token)) return false;
    const next = new Set(seen).add(token);
    const follow = (value: E.Node, fields = path) => this.endpoint(value, fields, next, depth + 1);
    if (!path.length && node.type === 'Literal' && typeof node.value === 'string') return /(?:^|\/)aura\/site_status$/.test(node.value);
    if (!path.length && node.type === 'TemplateLiteral') return node.quasis.at(-1)?.value.cooked?.endsWith('/aura/site_status') === true;
    if (node.type === 'Identifier') {
      const binding = this.binding(node);
      if (!binding) return false;
      const writes = this.initializers(binding);
      if (writes.length === 1 && writes.every(value => follow(value))) return true;
      const def = binding.defs[0];
      if (def?.type === 'Parameter' && isFunction(def.node) && !binding.references.some(ref => ref.isWrite())) {
        const index = def.node.params.findIndex(param => param === def.name);
        if (index >= 0) return this.usages(def.node).some(call => {
          const argument = call.arguments[index];
          return argument && argument.type !== 'SpreadElement' && follow(argument);
        });
      }
    }
    if (node.type === 'MemberExpression') {
      const name = key(node);
      return name !== null && follow(node.object, [name, ...path]);
    }
    if (node.type === 'ObjectExpression' && path.length) {
      if (node.properties.some(property => property.type === 'SpreadElement' || property.computed)) return false;
      const properties = node.properties.filter((property): property is E.Property => property.type === 'Property' && property.kind === 'init' && key(property) === path[0]);
      return properties.length === 1 && follow(properties[0]!.value, path.slice(1));
    }
    const absent = (value: E.Node) => value.type === 'Literal' && value.value === null;
    if (node.type === 'ConditionalExpression') return (absent(node.consequent) || follow(node.consequent)) && (absent(node.alternate) || follow(node.alternate)) && !(absent(node.consequent) && absent(node.alternate));
    if (node.type === 'LogicalExpression') return follow(node.left) && follow(node.right);
    if (node.type === 'SequenceExpression') return !!node.expressions.at(-1) && follow(node.expressions.at(-1)!);
    if (node.type === 'AwaitExpression') return follow(node.argument);
    if (node.type === 'NewExpression' && !path.length && node.callee.type === 'Identifier' && node.callee.name === 'URL' && !this.binding(node.callee)) {
      return !!node.arguments[0] && follow(node.arguments[0]);
    }
    // URL.toString preserves the endpoint path after query parameters are set.
    if (node.type === 'CallExpression') {
      if (!path.length && node.callee.type === 'MemberExpression' && key(node.callee) === 'toString' && !node.arguments.length) return follow(node.callee.object);
      const fn = this.callee(node);
      if (fn) return this.nodes(fn).some(item => item.type === 'ReturnStatement' && item.argument && follow(item.argument));
    }
    return false;
  }
  /** A dedicated transport must return the original awaited member-fetch call. */
  transport(fn: Fn): E.AwaitExpression | undefined {
    const returns = this.nodes(fn).filter((node): node is E.ReturnStatement => node.type === 'ReturnStatement');
    if (returns.length !== 1) return;
    const target = returns[0]!.argument;
    if (target?.type !== 'AwaitExpression' || target.argument.type !== 'CallExpression') return;
    const call = target.argument;
    if (call.optional || call.callee.type !== 'MemberExpression' || call.callee.optional || key(call.callee) !== 'fetch' || call.arguments.some(argument => argument.type === 'SpreadElement')) return;
    return target;
  }
  response(call: E.CallExpression): { binding: Variable; json: E.CallExpression[] } {
    const awaited = this.context.parents.get(call), declaration = awaited && this.context.parents.get(awaited);
    need(awaited?.type === 'AwaitExpression' && declaration?.type === 'VariableDeclarator' && declaration.id.type === 'Identifier', 'RESPONSE_CONSUMER', 'Response must be awaited into a local binding.', call);
    const binding = this.binding(declaration.id);
    need(binding, 'RESPONSE_CONSUMER', 'Response binding is unresolved.', declaration);
    const json: E.CallExpression[] = [];
    let ok = false;
    for (const ref of binding.references) {
      if (ref.init && ref.isWrite() && ref.identifier === declaration.id) continue;
      need(ref.isRead() && !ref.isWrite(), 'RESPONSE_ESCAPE', 'Response cannot be reassigned.', ref.identifier);
      const member = this.context.parents.get(ref.identifier), use = member && this.context.parents.get(member);
      need(member?.type === 'MemberExpression' && member.object === ref.identifier && !member.optional, 'RESPONSE_ESCAPE', 'Response cannot escape its local ok/json consumers.', ref.identifier);
      if (key(member) === 'ok') {
        need(use?.type === 'UnaryExpression' && use.operator === '!' || use?.type === 'IfStatement' && use.test === member, 'RESPONSE_ESCAPE', 'Response ok must be read as a local condition.', member);
        ok = true;
      } else {
        need(key(member) === 'json' && use?.type === 'CallExpression' && use.callee === member && !use.optional && !use.arguments.length && this.context.parents.get(use)?.type === 'AwaitExpression', 'RESPONSE_INTERFACE', 'Wrapper supports only ok and awaited no-argument json().', member);
        json.push(use);
      }
    }
    need(ok && json.length === 1, 'RESPONSE_INTERFACE', 'Expected an ok check and one awaited json() consumer.', call);
    return { binding, json };
  }
  bodyUsesSiteStatus(json: E.CallExpression): boolean {
    const awaited = this.context.parents.get(json), declaration = awaited && this.context.parents.get(awaited);
    if (declaration?.type !== 'VariableDeclarator' || declaration.id.type !== 'Identifier') return false;
    const first = this.binding(declaration.id);
    if (!first) return false;
    const seen = new Set<Variable>();
    const visit = (binding: Variable, depth: number): boolean => {
      if (seen.has(binding) || depth > 8) return false;
      seen.add(binding);
      return binding.references.some(ref => {
        if (!ref.isRead()) return false;
        const parent = this.context.parents.get(ref.identifier);
        if (parent?.type === 'MemberExpression' && parent.object === ref.identifier && key(parent) === 'feature_status') return true;
        if (parent?.type === 'CallExpression') {
          const fn = this.callee(parent), index = parent.arguments.indexOf(ref.identifier);
          const param = fn?.params[index];
          const nested = param?.type === 'Identifier' ? this.binding(param) : undefined;
          return !!nested && visit(nested, depth + 1);
        }
        if (parent?.type === 'VariableDeclarator' && parent.init === ref.identifier && parent.id.type === 'Identifier') {
          const alias = this.binding(parent.id);
          return !!alias && visit(alias, depth + 1);
        }
        return false;
      });
    };
    return visit(first, 0);
  }
  wrapperScope(target: E.Node): void {
    const selected = range(target);
    for (const scope of this.context.scopeManager.scopes) {
      const block = range(scope.block);
      if (block.start <= selected.start && block.end >= selected.end) {
        need(!['Object', 'Reflect'].some(name => scope.set.has(name)), 'WRAPPER_BINDING', 'Wrapper Object/Reflect must resolve to host globals.', target);
      }
    }
  }
}

/** Pure local admission. Never executes the plugin or matches its policy/cache implementation. */
export function deriveCua(source: string): CuaDerivation {
  const base = { scheme: CUA_SCHEME, recipeVersion: 1 as const, runtime: 'not-verified' as const, assumptions };
  try {
    const parsed = parseSourceContext(source);
    need(parsed.context, 'PARSE_ERROR', parsed.parseError ?? 'Invalid JavaScript.');
    const context = parsed.context, local = new LocalChannel(context);
    const candidates: { target: E.AwaitExpression; call: E.CallExpression }[] = [];
    for (const node of context.nodes) {
      if (node.type !== 'CallExpression') continue;
      const fn = local.callee(node), target = fn && local.transport(fn);
      const direct = node.callee.type === 'MemberExpression' && key(node.callee) === 'fetch' && !node.optional && !node.callee.optional && context.parents.get(node)?.type === 'AwaitExpression';
      if (!target && !direct) continue;
      let endpointIndex = 0;
      if (target && fn && target.argument.type === 'CallExpression') {
        const endpoint = target.argument.arguments[0];
        const binding = endpoint?.type === 'Identifier' ? local.binding(endpoint) : undefined;
        endpointIndex = binding && !binding.references.some(ref => ref.isWrite()) ? fn.params.findIndex(param => param.type === 'Identifier' && local.binding(param) === binding) : -1;
      }
      const endpoint = node.arguments[endpointIndex];
      if (!endpoint || endpoint.type === 'SpreadElement' || !local.endpoint(endpoint)) continue;
      if (target) candidates.push({ target, call: node });
      // Direct awaited fetch is also a valid injection seam.
      if (direct) {
        candidates.push({ target: context.parents.get(node) as E.AwaitExpression, call: node });
      }
    }
    // A dedicated transport's own fetch is not a second response consumer.
    const external = candidates.filter(candidate => !candidates.some(other => other !== candidate && other.target === candidate.target && other.call !== candidate.call && local.owner(candidate.call) === local.owner(candidate.target)));
    const unique = new Set(external.map(candidate => candidate.target));
    need(unique.size, 'NO_TARGET', 'No local site-status fetch channel found.');
    need(unique.size === 1, 'AMBIGUOUS_TARGET', 'Multiple site-status fetch injection points found.');
    const target = external[0]!.target, transport = local.owner(target);
    if (transport && local.transport(transport) === target) {
      const selectedCalls = new Set(external.map(candidate => candidate.call));
      need(local.usages(transport).every(call => selectedCalls.has(call)), 'TRANSPORT_CONSUMER', 'Transport has consumers outside the identified site-status channel.', target);
      const declaration = context.parents.get(transport);
      const identifier = transport.type === 'FunctionDeclaration' ? transport.id : declaration?.type === 'VariableDeclarator' && declaration.id.type === 'Identifier' ? declaration.id : null;
      if (identifier) {
        const binding = local.binding(identifier);
        need(binding?.references.every(ref => {
          if (ref.isWrite() && ref.init) return true;
          const call = context.parents.get(ref.identifier);
          return ref.isRead() && call?.type === 'CallExpression' && call.callee === ref.identifier && selectedCalls.has(call);
        }), 'TRANSPORT_CONSUMER', 'Transport cannot escape its dedicated calls.', transport);
      } else need(declaration?.type !== 'MethodDefinition', 'TRANSPORT_CONSUMER', 'Shared method transports require an explicit local binding.', transport);
    }
    for (const candidate of external) {
      const response = local.response(candidate.call);
      need(local.bodyUsesSiteStatus(response.json[0]!), 'RESPONSE_BODY', 'Parsed response must reach a feature_status consumer.', candidate.call);
    }
    local.wrapperScope(target);
    const selected = range(target), before = source.slice(selected.start, selected.end), after = wrapCuaResponse(before);
    const patchedSource = source.slice(0, selected.start) + after + source.slice(selected.end);
    parse(patchedSource, { ecmaVersion: 2022, sourceType: 'module' });
    const evidence: Evidence[] = [
      { kind: 'source', range: range(external[0]!.call), description: 'Local argument provenance reaches the site-status endpoint; surrounding request construction is retained.' },
      { kind: 'transport', range: selected, description: 'One awaited member fetch is wrapped without changing its receiver, arguments or evaluation count.' },
      { kind: 'response', range: range(external[0]!.call), description: 'Response stays local and uses only ok and one awaited no-argument json(); parsed data reaches feature_status.' },
    ];
    return { ...base, support: 'supported', diagnostics: [], evidence, change: { range: selected, before, after, patchedSource, localDiff: `Expression UTF-16 [${selected.start}, ${selected.end})\n- ${before}\n+ ${after}\n` } };
  } catch (error) {
    const failure = error instanceof Unsupported ? error : new Unsupported('PARSE_ERROR', error instanceof Error ? error.message : 'Unable to analyze source.');
    return { ...base, support: 'unsupported', evidence: [], diagnostics: [{ code: failure.code, severity: 'error', message: failure.message, ...(failure.node ? { range: range(failure.node) } : {}) }], change: null };
  }
}
