import type { Variable } from 'eslint-scope';
import type * as E from 'estree';
import type { SourceRange } from './analysis.js';

type Fn = E.FunctionDeclaration | E.FunctionExpression | E.ArrowFunctionExpression;
type Scalar = string | number | boolean | null | undefined;
type Value = Scalar | Data | Closure | Native | Ambient | Root | Factory;
interface Factory {kind: 'factory'; builder: Closure; cache?: Data; active?: boolean}
interface Data { kind: 'data'; fields: Map<string, Value>; getters: Map<string, Closure>; enumerable: Set<string>; prototype?: Data; class?: boolean }
interface Closure { kind: 'closure'; node: Fn; env: Map<Variable, Value> }
interface Native { kind: 'native'; name: string }
interface Ambient { kind: 'ambient' }
interface Root { kind: 'root'; name: string }
export interface AmbientPremise {
  identity: { id: 'statsig-initialization-property-effects'; version: 1 };
  basis: 'accepted-semantic-assumption';
  environment: 'not-verified';
  operations: {kind: 'root-read' | 'root-write' | 'name-read' | 'target-write'; key: string; range: SourceRange}[];
}
interface Context {
  binding(node: E.Node): Variable | undefined;
  parent(node: E.Node): E.Node | undefined;
  once(node: E.CallExpression): boolean;
  fail(message: string, node: E.Node): never;
}
const data = (): Data => ({kind: 'data', fields: new Map(), getters: new Map(), enumerable: new Set()});
const is = <K extends 'data' | 'closure' | 'native' | 'ambient' | 'root' | 'factory'>(value: Value, kind: K): value is Extract<Value, {kind: K}> => !!value && typeof value === 'object' && value.kind === kind;
const pos = (node: E.Node): SourceRange => { const n = node as E.Node & {start: number; end: number}; return {start: n.start, end: n.end, unit: 'utf16'}; };
const fn = (node: E.Node): node is Fn => ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type);

/** Private bounded abstract execution. No source evaluation, host lookup or I/O. */
export class AmbientInitializer {
  readonly premise: AmbientPremise = {identity: {id: 'statsig-initialization-property-effects', version: 1}, basis: 'accepted-semantic-assumption', environment: 'not-verified', operations: []};
  private readonly env = new Map<Variable, Value>();
  private readonly reads = new Set<E.Node>();
  private readonly writes = new Set<E.Node>();
  private readonly observed = new Set<Variable>();
  private readonly invoked = new Set<Fn>();
  private readonly writeback = new Set<string>();
  private readonly active = new Set<Variable>();
  private readonly ambient: Ambient = {kind: 'ambient'};
  private readonly ambientTarget: Ambient = {kind: 'ambient'};
  private readonly globalFallbacks = new Map<Fn, Variable>();
  private readonly globalGetters = new Set<Fn>();
  private steps = 0;
  constructor(private readonly context: Context) {}

  private fail(node: E.Node, message = 'Immediate initializer operation or receiver is outside the finite ambient proof.'): never { return this.context.fail(message, node); }
  private tick(node: E.Node): void { if (++this.steps > 50000) this.fail(node, 'Finite initializer proof budget exceeded.'); }
  private record(kind: AmbientPremise['operations'][number]['kind'], key: string, node: E.Node): void {
    if (!this.premise.operations.some(item => item.kind === kind && item.key === key && item.range.start === pos(node).start)) this.premise.operations.push({kind, key, range: pos(node)});
  }
  private variable(node: E.Node): Variable { const binding = this.context.binding(node) ?? this.fail(node, 'Initializer data must resolve to a private lexical binding.'); this.observed.add(binding); return binding; }
  private get(node: E.Identifier, env: Map<Variable, Value>): Value {
    const binding = this.context.binding(node);
    if (!binding) {
      if (['window', 'global', 'globalThis'].includes(node.name)) return {kind: 'root', name: node.name};
      if (node.name === '__STATSIG__') { this.record('name-read', '__STATSIG__', node); return this.ambient; }
      if (node.name === 'undefined') return undefined;
      if (['Object', 'Error'].includes(node.name)) return {kind: 'native', name: node.name};
      return this.fail(node, 'Unresolved initializer name is outside the exact approved ambient roots.');
    }
    this.reads.add(node); this.observed.add(binding);
    if (env.has(binding)) return env.get(binding);
    if (this.env.has(binding)) return this.env.get(binding);
    if (this.active.has(binding)) return this.fail(node, 'Initializer binding is read before its definition completes.');
    const definition = binding.defs[0]?.node;
    if (binding.defs.length !== 1) return this.fail(node);
    this.active.add(binding);
    let value: Value;
    if (definition?.type === 'FunctionDeclaration') value = {kind: 'closure', node: definition, env: this.env};
    else if (definition?.type === 'VariableDeclarator' && definition.init && this.context.parent(this.context.parent(definition)!)?.type === 'Program') value = this.evaluate(definition.init, this.env);
    else return this.fail(node, 'Initializer dependency has no established finite module definition.');
    this.active.delete(binding);
    this.env.set(binding, value);
    return value;
  }
  private set(node: E.Node, value: Value, env: Map<Variable, Value>): Value {
    if (node.type === 'Identifier') { const binding = this.variable(node); env.set(binding, value); this.writes.add(node); return value; }
    if (node.type !== 'MemberExpression' || node.optional) return this.fail(node);
    const receiver = this.evaluate(node.object, env), key = this.key(node, env);
    if (is(receiver, 'root') && key === '__STATSIG__' && value === this.ambient) { this.record('root-write', key, node); this.writeback.add(receiver.name); return value; }
    if (!is(receiver, 'data') || ['__proto__', 'prototype', 'constructor'].includes(key) || receiver.getters.has(key)) return this.fail(node, 'Unknown, accessor or special-key assignment is outside the exact premise.');
    receiver.fields.set(key, value); receiver.enumerable.add(key); return value;
  }
  private key(node: E.MemberExpression, env: Map<Variable, Value>): string {
    if (!node.computed && node.property.type === 'Identifier') return node.property.name;
    const value = this.evaluate(node.property, env);
    return typeof value === 'string' || typeof value === 'number' ? String(value) : this.fail(node, 'Unknown property key is outside the approved premise.');
  }
  private field(value: Value, key: string, node: E.Node): Value {
    if (is(value, 'root') && key === '__STATSIG__') { this.record('root-read', key, node); return this.ambient; }
    if (is(value, 'native')) return {kind: 'native', name: value.name + '.' + key};
    if (!is(value, 'data')) return this.fail(node, 'Property receiver has no finite own-data/getter provenance.');
    if (value.getters.has(key)) return this.invoke(value.getters.get(key)!, [], node);
    if (value.fields.has(key)) return value.fields.get(key);
    if (value.prototype) return this.field(value.prototype, key, node);
    return undefined;
  }
  private scalar(value: Value, node: E.Node): Scalar { return value && typeof value === 'object' ? this.fail(node, 'Unknown object coercion is outside the finite proof.') : value; }

  private selection(node: E.Node, env: Map<Variable, Value>): Value {
    const values: Value[] = [], roots: string[] = [];
    const gather = (item: E.Node): void => {
      if (item.type === 'LogicalExpression' && item.operator === '??') { gather(item.left); gather(item.right); return; }
      if (item.type === 'ConditionalExpression' && item.test.type === 'LogicalExpression' && item.test.operator === '&&') {
        const [nonNull, nonVoid] = [item.test.left, item.test.right];
        if (nonNull.type !== 'BinaryExpression' || nonNull.operator !== '!==' || nonNull.right.type !== 'Literal' || nonNull.right.value !== null || nonNull.left.type !== 'AssignmentExpression' || nonNull.left.operator !== '=' || nonNull.left.left.type !== 'Identifier' || nonVoid.type !== 'BinaryExpression' || nonVoid.operator !== '!==' || nonVoid.left.type !== 'Identifier' || this.context.binding(nonVoid.left) !== this.context.binding(nonNull.left.left) || nonVoid.right.type !== 'UnaryExpression' || nonVoid.right.operator !== 'void' || nonVoid.right.argument.type !== 'Literal' || item.consequent.type !== 'Identifier' || this.context.binding(item.consequent) !== this.context.binding(nonNull.left.left)) return this.fail(item);
        gather(nonNull.left.right); env.set(this.variable(nonNull.left.left), this.ambient); this.writes.add(nonNull.left.left); this.reads.add(nonVoid.left); this.reads.add(item.consequent); gather(item.alternate); return;
      }
      if (item.type === 'MemberExpression') {
        const root = this.evaluate(item.object, env);
        if (!is(root, 'root') || this.key(item, env) !== '__STATSIG__') return this.fail(item);
        roots.push(root.name);
      }
      values.push(this.evaluate(item, env));
    };
    gather(node);
    if (roots.join(',') !== 'window,global,globalThis' || values.length !== 4 || values.slice(0, -1).some(value => value !== this.ambient) || !is(values.at(-1), 'data')) return this.fail(node, 'Ambient selection must read only exact roots and end in a finite fresh fallback.');
    return this.ambient;
  }
  evaluate(node: E.Node, env = this.env): Value {
    this.tick(node);
    if (node.type === 'LogicalExpression' && node.operator === '??' || node.type === 'ConditionalExpression' && node.test.type === 'LogicalExpression' && node.test.operator === '&&' && node.test.left.type === 'BinaryExpression' && node.test.left.operator === '!==') return this.selection(node, env);
    switch (node.type) {
      case 'Literal': if ('regex' in node || 'bigint' in node) return this.fail(node); return node.value as Scalar;
      case 'Identifier': return this.get(node, env);
      case 'ArrowFunctionExpression': case 'FunctionExpression': return {kind: 'closure', node, env};
      case 'ObjectExpression': {
        const result = data();
        for (const item of node.properties) {
          if (item.type !== 'Property' || item.computed || item.kind !== 'init' || item.key.type !== 'Identifier' && item.key.type !== 'Literal') return this.fail(item);
          const key = item.key.type === 'Identifier' ? item.key.name : String(item.key.value);
          if (['__proto__', 'prototype', 'constructor'].includes(key)) return this.fail(item);
          result.fields.set(key, this.evaluate(item.value, env)); result.enumerable.add(key);
        }
        return result;
      }
      case 'ArrayExpression': { const result = data(); for (const [index, item] of node.elements.entries()) if (item) { result.fields.set(String(index), this.evaluate(item, env)); result.enumerable.add(String(index)); } return result; }
      case 'SequenceExpression': { let value: Value; for (const item of node.expressions) value = this.evaluate(item, env); return value; }
      case 'AssignmentExpression': if (node.operator !== '=') return this.fail(node); return this.set(node.left, this.evaluate(node.right, env), env);
      case 'MemberExpression': if (node.optional) return this.fail(node); return this.field(this.evaluate(node.object, env), this.key(node, env), node);
      case 'UnaryExpression': {
        const value = this.evaluate(node.argument, env);
        if (node.operator === 'typeof') return is(value, 'closure') || is(value, 'native') ? 'function' : value === null || typeof value === 'object' ? 'object' : typeof value;
        if (node.operator === '!') return !value;
        if (node.operator === 'void') return undefined;
        if (node.operator === '-') return -Number(this.scalar(value, node));
        return this.fail(node);
      }
      case 'LogicalExpression': {
        const left = this.evaluate(node.left, env);
        return node.operator === '&&' ? left ? this.evaluate(node.right, env) : left : node.operator === '||' ? left || this.evaluate(node.right, env) : left ?? this.evaluate(node.right, env);
      }
      case 'BinaryExpression': {
        const left = this.evaluate(node.left, env), right = this.evaluate(node.right, env);
        if (node.operator === 'in') { if (!is(right, 'data')) return this.fail(node); return right.fields.has(String(this.scalar(left, node))) || right.getters.has(String(left)); }
        if (['===', '!==', '==', '!='].includes(node.operator)) {
          if ((is(left, 'ambient') || is(right, 'ambient')) && !(left == null || right == null)) return this.fail(node);
          const equal = node.operator === '==' || node.operator === '!=' ? left == right : left === right;
          return node.operator === '!==' || node.operator === '!=' ? !equal : equal;
        }
        const a = this.scalar(left, node), b = this.scalar(right, node);
        if (node.operator === '<' && typeof a === 'string' && typeof b === 'string') return a < b;
        if (node.operator === '*' && typeof a === 'number' && typeof b === 'number') return a * b;
        return this.fail(node);
      }
      case 'ConditionalExpression': {
        const test = node.test;
        if (test.type === 'BinaryExpression' && test.operator === '<' && test.left.type === 'UnaryExpression' && test.left.operator === 'typeof' && test.left.argument.type === 'Identifier' && !this.context.binding(test.left.argument) && ['window', 'global', 'globalThis'].includes(test.left.argument.name)) {
          if (test.right.type !== 'Literal' || test.right.value !== 'u' || node.consequent.type !== 'Identifier' || node.consequent.name !== test.left.argument.name || this.context.binding(node.consequent) || node.alternate.type !== 'ObjectExpression' || node.alternate.properties.length) return this.fail(node, 'Ambient roots require the exact typeof selection and fresh empty absent branch.');
          return this.evaluate(node.consequent, env);
        }
        return this.evaluate(this.evaluate(node.test, env) ? node.consequent : node.alternate, env);
      }
      case 'ClassExpression': {
        const result = data(); result.class = true;
        if (node.superClass) { const base = this.evaluate(node.superClass, env); if (!is(base, 'data') || !base.class) return this.fail(node.superClass, 'Class inheritance requires a proven private class receiver.'); }
        const local = new Map(env); if (node.id) local.set(this.variable(node.id), result);
        for (const item of node.body.body) {
          if (item.type === 'StaticBlock' || item.computed) return this.fail(item);
          if (item.static && item.type === 'PropertyDefinition' && item.value) {
            const name = item.key.type === 'Identifier' ? item.key.name : this.fail(item);
            result.fields.set(name, this.evaluate(item.value, local));
          }
        }
        return result;
      }
      case 'NewExpression': {
        if (node.callee.type !== 'Identifier' || this.context.binding(node.callee) || !['Map', 'Set', 'TextEncoder'].includes(node.callee.name) || node.arguments.length) return this.fail(node, 'Only empty standard local collection/encoder allocation is supported.');
        return data();
      }
      case 'CallExpression': {
        if (node.optional || node.arguments.some(item => item.type === 'SpreadElement')) return this.fail(node);
        if (this.context.once(node)) return undefined;
        const callee = this.evaluate(node.callee, env), args = node.arguments.map(item => this.evaluate(item, env));
        if (is(callee, 'closure') && args.length === 1 && is(args[0], 'closure') && this.commonHelper(callee.node)) return {kind: 'factory', builder: args[0]};
        const result = this.invoke(callee, args, node);
        this.provedCalls.add(node);
        return result;
      }
      default: return this.fail(node);
    }
  }
  private commonHelper(node: Fn): boolean {
    if (node.type !== 'ArrowFunctionExpression' || node.async || node.params.length !== 2 || node.params[0]?.type !== 'Identifier' || node.params[1]?.type !== 'Identifier' || node.body.type !== 'ArrowFunctionExpression' || node.body.async || node.body.params.length || node.body.body.type !== 'SequenceExpression' || node.body.body.expressions.length !== 2) return false;
    const same = (a: E.Node | undefined, b: E.Node): boolean => !!a && a.type === 'Identifier' && this.context.binding(a) === this.context.binding(b);
    const [guard, result] = node.body.body.expressions;
    if (guard?.type !== 'LogicalExpression' || guard.operator !== '||' || !same(guard.left, node.params[1]) || guard.right.type !== 'CallExpression' || guard.right.optional || !same(guard.right.callee, node.params[0]) || guard.right.arguments.length !== 2 || !same(guard.right.arguments[1], node.params[1]) || result?.type !== 'MemberExpression' || result.computed || result.property.type !== 'Identifier' || result.property.name !== 'exports' || !same(result.object, node.params[1])) return false;
    const first = guard.right.arguments[0];
    if (first?.type !== 'MemberExpression' || first.computed || first.property.type !== 'Identifier' || first.property.name !== 'exports' || first.object.type !== 'AssignmentExpression' || first.object.operator !== '=' || !same(first.object.left, node.params[1]) || first.object.right.type !== 'ObjectExpression' || first.object.right.properties.length !== 1) return false;
    const exports = first.object.right.properties[0];
    return exports?.type === 'Property' && exports.kind === 'init' && !exports.computed && exports.key.type === 'Identifier' && exports.key.name === 'exports' && exports.value.type === 'ObjectExpression' && exports.value.properties.length === 0;
  }
  private invoke(value: Value, args: Value[], site: E.Node): Value {
    if (is(value, 'factory')) {
      if (args.length || value.active) return this.fail(site, 'CommonJS reentry observes partial exports and is outside the finite initialization proof.');
      if (!value.cache) {
        value.cache = data(); value.cache.fields.set('exports', data());
        value.active = true;
        this.invoke(value.builder, [value.cache.fields.get('exports'), value.cache].slice(0, value.builder.node.params.length), site);
        value.active = false;
      }
      return value.cache.fields.get('exports');
    }
    if (is(value, 'native')) return this.native(value.name, args, site);
    if (!is(value, 'closure') || value.node.async || value.node.generator || value.node.params.some(item => item.type !== 'Identifier') || args.length > value.node.params.length) return this.fail(site, 'Call requires a synchronous finite lexical function with exact arguments.');
    // The approved unresolved-name getter is the only caught operation. Its
    // catch cannot conceal failure of a once or a CommonJS initialization call.
    if (this.globalGetters.has(value.node)) {
      if (!['window', 'global', 'globalThis'].every(root => this.writeback.has(root))) return this.fail(site, 'Ambient getter requires completed writeback to all three approved roots.');
      if (value.env.get(this.globalFallbacks.get(value.node)!) !== this.ambient) return this.fail(site, 'Ambient getter fallback has no proven root-selection association.');
      this.record('name-read', '__STATSIG__', value.node); return this.ambientTarget;
    }
    this.invoked.add(value.node);
    const env = new Map(value.env);
    for (const [index, parameter] of value.node.params.entries()) env.set(this.variable(parameter), args[index]);
    if (value.node.body.type !== 'BlockStatement') return this.evaluate(value.node.body, env);
    for (const statement of value.node.body.body) if (statement.type === 'FunctionDeclaration' && statement.id) env.set(this.variable(statement.id), {kind: 'closure', node: statement, env});
    for (const statement of value.node.body.body) { const returned = this.statement(statement, env); if (returned) return returned.value; }
    return undefined;
  }
  private statement(node: E.Statement, env: Map<Variable, Value>): {value: Value} | undefined {
    this.tick(node);
    if (node.type === 'ExpressionStatement') { this.evaluate(node.expression, env); return; }
    if (node.type === 'FunctionDeclaration' || node.type === 'EmptyStatement') return;
    if (node.type === 'ReturnStatement') return {value: node.argument ? this.evaluate(node.argument, env) : undefined};
    if (node.type === 'VariableDeclaration') {
      for (const item of node.declarations) {
        if (item.id.type !== 'Identifier') return this.fail(item);
        const binding = this.variable(item.id);
        if (!env.has(binding)) env.set(binding, undefined);
        if (item.init) {
          this.recognizeGetter(item.init, env);
          env.set(binding, this.evaluate(item.init, env));
        }
      }
      return;
    }
    if (node.type === 'BlockStatement') { for (const item of node.body) { const result = this.statement(item, env); if (result) return result; } return; }
    if (node.type === 'IfStatement') { const branch = this.evaluate(node.test, env) ? node.consequent : node.alternate; return branch ? this.statement(branch, env) : undefined; }
    if (node.type === 'ForOfStatement' || node.type === 'ForInStatement') {
      const right = this.evaluate(node.right, env); if (!is(right, 'data')) return this.fail(node);
      const values = node.type === 'ForInStatement' ? [...right.enumerable] : [...right.fields.values()];
      if (node.left.type !== 'VariableDeclaration' || node.left.declarations.length !== 1 || node.left.declarations[0]?.id.type !== 'Identifier') return this.fail(node);
      for (const value of values) {
        const local = new Map(env); local.set(this.variable(node.left.declarations[0].id), value);
        const result = this.statement(node.body, local); if (result) return result;
      }
      return;
    }
    return this.fail(node, 'Branch, catch, loop or effect is outside the finite initializer grammar.');
  }
  private recognizeGetter(node: E.Node, env: Map<Variable, Value>): void {
    if (!fn(node) || node.async || node.generator || node.params.length || node.body.type !== 'BlockStatement' || node.body.body.length !== 1) return;
    const statement = node.body.body[0];
    if (statement?.type !== 'TryStatement' || statement.finalizer || statement.handler?.param || statement.block.body.length !== 1 || statement.handler?.body.body.length !== 1) return;
    const body = statement.block.body[0], caught = statement.handler.body.body[0];
    const choice = body?.type === 'ReturnStatement' ? body.argument : null;
    if (choice?.type !== 'ConditionalExpression' || choice.test.type !== 'BinaryExpression' || choice.test.operator !== '<' || choice.test.left.type !== 'UnaryExpression' || choice.test.left.operator !== 'typeof' || choice.test.left.argument.type !== 'Identifier' || choice.test.left.argument.name !== '__STATSIG__' || this.context.binding(choice.test.left.argument) || choice.test.right.type !== 'Literal' || choice.test.right.value !== 'u' || choice.consequent.type !== 'Identifier' || choice.consequent.name !== '__STATSIG__' || this.context.binding(choice.consequent) || choice.alternate.type !== 'Identifier' || caught?.type !== 'ReturnStatement' || caught.argument?.type !== 'Identifier' || this.context.binding(choice.alternate) !== this.context.binding(caught.argument)) return;
    this.globalGetters.add(node);
    this.globalFallbacks.set(node, this.variable(choice.alternate));
    this.reads.add(choice.alternate); this.reads.add(caught.argument);
    // The fallback binding is checked at invocation, after root writeback.
    void env;
  }
  private native(name: string, args: Value[], site: E.Node): Value {
    if (name === 'Object.create') { if (args.length !== 1 || args[0] !== null && !is(args[0], 'data')) return this.fail(site); return {...data(), ...(is(args[0], 'data') ? {prototype: args[0]} : {})}; }
    if (name === 'Object.getPrototypeOf') { if (args.length !== 1 || !is(args[0], 'data')) return this.fail(site); return args[0].prototype ?? null; }
    if (name === 'Object.prototype.hasOwnProperty.call') { if (args.length !== 2 || !is(args[0], 'data') || typeof args[1] !== 'string') return this.fail(site); return args[0].fields.has(args[1]) || args[0].getters.has(args[1]); }
    if (name === 'Object.getOwnPropertyNames' || name === 'Object.keys') {
      if (args.length !== 1 || !is(args[0], 'data')) return this.fail(site);
      const keys = name === 'Object.keys' ? [...args[0].enumerable] : [...new Set([...args[0].fields.keys(), ...args[0].getters.keys()])];
      const result = data(); keys.forEach((key, index) => result.fields.set(String(index), key)); return result;
    }
    if (name === 'Object.getOwnPropertyDescriptor') {
      if (args.length !== 2 || !is(args[0], 'data') || typeof args[1] !== 'string') return this.fail(site);
      const [target, key] = args; if (!target.fields.has(key) && !target.getters.has(key)) return undefined;
      const result = data(); result.fields.set('enumerable', target.enumerable.has(key));
      if (target.getters.has(key)) result.fields.set('get', target.getters.get(key)); else { result.fields.set('value', target.fields.get(key)); result.fields.set('writable', true); result.fields.set('configurable', true); }
      return result;
    }
    if (name === 'Object.defineProperty') {
      if (args.length !== 3 || !is(args[0], 'data') || typeof args[1] !== 'string' || !is(args[2], 'data') || ['__proto__', 'constructor', 'prototype'].includes(args[1])) return this.fail(site);
      const [target, key, descriptor] = args;
      if ([...descriptor.fields.keys()].some(key => !['value', 'get', 'enumerable', 'writable', 'configurable'].includes(key))) return this.fail(site);
      const getter = descriptor.fields.get('get');
      if (getter !== undefined) {
        if (!is(getter, 'closure') || descriptor.fields.has('value') || getter.node.params.length || getter.node.async || getter.node.generator) return this.fail(site);
        const body = getter.node.body;
        const expression = body.type === 'BlockStatement' && body.body.length === 1 && body.body[0]?.type === 'ReturnStatement' ? body.body[0].argument : body;
        if (expression?.type !== 'MemberExpression') return this.fail(site, 'Export getter must forward one proven property unchanged.');
        this.evaluate(expression, getter.env);
        target.getters.set(key, getter); target.fields.delete(key);
      }
      else { target.fields.set(key, descriptor.fields.get('value')); target.getters.delete(key); }
      if (descriptor.fields.get('enumerable')) target.enumerable.add(key); else target.enumerable.delete(key);
      return target;
    }
    if (name === 'Object.assign') {
      if (args.length !== 2 || args[0] !== this.ambientTarget || !is(args[1], 'data') || args[1].getters.size) return this.fail(site, 'Only exact approved ambient Object.assign operations are supported.');
      const keys = [...args[1].fields.keys()];
      if (!(keys.length === 2 && keys[0] === 'Log' && keys[1] === 'SDK_VERSION' || keys.length === 1 && keys[0] === 'StatsigClient')) return this.fail(site, 'Ambient assignment keys differ from the approved operations.');
      for (const key of keys) this.record('target-write', key, site);
      return this.ambientTarget;
    }
    return this.fail(site, 'Standard or foreign call is outside the finite initializer grammar.');
  }

  /** Close every evaluated lexical reference; no alias, mutation or escape waiver. */
  provedCall(node: E.Node): boolean { return this.provedCalls.has(node); }
  private readonly provedCalls = new Set<E.Node>();
  close(): void {
    for (const binding of new Set([...this.env.keys(), ...this.observed])) {
      for (const reference of binding.references) if (!reference.isWrite() && !this.reads.has(reference.identifier)) {
        let enclosing = this.context.parent(reference.identifier);
        while (enclosing && !fn(enclosing)) enclosing = this.context.parent(enclosing);
        // An unvisited branch of an actually interpreted synchronous invocation
        // is unreachable for that invocation. Nested deferred closures are not.
        if (!enclosing || !fn(enclosing) || !this.invoked.has(enclosing)) this.fail(reference.identifier, 'Finite initializer dependency has an unproved alias, deferred use or escape.');
      }
      for (const reference of binding.references) if (reference.isWrite() && !reference.init && !this.writes.has(reference.identifier)) this.fail(reference.identifier, 'Finite initializer dependency is reassigned outside the proved path.');
    }
  }
}
