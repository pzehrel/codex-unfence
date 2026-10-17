import { parse } from 'acorn';
import { analyze } from 'eslint-scope';
import type { Variable } from 'eslint-scope';
import type * as E from 'estree';
import type { AnalysisDiagnostic, SourceRange, StructuralEvidence } from './analysis.js';

type Fn = E.FunctionDeclaration | E.FunctionExpression | E.ArrowFunctionExpression;
interface SourceProof { evidence: StructuralEvidence[]; diagnostics: AnalysisDiagnostic[] }
const position = (node: E.Node): SourceRange => {
  const located = node as E.Node & { start: number; end: number };
  return { start: located.start, end: located.end, unit: 'utf16' };
};
function walk(node: E.Node, visit: (node: E.Node, parent?: E.Node) => void, parent?: E.Node): void {
  visit(node, parent);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) { for (const child of value) if (child?.type) walk(child as E.Node, visit, node); }
    else if (value && typeof value === 'object' && 'type' in value && typeof value.type === 'string') walk(value as E.Node, visit, node);
  }
}
function fn(node: E.Node | undefined | null): node is Fn { return node?.type === 'FunctionDeclaration' || node?.type === 'FunctionExpression' || node?.type === 'ArrowFunctionExpression'; }
function member(node: E.Node | undefined | null, name: string): node is E.MemberExpression {
  return node?.type === 'MemberExpression' && !node.optional && (node.computed ? node.property.type === 'Literal' && node.property.value === name : node.property.type === 'Identifier' && node.property.name === name);
}
function call(node: E.Node | undefined | null): node is E.CallExpression { return node?.type === 'CallExpression' && !node.optional; }
function body(node: Fn): E.Statement[] { return node.body.type === 'BlockStatement' ? node.body.body : []; }

/** No capability exception is granted by this partial structural proof. */
export function proveDependencySource(source: string): SourceProof {
  const proof: SourceProof = { evidence: [], diagnostics: [] };
  let program: E.Program;
  try { program = parse(source, { ecmaVersion: 2022, sourceType: 'module', ranges: true }) as unknown as E.Program; }
  catch { proof.diagnostics.push({ code: 'DEPENDENCY_SOURCE_PARSE', severity: 'error', message: 'Dependency source must parse as an ECMAScript module.' }); return proof; }
  const graph = new SourceGraph(program);
  const fail = (code: string, message: string, node: E.Node): SourceProof => { proof.diagnostics.push({ code, severity: 'error', message, range: position(node) }); return proof; };
  const loaders = graph.nodes.filter((node): node is Fn => fn(node) && graph.loader(node));
  if (loaders.length !== 1) return fail('DEPENDENCY_LOADER_UNPROVEN', 'A unique finite adjacent-resource loader with an explicit fallback branch has not been proven.', loaders[1] ?? program);
  const loader = loaders[0]!;
  proof.evidence.push({ kind: 'source', range: position(loader), description: 'Finite loader reads the adjacent zxing_reader.wasm through the same filesystem receiver; only a thrown read selects the explicit fallback. Evidence selects the adjacent success route only.' });
  const initializers = graph.nodes.flatMap(node => fn(node) ? graph.initialization(node, loader) ?? [] : []);
  if (initializers.length !== 1) return fail('DEPENDENCY_INITIALIZATION_UNPROVEN', 'Loader recognition alone does not prove byte copying, private initialization state or decode-before-use ordering.', loader);
  const initialization = initializers[0]!;
  proof.evidence.push({ kind: 'initialization', range: position(initialization.node), description: 'Finite memoized loader callback syntax creates a new Uint8Array copy and passes only its buffer through a fresh wasmBinary override object to the direct initializer wrapper. Binding mutation, reference closure, inherited options and lifetime are separate obligations.' });
  const cache = graph.cache(initialization.wrapper);
  if (!cache) return fail('DEPENDENCY_CACHE_UNPROVEN', 'The initializer wrapper must replace default options in a private WeakMap; every cache operation must match the finite replacement grammar.', initialization.wrapper);
  const privateEscape = graph.cacheEscape(cache);
  if (privateEscape) return fail('DEPENDENCY_PRIVATE_STATE_ESCAPE', 'WeakMap state may only be accessed by the matched cache operations; aliases, extra accesses, writes and exports are unproven.', privateEscape);
  proof.evidence.push({ kind: 'cache', range: position(cache), description: 'Finite WeakMap cache syntax replaces selected overrides rather than merging, reuses a module only through its equality parameter, and invokes initialization with a new spread object. WeakMap references close over these operations. Equality/default provenance, other binding references and inherited options remain unproven.' });
  const glueEffect = graph.prototypeEffect(initialization.factory);
  if (glueEffect) return fail('DEPENDENCY_GLUE_EFFECT_UNPROVEN', 'A directly reached JavaScript glue operation writes a prototype. Class/instance privacy and installed method effects need a finite proof; the resource contract does not cover this JavaScript write.', glueEffect);
  return fail('DEPENDENCY_LIFETIME_UNPROVEN', 'Private cache references, all decode callsites, inherited hooks and the resource import consumer graph remain unproven.', cache);
}

class SourceGraph {
  readonly nodes: E.Node[] = [];
  readonly parents = new Map<E.Node, E.Node>();
  readonly bindings = new Map<E.Node, Variable>();
  constructor(readonly program: E.Program) {
    const scopes = analyze(program, { ecmaVersion: 2022, sourceType: 'module', optimistic: false, ignoreEval: false });
    for (const scope of scopes.scopes) for (const variable of scope.variables) {
      for (const identifier of variable.identifiers) this.bindings.set(identifier, variable);
      for (const reference of variable.references) this.bindings.set(reference.identifier, variable);
    }
    walk(program, (node, parent) => { this.nodes.push(node); if (parent) this.parents.set(node, parent); });
  }
  same(a: E.Node | undefined | null, b: E.Node | undefined | null): boolean {
    return a?.type === 'Identifier' && b?.type === 'Identifier' && !!this.bindings.get(a) && this.bindings.get(a) === this.bindings.get(b);
  }
  standard(node: E.Node, name: string): boolean { return node.type === 'Identifier' && node.name === name && !this.bindings.has(node); }
  definition(node: E.Node): Fn | null {
    const binding = this.bindings.get(node);
    if (!binding || binding.defs.length !== 1) return null;
    const definition = binding.defs[0]!.node;
    return fn(definition) ? definition : definition.type === 'VariableDeclarator' && fn(definition.init) ? definition.init : null;
  }
  property(node: E.Node | undefined, name: string): E.Expression | null {
    if (node?.type !== 'ObjectExpression' || node.properties.length !== 1) return null;
    const property = node.properties[0];
    return property?.type === 'Property' && !property.computed && !property.method && property.kind === 'init' && property.key.type === 'Identifier' && property.key.name === name && property.value.type !== 'AssignmentPattern' ? property.value as E.Expression : null;
  }
  initialization(node: Fn, loader: Fn): { node: Fn; wrapper: Fn; factory: Fn } | null {
    if (!node.async || node.generator || this.parents.get(node) !== this.program || node.params.length !== 1 || node.params[0]?.type !== 'Identifier') return null;
    const statements = body(node);
    // Accommodate the minifier's sequence and the equivalent two statements.
    const operations = statements.flatMap(statement => statement.type === 'ExpressionStatement' ? statement.expression.type === 'SequenceExpression' ? statement.expression.expressions : [statement.expression] : []);
    const [guard, wait] = operations;
    if (statements.some(statement => statement.type !== 'ExpressionStatement') || operations.length !== 2 || guard?.type !== 'LogicalExpression' || guard.operator !== '&&' || guard.left.type !== 'BinaryExpression' || guard.left.operator !== '==' || guard.left.right.type !== 'Literal' || guard.left.right.value !== null || guard.left.left.type !== 'Identifier' || guard.right.type !== 'AssignmentExpression' || guard.right.operator !== '=' || !this.same(guard.left.left, guard.right.left) || wait?.type !== 'AwaitExpression' || !this.same(wait.argument, guard.left.left)) return null;
    const promise = guard.right.right;
    if (!call(promise) || !member(promise.callee, 'then') || !call(promise.callee.object) || this.definition(promise.callee.object.callee) !== loader || promise.callee.object.arguments.length !== 1 || !this.same(promise.callee.object.arguments[0], node.params[0]) || promise.arguments.length !== 1 || !fn(promise.arguments[0])) return null;
    const callback = promise.arguments[0];
    if (callback.async || callback.generator || callback.params.length !== 1 || callback.params[0]?.type !== 'Identifier') return null;
    const callbackBody = body(callback), declaration = callbackBody[0];
    if (callbackBody.length !== 2 || declaration?.type !== 'VariableDeclaration' || declaration.declarations.length !== 1) return null;
    const copy = declaration.declarations[0];
    if (!copy || copy.id.type !== 'Identifier' || copy.init?.type !== 'NewExpression' || !this.standard(copy.init.callee, 'Uint8Array') || copy.init.arguments.length !== 1 || !member(copy.init.arguments[0], 'byteLength') || !this.same(copy.init.arguments[0].object, callback.params[0])) return null;
    const operation = callbackBody[1];
    const sequence = operation?.type === 'ExpressionStatement' && operation.expression.type === 'SequenceExpression' ? operation.expression.expressions : [];
    const [set, configure] = sequence;
    if (sequence.length !== 2 || !call(set) || !member(set.callee, 'set') || !this.same(set.callee.object, copy.id) || set.arguments.length !== 1 || !this.same(set.arguments[0], callback.params[0]) || !call(configure) || configure.arguments.length !== 1) return null;
    const binary = this.property(this.property(configure.arguments[0], 'overrides') ?? undefined, 'wasmBinary');
    if (!member(binary, 'buffer') || !this.same(binary.object, copy.id)) return null;
    const wrapper = this.definition(configure.callee), wrapperBody = wrapper ? body(wrapper) : [];
    const forwarding = wrapperBody[0]?.type === 'ReturnStatement' ? wrapperBody[0].argument : null;
    if (!wrapper || wrapper.async || wrapper.params.length !== 1 || wrapper.params[0]?.type !== 'Identifier' || wrapperBody.length !== 1 || !call(forwarding) || forwarding.arguments.length !== 2 || !this.same(forwarding.arguments[1], wrapper.params[0]) || !forwarding.arguments[0] || !fn(this.definition(forwarding.arguments[0]))) return null;
    return { node, wrapper, factory: this.definition(forwarding.arguments[0])! };
  }
  // Counterexample discovery only, never an acceptance analysis. Follow direct
  // calls, skip deferred callback bodies, and report a concrete unproved write.
  // Absence of a found write does not establish a complete reachable graph.
  prototypeEffect(factory: Fn): E.Node | null {
    const seen = new Set<Fn>();
    const inspect = (node: E.Node, owner: Fn): E.Node | null => {
      if (fn(node) && node !== owner) return null;
      if (call(node)) {
        if (member(node.callee, 'assign') && this.standard(node.callee.object, 'Object') && member(node.arguments[0], 'prototype')) return node;
        const target = this.definition(node.callee);
        if (target && !seen.has(target)) { seen.add(target); const effect = inspect(target.body, target); if (effect) return effect; }
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
          for (const child of value) if (child?.type) { const effect = inspect(child as E.Node, owner); if (effect) return effect; }
        } else if (value && typeof value === 'object' && 'type' in value && typeof value.type === 'string') {
          const effect = inspect(value as E.Node, owner); if (effect) return effect;
        }
      }
      return null;
    };
    seen.add(factory);
    return inspect(factory.body, factory);
  }
  cacheEscape(helper: Fn): E.Node | null {
    let state: E.Node | undefined;
    walk(helper.body, node => {
      if (call(node) && member(node.callee, 'get')) {
        const declaration = this.bindings.get(node.callee.object)?.defs[0]?.node;
        if (declaration?.type === 'VariableDeclarator' && declaration.init?.type === 'NewExpression' && this.standard(declaration.init.callee, 'WeakMap')) state ??= node.callee.object;
      }
    });
    const binding = state ? this.bindings.get(state) : undefined;
    if (!binding) return helper;
    for (const reference of binding.references) {
      if (reference.isWrite()) { if (!reference.init) return reference.identifier; continue; }
      const parent = this.parents.get(reference.identifier), invocation = parent ? this.parents.get(parent) : undefined;
      if (!parent || !(member(parent, 'get') || member(parent, 'set')) || parent.object !== reference.identifier || !call(invocation) || invocation.callee !== parent) return reference.identifier;
      let ancestor: E.Node | undefined = invocation;
      while (ancestor && ancestor !== helper && ancestor !== this.program) ancestor = this.parents.get(ancestor);
      if (ancestor !== helper) return reference.identifier;
    }
    return null;
  }
  cache(wrapper: Fn): Fn | null {
    const forward = body(wrapper)[0];
    const forwarding = forward?.type === 'ReturnStatement' ? forward.argument : null;
    const helper = call(forwarding) ? this.definition(forwarding.callee) : null;
    if (!helper || helper.async || helper.generator || helper.params.length !== 2 || helper.params[0]?.type !== 'Identifier') return null;
    const options = helper.params[1];
    if (options?.type !== 'AssignmentPattern' || options.right.type !== 'ObjectExpression' || options.right.properties.length || options.left.type !== 'ObjectPattern' || options.left.properties.length !== 3) return null;
    const [override, equality, immediate] = options.left.properties;
    const option = (item: E.Property | E.RestElement | undefined, name: string): item is E.Property => item?.type === 'Property' && !item.computed && !item.method && item.kind === 'init' && item.key.type === 'Identifier' && item.key.name === name;
    if (!option(override, 'overrides') || override.value.type !== 'Identifier' || !option(equality, 'equalityFn') || equality.value.type !== 'AssignmentPattern' || equality.value.left.type !== 'Identifier' || !option(immediate, 'fireImmediately') || immediate.value.type !== 'AssignmentPattern' || immediate.value.left.type !== 'Identifier') return null;
    const defaultFalse = immediate.value.right;
    if (!(defaultFalse.type === 'Literal' && defaultFalse.value === false || defaultFalse.type === 'UnaryExpression' && defaultFalse.operator === '!' && defaultFalse.argument.type === 'Literal' && defaultFalse.argument.value === 1)) return null;
    const statements = body(helper), declarations = statements[1], branch = statements[2], tail = statements[3];
    if (statements.length !== 4 || statements[0]?.type !== 'VariableDeclaration' || statements[0].declarations.length !== 2 || statements[0].declarations.some(item => item.id.type !== 'Identifier' || item.init) || declarations?.type !== 'VariableDeclaration' || declarations.declarations.length !== 3) return null;
    const [cached, selected, equal] = declarations.declarations;
    const previous = statements[0].declarations[0]!.id, comparison = statements[0].declarations[1]!.id;
    if (!cached || cached.id.type !== 'ArrayPattern' || cached.id.elements.length !== 2 || cached.id.elements.some(item => item?.type !== 'Identifier') || cached.init?.type !== 'ConditionalExpression' || !selected || selected.id.type !== 'Identifier' || !equal || equal.id.type !== 'Identifier' || equal.init) return null;
    const [saved, module] = cached.id.elements;
    const conditional = cached.init, test = conditional.test;
    if (test.type !== 'BinaryExpression' || test.operator !== '==' || test.right.type !== 'Literal' || test.right.value !== null || test.left.type !== 'AssignmentExpression' || test.left.operator !== '=' || !this.same(test.left.left, previous) || !call(test.left.right) || !member(test.left.right.callee, 'get') || test.left.right.arguments.length !== 1 || !this.same(test.left.right.arguments[0], helper.params[0]) || conditional.consequent.type !== 'ArrayExpression' || conditional.consequent.elements.length !== 1 || conditional.consequent.elements[0]?.type !== 'Identifier' || !this.same(conditional.alternate, previous)) return null;
    const map = test.left.right.callee.object, binding = this.bindings.get(map), declaration = binding?.defs[0]?.node;
    if (!binding || binding.defs.length !== 1 || declaration?.type !== 'VariableDeclarator' || declaration.init?.type !== 'NewExpression' || !this.standard(declaration.init.callee, 'WeakMap') || declaration.init.arguments.length) return null;
    const selectedValue = selected.init;
    if (selectedValue?.type !== 'LogicalExpression' || selectedValue.operator !== '??' || !this.same(selectedValue.left, override.value) || !this.same(selectedValue.right, saved) || branch?.type !== 'IfStatement' || branch.alternate || !this.same(branch.test, immediate.value.left) || branch.consequent.type !== 'BlockStatement') return null;
    const set = (node: E.Node | undefined, values: (E.Node | null | undefined)[]): boolean => call(node) && member(node.callee, 'set') && this.same(node.callee.object, map) && node.arguments.length === 2 && this.same(node.arguments[0], helper.params[0]) && node.arguments[1]?.type === 'ArrayExpression' && node.arguments[1].elements.length === values.length && node.arguments[1].elements.every((item, index) => this.same(item, values[index]));
    const compare = (node: E.Node | undefined | null): boolean => call(node) && this.same(node.callee, equality.value.type === 'AssignmentPattern' ? equality.value.left : null) && node.arguments.length === 2 && this.same(node.arguments[0], saved) && this.same(node.arguments[1], selected.id);
    const [reuse, ready, returned] = branch.consequent.body;
    const reuseTest = reuse?.type === 'IfStatement' ? reuse.test : null;
    if (branch.consequent.body.length !== 3 || reuse?.type !== 'IfStatement' || reuse.alternate || reuseTest?.type !== 'LogicalExpression' || reuseTest.operator !== '&&' || !this.same(reuseTest.left, module) || reuseTest.right.type !== 'AssignmentExpression' || reuseTest.right.operator !== '=' || !this.same(reuseTest.right.left, equal.id) || !compare(reuseTest.right.right) || reuse.consequent.type !== 'ReturnStatement' || !this.same(reuse.consequent.argument, module) || ready?.type !== 'VariableDeclaration' || ready.declarations.length !== 1) return null;
    const initialized = ready.declarations[0];
    if (!initialized || initialized.id.type !== 'Identifier' || !call(initialized.init) || !this.same(initialized.init.callee, helper.params[0]) || initialized.init.arguments.length !== 1 || initialized.init.arguments[0]?.type !== 'ObjectExpression' || initialized.init.arguments[0].properties.length !== 1 || initialized.init.arguments[0].properties[0]?.type !== 'SpreadElement' || !this.same(initialized.init.arguments[0].properties[0].argument, selected.id) || returned?.type !== 'ReturnStatement' || returned.argument?.type !== 'SequenceExpression' || returned.argument.expressions.length !== 2 || !set(returned.argument.expressions[0], [selected.id, initialized.id]) || !this.same(returned.argument.expressions[1], initialized.id)) return null;
    if (tail?.type !== 'ExpressionStatement' || tail.expression.type !== 'LogicalExpression' || tail.expression.operator !== '||' || !set(tail.expression.right, [selected.id])) return null;
    const condition = tail.expression.left;
    if (condition.type !== 'ConditionalExpression' || condition.test.type !== 'BinaryExpression' || condition.test.operator !== '==' || condition.test.right.type !== 'Literal' || condition.test.right.value !== null || condition.test.left.type !== 'AssignmentExpression' || condition.test.left.operator !== '=' || !this.same(condition.test.left.left, comparison) || !this.same(condition.test.left.right, equal.id) || !compare(condition.consequent) || !this.same(condition.alternate, comparison)) return null;
    return helper;
  }
  loader(node: Fn): boolean {
    if (!node.async || node.generator || node.params.length !== 1 || node.params[0]?.type !== 'Identifier' || this.parents.get(node) !== this.program) return false;
    const statements = body(node), statement = statements[0];
    if (statements.length !== 1 || statement?.type !== 'TryStatement' || statement.finalizer || !statement.handler || statement.handler.param) return false;
    const read = (block: E.BlockStatement, path: string): boolean => {
      if (block.body.length !== 1) return false;
      const returned = block.body[0];
      const value = returned?.type === 'ReturnStatement' && returned.argument?.type === 'AwaitExpression' ? returned.argument.argument : null;
      if (!call(value) || !member(value.callee, 'readBytes') || !member(value.callee.object, 'filesystem') || !this.same(value.callee.object.object, node.params[0]) || value.arguments.length !== 1) return false;
      const url = value.arguments[0];
      if (url?.type !== 'NewExpression' || !this.standard(url.callee, 'URL') || url.arguments.length !== 2 || url.arguments[0]?.type !== 'Literal' || url.arguments[0].value !== path) return false;
      const base = url.arguments[1];
      return member(base, 'url') && base.object.type === 'MetaProperty' && base.object.meta.name === 'import' && base.object.property.name === 'meta';
    };
    return read(statement.block, './zxing_reader.wasm') && read(statement.handler.body, '../../../node_modules/zxing-wasm/dist/reader/zxing_reader.wasm');
  }
}
