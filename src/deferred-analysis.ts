import { analyze } from 'eslint-scope';
import { AmbientInitializer } from './ambient-initializer.js';
import type { Variable } from 'eslint-scope';
import type * as E from 'estree';
import type { SourceAnalysis, SourceRange, StructuralEvidence } from './analysis.js';

type Fn = E.FunctionDeclaration | E.FunctionExpression | E.ArrowFunctionExpression;
type Positioned = E.Node & { start: number; end: number };

function range(node: E.Node): SourceRange {
  return { start: (node as Positioned).start, end: (node as Positioned).end, unit: 'utf16' };
}

class UnprovenStage extends Error {
  constructor(readonly code: string, message: string, readonly node: E.Node) { super(message); }
}

function requireStage(condition: unknown, code: string, message: string, node: E.Node): asserts condition {
  if (!condition) throw new UnprovenStage(code, message, node);
}

function walk(node: E.Node, visit: (node: E.Node, parent?: E.Node) => void, parent?: E.Node): void {
  visit(node, parent);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child.type === 'string') walk(child as E.Node, visit, node);
    } else if (value && typeof value === 'object' && 'type' in value && typeof value.type === 'string') walk(value as E.Node, visit, node);
  }
}

function fn(node: E.Node | null | undefined): node is Fn {
  return node?.type === 'FunctionDeclaration' || node?.type === 'FunctionExpression' || node?.type === 'ArrowFunctionExpression';
}

function call(node: E.Node | null | undefined): node is E.CallExpression {
  return node?.type === 'CallExpression' && !node.optional;
}

function key(node: E.MemberExpression): string | null {
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  return node.computed && node.property.type === 'Literal' && typeof node.property.value === 'string' ? node.property.value : null;
}

function member(node: E.Node | null | undefined, name: string): node is E.MemberExpression {
  return node?.type === 'MemberExpression' && !node.optional && key(node) === name;
}

function bool(node: E.Node | null | undefined, value: boolean): boolean {
  return node?.type === 'Literal' && node.value === value || node?.type === 'UnaryExpression' && node.operator === '!' && node.argument.type === 'Literal' && node.argument.value === (value ? 0 : 1);
}

function expressions(node: E.Expression): E.Expression[] {
  return node.type === 'SequenceExpression' ? node.expressions.flatMap(expressions) : [node];
}

function statements(node: Fn): E.Statement[] {
  return node.body.type === 'BlockStatement' ? node.body.body : [];
}

function literal(node: E.Node | null | undefined, value: string | number | null): boolean { return node?.type === 'Literal' && node.value === value; }
function returned(node: E.Node | null | undefined): E.Expression | null { return node?.type === 'ReturnStatement' ? node.argument ?? null : null; }
function declared(node: E.Node | null | undefined): E.VariableDeclarator | null { return node?.type === 'VariableDeclaration' && node.declarations.length === 1 && node.declarations[0]?.id.type === 'Identifier' ? node.declarations[0] : null; }
function awaited(node: E.Node | null | undefined): E.Expression | null { return node?.type === 'AwaitExpression' ? node.argument : null; }
function properties(node: E.Node | null | undefined, names: string[]): E.Property[] | null {
  if (node?.type !== 'ObjectExpression' && node?.type !== 'ObjectPattern' || node.properties.length !== names.length) return null;
  const items = node.properties;
  return items.every((item, index) => item.type === 'Property' && !item.computed && !item.method && item.kind === 'init' && (item.key.type === 'Identifier' ? item.key.name : item.key.type === 'Literal' ? item.key.value : null) === names[index]) ? items as E.Property[] : null;
}

interface Candidate { wrapper: Fn; generic: Fn; key: E.Identifier; consumption: E.CallExpression; owner: E.ClassExpression; patched?: boolean }
interface Initializer { binding: Variable; declaration: E.VariableDeclarator; callback: Fn; dependencies: Initializer[] }
interface RequestChain { fetchMethod: E.MethodDefinition; blocking: E.MethodDefinition; entry: E.MethodDefinition }
interface ReceiverChain { instance: E.VariableDeclarator }
const stateRoles = ['now', 'getTurnMetadata', 'cache', 'inflightRequests'] as const;
type StateRole = typeof stateRoles[number];

/** A separate finite proof; compatibility requires every stage and relevant effect gate. */
export function analyzeDeferredStage(program: E.Program): SourceAnalysis | null {
  const proof = new DeferredProof(program);
  const candidates = proof.candidates();
  if (!candidates.length) return null;
  const result: SourceAnalysis = {
    patternVersion: 'site-status-deferred-v1', compatibility: 'incompatible', runtime: 'not-verified', target: null, evidence: [], diagnostics: [],
  };
  try {
    requireStage(candidates.length === 1, 'AMBIGUOUS_DEFERRED_STAGE', 'Multiple deferred predicate candidates; stage identity is ambiguous.', candidates[1]?.consumption ?? program);
    const candidate = candidates[0]!;
    const initialization = proof.initialization(candidate);
    proof.predicate(candidate);
    const request = proof.request(candidate);
    // Keep the existing impact gate first: later structural work must never
    // hide a current-file capability escape (including an opaque host bridge).
    proof.closeRelevantEffects();
    const receiver = proof.receiver(candidate);
    const cache = proof.cache(candidate, request.chain);
    const consumption = proof.policy(candidate, request.chain, receiver.chain);
    proof.closeRelevantEffects();
    if (proof.ambient.premise.operations.length) proof.ambient.close();
    result.evidence.push(initialization, {
      kind: 'predicate', range: range(candidate.wrapper),
      description: 'Object guards protect feature_status; the initialized agent key blocks only on strict equality to true.',
    }, ...request.evidence, receiver.evidence, cache, consumption);
    requireStage(!candidate.patched, 'UNTRUSTED_PATCHED_SHAPE', 'Response-copy shape found without trusted operation provenance; this is not proof of tool application.', candidate.consumption.arguments[0]!);
    if (proof.ambient.premise.operations.length) {
      requireStage(false, 'AMBIENT_PLAN_UNSUPPORTED', 'The approved ambient premise is structurally associated, but this pattern has no rederivable plan model yet.', candidate.consumption);
    }
    result.compatibility = 'compatible';
    result.target = range(candidate.consumption.arguments[0]!);
  } catch (error) {
    if (!(error instanceof UnprovenStage)) throw error;
    result.diagnostics.push({ code: error.code, severity: 'error', message: error.message, range: range(error.node) });
  }
  if (proof.ambient.premise.operations.length) {
    result.patternVersion = 'site-status-deferred-ambient-v1';
    result.ambientPremise = proof.ambient.premise;
  }
  return result;
}

class DeferredProof {
  readonly ambient = new AmbientInitializer({
    binding: node => this.binding(node),
    parent: node => this.parents.get(node),
    once: node => {
      const binding = this.binding(node.callee);
      if (!binding || node.arguments.length || !this.initializers.has(binding)) return false;
      throw new UnprovenStage('DEFERRED_INITIALIZER_EFFECT', 'CommonJS-to-once activation requires a shared normal-completion and reentry proof.', node);
    },
    fail: (message, node) => { throw new UnprovenStage('DEFERRED_INITIALIZER_EFFECT', message, node); },
  });
  private readonly bindings = new Map<E.Node, Variable>();
  private readonly parents = new Map<E.Node, E.Node>();
  private readonly nodes: E.Node[] = [];
  private readonly tracked = new Set<Variable>();
  private readonly allowedReads = new Set<E.Node>();
  private readonly allowedWrites = new Set<E.Node>();
  private readonly initializers = new Map<Variable, Initializer>();
  private readonly guards = new Set<Fn>();
  private readonly initializedData = new Set<Variable>();
  private readonly plainData = new Set<Variable>();
  private readonly literalEnums = new Set<Variable>();
  private readonly provenMethods = new Set<Fn>();
  private readonly hostDefaults = new Set<E.Node>();
  private readonly stateNames: Record<StateRole, string> = { now: 'now', getTurnMetadata: 'getTurnMetadata', cache: 'cache', inflightRequests: 'inflightRequests' };
  private state(role: StateRole): string { return this.stateNames[role]; }

  private stateShape(owner: E.ClassExpression): void {
    const fields = owner.body.body.filter((item): item is E.PropertyDefinition => item.type === 'PropertyDefinition');
    const constructor = owner.body.body.find((item): item is E.MethodDefinition => item.type === 'MethodDefinition' && item.kind === 'constructor');
    const assignments = constructor ? statements(constructor.value) : [];
    const clock = constructor?.value.params[0];
    // Receiver validation later requires this exact standard default and its
    // unchanged assignment. No arbitrary parameter defaults are exempted.
    if (clock?.type === 'AssignmentPattern' && member(clock.right, 'now') && this.standard(clock.right.object, 'Date')) this.hostDefaults.add(clock);
    if (fields.length !== 4 || assignments.length !== 2) return;
    for (const [index, role] of stateRoles.slice(0, 2).entries()) {
      const statement = assignments[index];
      const assignment = statement?.type === 'ExpressionStatement' && statement.expression.type === 'AssignmentExpression' ? statement.expression : null;
      if (assignment?.left.type === 'MemberExpression' && assignment.left.object.type === 'ThisExpression' && key(assignment.left) !== null) this.stateNames[role] = key(assignment.left)!;
    }
    for (const [index, role] of stateRoles.entries()) {
      const field = fields[index];
      if (field?.key.type === 'Identifier' && index >= 2) this.stateNames[role] = field.key.name;
    }
  }

  constructor(private readonly program: E.Program) {
    const scopes = analyze(program, { ecmaVersion: 2022, sourceType: 'module', optimistic: false, ignoreEval: false });
    for (const scope of scopes.scopes) for (const variable of scope.variables) {
      for (const identifier of variable.identifiers) this.bindings.set(identifier, variable);
      for (const reference of variable.references) this.bindings.set(reference.identifier, variable);
    }
    walk(program, (node, parent) => { this.nodes.push(node); if (parent) this.parents.set(node, parent); });
  }

  private binding(node: E.Node | null | undefined): Variable | undefined { return node ? this.bindings.get(node) : undefined; }
  private same(a: E.Node | null | undefined, b: E.Node | null | undefined): boolean {
    return a?.type === 'Identifier' && b?.type === 'Identifier' && !!this.binding(a) && this.binding(a) === this.binding(b);
  }
  private definition(node: E.Node | null | undefined): Fn | null {
    const defs = this.binding(node)?.defs;
    if (defs?.length !== 1) return null;
    const d = defs[0]!;
    return fn(d.node) ? d.node : d.node.type === 'VariableDeclarator' && fn(d.node.init) ? d.node.init : null;
  }
  private track(node: E.Node): Variable {
    const binding = this.binding(node);
    requireStage(binding && binding.defs.length === 1, 'DEFERRED_BINDING', 'Relevant binding is missing, shadowed or ambiguous.', node);
    this.tracked.add(binding);
    return binding;
  }
  private read(node: E.Node): void { this.track(node); this.allowedReads.add(node); }
  private top(node: E.Node): E.Node {
    let current = node;
    while (this.parents.get(current) && this.parents.get(current) !== this.program) current = this.parents.get(current)!;
    return current;
  }

  candidates(): Candidate[] {
    const found: Candidate[] = [];
    for (const owner of this.nodes) {
      if (owner.type !== 'ClassExpression') continue;
      for (const method of owner.body.body) {
        if (method.type !== 'MethodDefinition') continue;
        for (const statement of method.value.body.body) {
          const consumption = statement.type === 'ReturnStatement' ? statement.argument : null;
          if (!call(consumption) || consumption.callee.type !== 'Identifier' || consumption.arguments.length !== 1) continue;
          const wrapper = this.definition(consumption.callee);
          const body = wrapper ? statements(wrapper) : [];
          const returned = body.length === 1 && body[0]?.type === 'ReturnStatement' ? body[0].argument : null;
          const inner = returned?.type === 'UnaryExpression' ? returned.argument : returned;
          if (!wrapper || !call(inner) || inner.arguments.length !== 2 || inner.arguments[1]?.type !== 'Identifier') continue;
          const generic = this.definition(inner.callee);
          const agent = this.binding(inner.arguments[1]);
          const def = agent?.defs[0]?.node;
          let feature = false;
          if (generic) walk(generic, node => { if (member(node, 'feature_status')) feature = true; });
          if (!generic || !feature || def?.type === 'VariableDeclarator' && def.init) continue;
          found.push({ wrapper, generic, key: inner.arguments[1], consumption, owner });
        }
      }
    }
    return found;
  }

  private helper(node: E.Node): Variable {
    const binding = this.track(node), helper = this.definition(node);
    const fail = () => requireStage(false, 'DEFERRED_ONCE_HELPER', 'Once helper must clear its callback before one synchronous invocation and return the cached value.', node);
    if (!helper || helper.type !== 'ArrowFunctionExpression' || helper.async || helper.params.length !== 2) { fail(); throw new Error('unreachable'); }
    const [task, value] = helper.params;
    const thunk = helper.body;
    if (task?.type !== 'Identifier' || value?.type !== 'Identifier' || thunk.type !== 'ArrowFunctionExpression' || thunk.async || thunk.params.length || thunk.body.type !== 'SequenceExpression' || thunk.body.expressions.length !== 2) { fail(); throw new Error('unreachable'); }
    const [guard, cached] = thunk.body.expressions;
    const assignment = guard?.type === 'LogicalExpression' && guard.operator === '&&' && this.same(guard.left, task) ? guard.right : null;
    const invoke = assignment?.type === 'AssignmentExpression' && assignment.operator === '=' && this.same(assignment.left, value) ? assignment.right : null;
    const clear = call(invoke) && this.same(invoke.callee, task) && invoke.arguments.length === 1 ? invoke.arguments[0] : null;
    requireStage(clear?.type === 'AssignmentExpression' && clear.operator === '=' && this.same(clear.left, task) && clear.right.type === 'Literal' && clear.right.value === 0 && this.same(cached, value), 'DEFERRED_ONCE_HELPER', 'Once helper must clear its callback before one synchronous invocation and return the cached value.', node);
    // Only the two writes inherent in the proven helper are permitted.
    for (const parameter of [task, value]) {
      const variable = this.track(parameter);
      for (const reference of variable.references) if (reference.isWrite()) {
        requireStage(reference.identifier === clear.left || reference.identifier === (assignment as E.AssignmentExpression).left, 'DEFERRED_ONCE_HELPER', 'Once helper parameter has an additional write.', reference.identifier);
        this.allowedWrites.add(reference.identifier);
      } else this.allowedReads.add(reference.identifier);
    }
    for (const reference of binding.references) if (!reference.isWrite()) {
      const parent = this.parents.get(reference.identifier);
      requireStage(call(parent) && parent.callee === reference.identifier && parent.arguments.length === 1 && fn(parent.arguments[0]), 'DEFERRED_ESCAPED_BINDING', 'Once helper may only create direct initializer callbacks; helper aliases and escapes are unproven.', reference.identifier);
      this.allowedReads.add(reference.identifier);
    }
    return binding;
  }

  private initializer(binding: Variable, active = new Set<Variable>()): Initializer {
    const cached = this.initializers.get(binding);
    requireStage(!active.has(binding), 'DEFERRED_INITIALIZATION_CYCLE', 'Relevant initializer dependencies must be acyclic; reentry can observe an unset value.', binding.identifiers[0] ?? this.program);
    if (cached) return cached;
    const declaration = binding.defs[0]?.node;
    requireStage(binding.defs.length === 1 && declaration?.type === 'VariableDeclarator' && this.parents.get(this.parents.get(declaration)!) === this.program && call(declaration.init) && declaration.init.arguments.length === 1 && fn(declaration.init.arguments[0]), 'DEFERRED_INITIALIZER_SHAPE', 'Initialization requires a module-level once-helper callback binding.', declaration ?? this.program);
    this.track(declaration.id);
    this.read(declaration.init.callee);
    const helperBinding = this.helper(declaration.init.callee);
    const helperDeclaration = helperBinding.defs[0]?.node;
    requireStage(helperDeclaration?.type === 'VariableDeclarator' && this.parents.get(this.parents.get(helperDeclaration)!) === this.program && range(helperDeclaration).end < range(declaration).start, 'DEFERRED_INITIALIZATION_ORDER', 'Once helper must be established before initializer factories are evaluated.', declaration);
    const callback = declaration.init.arguments[0];
    requireStage(callback.type === 'ArrowFunctionExpression' && !callback.async && callback.params.length === 0 && callback.body.type === 'BlockStatement', 'DEFERRED_INITIALIZER_SHAPE', 'Initializer must be a synchronous zero-parameter block callback.', callback);
    const initializer: Initializer = { binding, declaration, callback, dependencies: [] };
    active.add(binding);
    for (const statement of callback.body.body) {
      requireStage(statement.type === 'ExpressionStatement', 'DEFERRED_CONDITIONAL_INITIALIZATION', 'Initializer dependencies and assignments must be unconditional expressions; catches and branches are unsupported.', statement);
      for (const expression of expressions(statement.expression)) {
        if (expression.type === 'Literal' && expression.value === 'use strict') continue;
        if (call(expression) && expression.callee.type === 'Identifier' && expression.arguments.length === 0) {
          const dependency = this.track(expression.callee);
          this.allowedReads.add(expression.callee);
          initializer.dependencies.push(this.initializer(dependency, active));
        } else {
          requireStage(expression.type === 'AssignmentExpression' && expression.operator === '=' && expression.left.type === 'Identifier', 'DEFERRED_CONDITIONAL_INITIALIZATION', 'Initializer supports direct dependencies followed by simple assignments only.', expression);
          const dataBinding = this.binding(expression.left);
          this.initialValue(expression.right, expression.left);
          if (dataBinding) {
            this.initializedData.add(dataBinding);
            if (expression.right.type === 'ObjectExpression' || expression.right.type === 'ArrayExpression') this.plainData.add(dataBinding);
          }
        }
      }
    }
    active.delete(binding);
    this.initializers.set(binding, initializer);
    return initializer;
  }

  /** Only immediate effects matter here; deferred function/method bodies are data. */
  private initialValue(node: E.Node, assigned: E.Identifier): void {
    const reject = () => requireStage(false, 'DEFERRED_INITIALIZER_EFFECT', 'Initializer RHS has an unproven immediate effect, read, mutation or reentrant call.', node);
    if (node.type === 'Literal' || node.type === 'TemplateLiteral' && node.expressions.length === 0) return;
    if (node.type === 'UnaryExpression' && ['!', '-', '+', 'void'].includes(node.operator) && node.argument.type === 'Literal') return;
    if (node.type === 'BinaryExpression' && ['*', '+', '-', '/'].includes(node.operator)) {
      const numeric = (value: E.Node): boolean => value.type === 'Literal' && typeof value.value === 'number' || value.type === 'BinaryExpression' && ['*', '+', '-', '/'].includes(value.operator) && numeric(value.left) && numeric(value.right);
      requireStage(numeric(node), 'DEFERRED_INITIALIZER_EFFECT', 'Initializer arithmetic must use numeric literals; object coercion can invoke unknown code.', node);
      return;
    }
    if (fn(node)) return;
    if (node.type === 'Identifier') {
      const binding = this.binding(node), definition = binding?.defs[0]?.node;
      if (!binding && node.name === 'Error') return;
      if (binding && this.initializedData.has(binding)) { this.read(node); return; }
      if (definition?.type === 'FunctionDeclaration' && binding?.references.every(reference => !reference.isWrite())) return;
      reject(); return;
    }
    if (node.type === 'MemberExpression' && key(node) !== null) {
      let root: E.Node = node.object;
      while (root.type === 'MemberExpression' && key(root) !== null) root = root.object;
      const binding = this.binding(root);
      if (root.type === 'Identifier' && binding && this.plainData.has(binding)) { this.read(root); return; }
    }
    if (node.type === 'ObjectExpression') {
      for (const item of node.properties) {
        requireStage(item.type === 'Property' && !item.computed && item.kind === 'init', 'DEFERRED_INITIALIZER_EFFECT', 'Initializer data cannot contain spread, computed keys or accessors.', item);
        this.initialValue(item.value, assigned);
      }
      return;
    }
    if (node.type === 'ArrayExpression') {
      for (const item of node.elements) if (item) this.initialValue(item, assigned);
      return;
    }
    if (node.type === 'ClassExpression') {
      if (node.superClass) this.initialValue(node.superClass, assigned);
      for (const item of node.body.body) requireStage(item.type !== 'StaticBlock' && !item.computed && !item.static, 'DEFERRED_INITIALIZER_EFFECT', 'Initializer classes cannot run static fields, blocks or computed keys.', item);
      return;
    }
    if (call(node) && member(node.callee, 'freeze') && node.callee.object.type === 'Identifier' && node.callee.object.name === 'Object' && !this.binding(node.callee.object) && node.arguments.length === 1) {
      this.initialValue(node.arguments[0]!, assigned); return;
    }
    if (call(node) && member(node.callee, 'values') && this.standard(node.callee.object, 'Object') && node.arguments.length === 1 && node.arguments[0]?.type === 'Identifier') {
      const argument = node.arguments[0], binding = this.binding(argument);
      // Enumeration can invoke own getters or Proxy traps. Only the closed fresh
      // scalar enum below supplies own data fields, with no foreign object input.
      if (binding && this.literalEnums.has(binding)) { this.read(argument); return; }
    }
    if (node.type === 'NewExpression' && node.callee.type === 'Identifier' && !this.binding(node.callee) && ['Set', 'TextEncoder'].includes(node.callee.name) && node.arguments.length <= 1) {
      for (const argument of node.arguments) this.initialValue(argument, assigned);
      return;
    }
    // The one supported enum IIFE writes literal fields only to its fresh local
    // object and returns that same object; it cannot invoke another initializer.
    if (call(node) && node.callee.type === 'ArrowFunctionExpression' && !node.callee.async && node.callee.params.length === 1 && node.callee.params[0]?.type === 'Identifier' && node.callee.body.type === 'SequenceExpression' && node.arguments.length === 1) {
      const parameter = node.callee.params[0], argument = node.arguments[0];
      const items = node.callee.body.expressions;
      const prior = argument?.type === 'LogicalExpression' && argument.operator === '||' && this.same(argument.left, assigned) && argument.right.type === 'ObjectExpression' && argument.right.properties.length === 0;
      const writes = items.slice(0, -1).every(item => item.type === 'AssignmentExpression' && item.operator === '=' && item.left.type === 'MemberExpression' && key(item.left) !== null && !['__proto__', 'constructor', 'prototype'].includes(key(item.left)!) && this.same(item.left.object, parameter) && item.right.type === 'Literal');
      const binding = this.binding(assigned);
      const writeCount = binding?.references.filter(reference => reference.isWrite()).length;
      if (prior && writes && writeCount === 1 && this.same(items.at(-1), parameter)) {
        const parameterBinding = this.track(parameter);
        const stores = items.slice(0, -1) as E.AssignmentExpression[];
        requireStage(parameterBinding.references.every(reference => !reference.isWrite() && (reference.identifier === items.at(-1) || stores.some(store => store.left.type === 'MemberExpression' && store.left.object === reference.identifier))), 'DEFERRED_INITIALIZER_EFFECT', 'Literal enum parameter must only receive literal own fields and be returned unchanged.', node);
        for (const reference of parameterBinding.references) this.allowedReads.add(reference.identifier);
        if (binding) { this.literalEnums.add(binding); this.read(argument.left); }
        return;
      }
    }
    if (call(node)) {
      this.ambient.evaluate(node);
      requireStage(this.ambient.premise.operations.length > 0, 'DEFERRED_INITIALIZER_EFFECT', 'An additional finite factory call is admitted only with the explicit ambient operation proof and separate pattern gate.', node);
      return;
    }
    reject();
  }

  initialization(candidate: Candidate): StructuralEvidence {
    const keyBinding = this.track(candidate.key);
    requireStage(keyBinding.defs[0]?.node.type === 'VariableDeclarator', 'DEFERRED_MISSING_INITIALIZATION', 'Agent key resolves to a shadowed input instead of module initialization.', candidate.key);
    const writes = keyBinding.references.filter(reference => reference.isWrite());
    requireStage(writes.length === 1, 'DEFERRED_REASSIGNED_BINDING', 'Agent key needs exactly one initialization assignment.', candidate.key);
    const write = writes[0]!.identifier;
    const assignment = this.parents.get(write);
    requireStage(assignment?.type === 'AssignmentExpression' && assignment.operator === '=' && assignment.left === write && assignment.right.type === 'Literal' && assignment.right.value === 'agent', 'DEFERRED_AGENT_KEY', 'Deferred agent key must be assigned the literal agent.', assignment ?? write);
    let callback: E.Node | undefined = assignment;
    while (callback && !fn(callback)) callback = this.parents.get(callback);
    const factory = callback && this.parents.get(callback), declaration = factory && this.parents.get(factory);
    requireStage(declaration?.type === 'VariableDeclarator', 'DEFERRED_MISSING_INITIALIZATION', 'Agent assignment must belong to a once initializer.', assignment);
    const site = this.initializer(this.track(declaration.id));
    requireStage(site.callback === callback, 'DEFERRED_MISSING_INITIALIZATION', 'Agent assignment must belong to the proven callback.', assignment);
    this.allowedWrites.add(write);
    this.allowedReads.add(candidate.key);
    // The finite site configuration is immutable scalar data, with a unique write.
    for (const statement of statements(site.callback)) if (statement.type === 'ExpressionStatement') for (const expression of expressions(statement.expression)) {
      if (expression.type !== 'AssignmentExpression' || expression.left.type !== 'Identifier' || expression.right.type !== 'Literal' || !['https://chatgpt.com/backend-api', 'agent', 'codex_browser_use'].includes(String(expression.right.value))) continue;
      const variable = this.track(expression.left);
      requireStage(variable.references.filter(reference => reference.isWrite()).length === 1, 'DEFERRED_REASSIGNED_BINDING', 'Relevant deferred configuration is reassigned.', expression);
      this.allowedWrites.add(expression.left);
      for (const reference of variable.references) if (!reference.isWrite()) this.allowedReads.add(reference.identifier);
    }
    const reachesSite = (binding: Variable, seen = new Set<Variable>()): boolean => {
      if (binding === site.binding) return true;
      if (seen.has(binding)) return false;
      seen.add(binding);
      const definition = binding.defs[0]?.node;
      const callback = definition?.type === 'VariableDeclarator' && call(definition.init) ? definition.init.arguments[0] : null;
      if (!fn(callback)) return false;
      let reaches = false;
      walk(callback.body, node => {
        if (!call(node)) return;
        const dependency = this.binding(node.callee);
        if (dependency && reachesSite(dependency, seen)) reaches = true;
      });
      return reaches;
    };
    const roots: { initializer: Initializer; call: E.CallExpression }[] = [];
    for (const statement of this.program.body) {
      if (roots.length) break;
      if (statement.type !== 'ExpressionStatement') continue;
      for (const expression of expressions(statement.expression)) {
        if (!call(expression) || expression.arguments.length || expression.callee.type !== 'Identifier') continue;
        const binding = this.binding(expression.callee), definition = binding?.defs[0]?.node;
        if (definition?.type !== 'VariableDeclarator' || !call(definition.init) || !this.same(definition.init.callee, factory && call(factory) ? factory.callee : null)) continue;
        if (!reachesSite(binding!)) continue;
        const initializer = this.initializer(binding!);
        roots.push({ initializer, call: expression }); break;
      }
    }
    requireStage(roots.length > 0, 'DEFERRED_MISSING_INITIALIZATION', 'No unconditional module initialization path reaches the site configuration.', candidate.owner);
    const root = roots[0]!;
    requireStage(range(root.call).start < range(this.top(candidate.owner)).start, 'DEFERRED_INITIALIZATION_ORDER', 'A proven initializer must complete before the relevant class is evaluated.', candidate.owner);
    // Discover callers before symbolic execution, so their earlier module calls
    // contribute only after every dependency and immediate RHS has been proved.
    // Map iteration includes newly admitted callers and their dependencies.
    for (const initializer of this.initializers.values()) for (const reference of initializer.binding.references) {
      if (reference.isWrite()) continue;
      let enclosing: E.Node | undefined = reference.identifier;
      while (enclosing && !fn(enclosing)) enclosing = this.parents.get(enclosing);
      if (!enclosing || range(this.top(enclosing)).start >= range(root.call).start) continue;
      const factory = this.parents.get(enclosing), declaration = factory && this.parents.get(factory);
      const knownFactory = initializer.declaration.init;
      if (!call(factory) || declaration?.type !== 'VariableDeclarator' || !call(knownFactory) || !this.same(factory.callee, knownFactory.callee)) continue;
      const caller = this.binding(declaration.id);
      if (caller) this.initializer(caller);
    }
    const completed = new Set<Variable>();
    const available = new Set<Variable>();
    const complete = (initializer: Initializer, activation: E.CallExpression): void => {
      if (completed.has(initializer.binding)) return;
      requireStage(range(initializer.declaration).end < range(activation).start, 'DEFERRED_INITIALIZATION_ORDER', 'Initializer factory binding is not established before the initialization call.', initializer.declaration);
      for (const statement of statements(initializer.callback)) if (statement.type === 'ExpressionStatement') for (const expression of expressions(statement.expression)) {
        if (call(expression)) {
          const dependency = this.initializers.get(this.binding(expression.callee)!);
          requireStage(dependency, 'DEFERRED_INITIALIZER_SHAPE', 'Initializer dependency is not proven.', expression);
          complete(dependency, activation);
        } else if (expression.type === 'AssignmentExpression' && expression.left.type === 'Identifier') {
          const assigned = this.binding(expression.left);
          walk(expression.right, node => {
            if (node.type !== 'Identifier') return;
            const binding = this.binding(node);
            if (!binding || !this.initializedData.has(binding)) return;
            // A deferred function or method body is not evaluated on assignment.
            let ancestor = node === expression.right ? undefined : this.parents.get(node), deferred = false;
            while (ancestor && ancestor !== expression.right) {
              if (fn(ancestor)) { deferred = true; break; }
              ancestor = this.parents.get(ancestor);
            }
            if (fn(expression.right) || deferred) return;
            requireStage(available.has(binding) || binding === assigned && call(expression.right), 'DEFERRED_INITIALIZATION_ORDER', 'Initializer reads a dependency before its assignment has completed.', node);
          });
          if (assigned) available.add(assigned);
        }
      }
      completed.add(initializer.binding);
    };
    // Execute only the proven finite initialization graph, symbolically. Earlier
    // unconditional roots contribute values; conditional/caught paths never do.
    for (const statement of this.program.body) {
      if (range(statement).start > range(root.call).start) break;
      if (statement.type !== 'ExpressionStatement') continue;
      for (const expression of expressions(statement.expression)) if (call(expression)) {
        const initializer = this.initializers.get(this.binding(expression.callee)!);
        if (initializer) complete(initializer, expression);
      }
    }
    // A failed once call cannot be retried. Any earlier reachable invocation, including
    // a caught/conditional one, would invalidate the normal-completion implication.
    for (const initializer of this.initializers.values()) this.checkEarlyActivation(initializer.binding, root.call, new Set());
    for (const initializer of this.initializers.values()) for (const reference of initializer.binding.references) if (!reference.isWrite()) {
      const parent = this.parents.get(reference.identifier);
      requireStage(call(parent) && parent.callee === reference.identifier && parent.arguments.length === 0, 'DEFERRED_ESCAPED_BINDING', 'Initializer may only be called directly without arguments; aliases and escapes are unproven.', reference.identifier);
      this.allowedReads.add(reference.identifier);
    }
    this.read(candidate.consumption.callee);
    return { kind: 'initialization', range: range(root.call), description: `Finite once helper and ${completed.size} acyclic initialization dependencies establish the unique agent/configuration assignments before class evaluation on normal completion. An initialization exception does not imply later consumption is reached.` };
  }

  private checkEarlyActivation(binding: Variable, root: E.CallExpression, seen: Set<Variable>): void {
    if (seen.has(binding)) return;
    seen.add(binding);
    for (const reference of binding.references) {
      if (reference.isWrite()) continue;
      const parent = this.parents.get(reference.identifier);
      requireStage(call(parent) && parent.callee === reference.identifier && parent.arguments.length === 0, 'DEFERRED_ESCAPED_BINDING', 'Relevant initializer escapes before successful initialization.', reference.identifier);
      let enclosing: E.Node | undefined = parent;
      while (enclosing && !fn(enclosing)) enclosing = this.parents.get(enclosing);
      if (enclosing) {
        const factory = this.parents.get(enclosing), declaration = factory && this.parents.get(factory);
        if (call(factory) && declaration?.type === 'VariableDeclarator') {
          const caller = this.binding(declaration.id);
          if (caller && this.initializers.get(caller)?.callback === enclosing) {
            this.checkEarlyActivation(caller, root, seen); continue;
          }
        }
        if (range(this.top(enclosing)).start >= range(root).start) {
          // Deferred callbacks created after module initialization cannot be an
          // earlier activation. Function declarations are hoisted, so inspect them.
          if (enclosing.type !== 'FunctionDeclaration') continue;
        }
        requireStage(enclosing.type === 'FunctionDeclaration' && enclosing.id, 'DEFERRED_INITIALIZATION_ORDER', 'An earlier callback may invoke initialization without a proven normal-completion path.', enclosing);
        const caller = this.track(enclosing.id);
        this.checkEarlyActivation(caller, root, seen);
        continue;
      }
      if (range(parent).start >= range(root).start) continue;
      const statement = this.parents.get(parent);
      const initializer = this.initializers.get(binding);
      if (statement?.type === 'ExpressionStatement' && this.parents.get(statement) === this.program && initializer && range(initializer.declaration).end < range(parent).start) continue;
      requireStage(false, 'DEFERRED_INITIALIZATION_ORDER', 'Earlier conditional or caught initialization may clear the callback without completing its assignments.', parent);
    }
  }

  predicate(candidate: Candidate): void {
    const { wrapper, generic } = candidate;
    requireStage(wrapper.params.length === 1 && wrapper.params[0]?.type === 'Identifier' && !wrapper.async && !wrapper.generator, 'DEFERRED_AGENT_SEMANTICS', 'Agent wrapper must synchronously pass the same response and agent key.', wrapper);
    const inner = (statements(wrapper)[0] as E.ReturnStatement).argument;
    requireStage(call(inner) && this.same(inner.arguments[0], wrapper.params[0]), 'DEFERRED_AGENT_SEMANTICS', 'Agent wrapper must pass the unchanged response binding.', wrapper);
    this.read(inner.callee);
    requireStage(generic.params.length === 2 && generic.params.every(parameter => parameter.type === 'Identifier') && !generic.async && !generic.generator, 'DEFERRED_AGENT_SEMANTICS', 'Generic predicate must synchronously take response and key.', generic);
    const [body, featureKey] = generic.params;
    const statementsList = statements(generic), [guard, declaration, returned] = statementsList;
    requireStage(statementsList.length === 3 && guard?.type === 'IfStatement' && !guard.alternate && guard.test.type === 'UnaryExpression' && guard.test.operator === '!' && call(guard.test.argument) && guard.test.argument.arguments.length === 1 && this.same(guard.test.argument.arguments[0], body) && guard.consequent.type === 'ReturnStatement' && bool(guard.consequent.argument, false), 'DEFERRED_AGENT_SEMANTICS', 'Response must have an object guard with a false fallback.', generic);
    requireStage(declaration?.type === 'VariableDeclaration' && declaration.declarations.length === 1 && declaration.declarations[0]?.id.type === 'Identifier' && member(declaration.declarations[0].init, 'feature_status') && this.same(declaration.declarations[0].init.object, body), 'DEFERRED_AGENT_SEMANTICS', 'Predicate must read feature_status from the guarded response.', generic);
    const flags = declaration.declarations[0].id;
    const conditional = returned?.type === 'ReturnStatement' ? returned.argument : null;
    requireStage(conditional?.type === 'ConditionalExpression' && call(conditional.test) && conditional.test.arguments.length === 1 && this.same(conditional.test.arguments[0], flags) && this.same(conditional.test.callee, guard.test.argument.callee) && bool(conditional.alternate, false), 'DEFERRED_AGENT_SEMANTICS', 'feature_status must have the same object guard and false fallback.', generic);
    const strict = conditional.consequent;
    requireStage(strict.type === 'BinaryExpression' && strict.operator === '===' && strict.left.type === 'MemberExpression' && strict.left.computed && !strict.left.optional && this.same(strict.left.object, flags) && this.same(strict.left.property, featureKey) && bool(strict.right, true), 'DEFERRED_AGENT_SEMANTICS', 'Only feature_status[agent] strictly equal to true may block.', strict);
    this.objectGuard(guard.test.argument.callee);
    this.read(guard.test.argument.callee);
    this.read(conditional.test.callee);
    for (const parameter of [...wrapper.params, ...generic.params, flags]) {
      const binding = this.track(parameter);
      for (const reference of binding.references) {
        requireStage(!reference.isWrite() || reference.init, 'DEFERRED_REASSIGNED_BINDING', 'Predicate input or feature binding is reassigned.', reference.identifier);
        this.allowedReads.add(reference.identifier);
      }
    }
  }

  private objectGuard(identifier: E.Node): void {
    const guard = this.definition(identifier);
    requireStage(guard && guard.params.length === 1 && guard.params[0]?.type === 'Identifier' && !guard.async && !guard.generator, 'DEFERRED_AGENT_SEMANTICS', 'Object guard must be a synchronous single-parameter predicate.', identifier);
    const parameter = guard.params[0], body = statements(guard), value = body.length === 1 && body[0]?.type === 'ReturnStatement' ? body[0].argument : null;
    const type = value?.type === 'LogicalExpression' && value.operator === '&&' ? value.left : null;
    const nonNull = value?.type === 'LogicalExpression' ? value.right : null;
    requireStage(type?.type === 'BinaryExpression' && ['==', '==='].includes(type.operator) && type.left.type === 'UnaryExpression' && type.left.operator === 'typeof' && this.same(type.left.argument, parameter) && type.right.type === 'Literal' && type.right.value === 'object' && nonNull?.type === 'BinaryExpression' && ['!=', '!=='].includes(nonNull.operator) && this.same(nonNull.left, parameter) && nonNull.right.type === 'Literal' && nonNull.right.value === null, 'DEFERRED_AGENT_SEMANTICS', 'Object guard must require typeof object and non-null.', guard);
    this.guards.add(guard);
    const binding = this.track(parameter);
    for (const reference of binding.references) this.allowedReads.add(reference.identifier);
  }

  private requestNeed(condition: unknown, code: string, message: string, node: E.Node): asserts condition {
    requireStage(condition, `DEFERRED_${code}`, message, node);
  }

  /** Mark a fully matched function's local inputs and values, never arbitrary call sites. */
  private matchedFunction(node: Fn): void {
    if (this.parents.get(node)?.type === 'MethodDefinition') this.provenMethods.add(node);
    walk(node, item => {
      if (item.type !== 'Identifier') return;
      const binding = this.binding(item);
      if (!binding || !binding.defs.every(def => range(def.node).start >= range(node).start && range(def.node).end <= range(node).end)) return;
      this.track(item);
      const reference = binding.references.find(reference => reference.identifier === item);
      if (reference?.isWrite()) this.allowedWrites.add(item);
      else this.allowedReads.add(item);
    });
  }

  private directFunction(identifier: E.Node, code: string): Fn {
    const value = this.definition(identifier);
    this.requestNeed(value && !value.async && !value.generator, code, 'Request helper must resolve to a synchronous local function.', identifier);
    this.read(identifier);
    return value;
  }

  private params(node: Fn, count: number, code: string): E.Identifier[] {
    this.requestNeed(node.params.length === count && node.params.every(parameter => parameter.type === 'Identifier'), code, 'Request helper parameters are outside the finite binding pattern.', node);
    return node.params as E.Identifier[];
  }

  private invoke(node: E.Node | null | undefined, receiver: E.Node, name: string, args: (E.Node | null | undefined)[]): node is E.CallExpression {
    return call(node) && member(node.callee, name) && this.same(node.callee.object, receiver) && node.arguments.length === args.length && node.arguments.every((argument, index) => this.same(argument, args[index]));
  }

  private responseCopy(node: E.Node | null | undefined, body: E.Node): boolean {
    if (node?.type !== 'ObjectExpression' || node.properties.length !== 2) return false;
    const [spread, flags] = node.properties;
    if (spread?.type !== 'SpreadElement' || !this.same(spread.argument, body) || flags?.type !== 'Property' || flags.computed || flags.method || flags.kind !== 'init' || (flags.key.type === 'Identifier' ? flags.key.name : flags.key.type === 'Literal' ? flags.key.value : null) !== 'feature_status' || flags.value.type !== 'ObjectExpression' || flags.value.properties.length !== 2) return false;
    const [previous, override] = flags.value.properties;
    return previous?.type === 'SpreadElement' && previous.argument.type === 'ChainExpression' && previous.argument.expression.type === 'MemberExpression' && previous.argument.expression.optional && key(previous.argument.expression) === 'feature_status' && this.same(previous.argument.expression.object, body) && override?.type === 'Property' && !override.computed && !override.method && override.kind === 'init' && (override.key.type === 'Identifier' ? override.key.name : override.key.type === 'Literal' ? override.key.value : null) === 'agent' && bool(override.value, false);
  }

  private urlNew(node: E.Node | null | undefined, input: E.Node, field?: string): boolean {
    return node?.type === 'NewExpression' && node.callee.type === 'Identifier' && node.callee.name === 'URL' && !this.binding(node.callee) && node.arguments.length === 1 && (field ? member(node.arguments[0], field) && this.same(node.arguments[0].object, input) : this.same(node.arguments[0], input));
  }

  private throws(node: E.Node | null | undefined): boolean {
    if (node?.type !== 'ThrowStatement' || node.argument.type !== 'NewExpression' || node.argument.callee.type !== 'Identifier' || node.argument.callee.name !== 'Error' || this.binding(node.argument.callee) || node.argument.arguments.length !== 1) return false;
    const message = node.argument.arguments[0];
    return message?.type === 'Literal' && typeof message.value === 'string' || call(message) && message.callee.type === 'Identifier' && !!this.definition(message.callee) && message.arguments.every(argument => argument.type === 'Literal' && typeof argument.value === 'string');
  }

  private context(node: E.Node | null | undefined, defaults: boolean): E.Identifier[] {
    const pattern = defaults && node?.type === 'AssignmentPattern' && node.right.type === 'ObjectExpression' && node.right.properties.length === 0 ? node.left : node;
    const items = properties(pattern, ['conversationId', 'turnId', 'urlRequestSource']);
    this.requestNeed(items, 'REQUEST_CONTEXT', 'Request context must destructure conversationId, turnId and urlRequestSource without rest or replacement.', node ?? this.program);
    const values = items.map(item => item.value);
    if (defaults) {
      const source = values[2];
      this.requestNeed(source?.type === 'AssignmentPattern' && source.left.type === 'Identifier', 'REQUEST_CONTEXT', 'Request source must default to the initialized source binding.', pattern!);
      this.configuration(source.right, 'codex_browser_use');
      values[2] = source.left;
    }
    this.requestNeed(values.every(value => value.type === 'Identifier'), 'REQUEST_CONTEXT', 'Context fields must retain their own local bindings.', pattern!);
    return values as E.Identifier[];
  }

  private configuration(node: E.Node, value: string): void {
    const binding = this.binding(node), writes = binding?.references.filter(reference => reference.isWrite());
    const assignment = writes?.length === 1 ? this.parents.get(writes[0]!.identifier) : null;
    this.requestNeed(binding && this.tracked.has(binding) && assignment?.type === 'AssignmentExpression' && literal(assignment.right, value), 'REQUEST_CONFIGURATION', `Request configuration must be the proven initialized ${value} binding.`, node);
    this.read(node);
  }

  request(candidate: Candidate): { evidence: StructuralEvidence[]; chain: RequestChain } {
    this.stateShape(candidate.owner);
    const method = this.parents.get(this.parents.get(candidate.consumption)!);
    this.requestNeed(method?.type === 'BlockStatement' && this.parents.get(method)?.type === 'FunctionExpression', 'RESPONSE_BINDING', 'Predicate consumption must be the direct return of the HTTP method.', candidate.consumption);
    const fetch = this.parents.get(method) as E.FunctionExpression;
    const definition = this.parents.get(fetch);
    this.requestNeed(definition?.type === 'MethodDefinition' && !definition.static && !definition.computed && fetch.async && !fetch.generator, 'RESPONSE_BINDING', 'HTTP response method must be a direct async instance method.', fetch);
    const [runtime, request] = this.params(fetch, 2, 'RESPONSE_BINDING');
    const [httpStatement, success, jsonStatement, consumption] = statements(fetch);
    const http = declared(httpStatement), json = declared(jsonStatement), transport = awaited(http?.init);
    this.requestNeed(statements(fetch).length === 4, 'RESPONSE_BINDING', 'HTTP/JSON method has extra statements or unknown control flow around the response binding.', fetch);
    this.requestNeed(http && call(transport) && transport.callee.type === 'Identifier' && transport.arguments.length === 3 && this.same(transport.arguments[0], runtime) && member(transport.arguments[1], 'endpoint') && this.same(transport.arguments[1].object, request), 'REQUEST_ENDPOINT', 'HTTP method must await the transport with its runtime and the corresponding request.endpoint.', fetch);
    const options = properties(transport.arguments[2], ['method']);
    this.requestNeed(options && literal(options[0]?.value, 'GET'), 'REQUEST_GET', 'Site-status transport must receive exactly the GET request options.', transport);
    this.requestNeed(success?.type === 'IfStatement' && !success.alternate && success.test.type === 'UnaryExpression' && success.test.operator === '!' && member(success.test.argument, 'ok') && this.same(success.test.argument.object, http.id) && this.throws(success.consequent), 'HTTP_SUCCESS', 'Failure of this HTTP response.ok must throw before JSON parsing.', success ?? fetch);
    const parse = awaited(json?.init);
    candidate.patched = !!json && this.responseCopy(candidate.consumption.arguments[0], json.id);
    this.requestNeed(json && this.invoke(parse, http.id, 'json', []) && consumption?.type === 'ReturnStatement' && consumption.argument === candidate.consumption && (candidate.patched || this.same(candidate.consumption.arguments[0], json.id)), 'RESPONSE_BINDING', 'The same HTTP object must supply JSON; its unchanged local binding must reach the proven agent predicate.', jsonStatement ?? fetch);
    const wrapper = this.definition(transport.callee);
    this.requestNeed(wrapper && wrapper.async && !wrapper.generator, 'TRANSPORT_RECEIVER', 'Transport must resolve to a local async receiver-preserving wrapper.', transport.callee);
    this.read(transport.callee);
    const [host, endpoint, settings] = this.params(wrapper, 3, 'TRANSPORT_RECEIVER');
    const [guard, result] = statements(wrapper), invoked = awaited(returned(result));
    const test = guard?.type === 'IfStatement' ? guard.test : null;
    this.requestNeed(statements(wrapper).length === 2 && guard?.type === 'IfStatement' && !guard.alternate && test?.type === 'BinaryExpression' && ['!=', '!=='].includes(test.operator) && test.left.type === 'UnaryExpression' && test.left.operator === 'typeof' && member(test.left.argument, 'fetch') && this.same(test.left.argument.object, host) && literal(test.right, 'function') && this.throws(guard.consequent) && this.invoke(invoked, host!, 'fetch', [endpoint, settings]), 'TRANSPORT_RECEIVER', 'Transport must guard runtime.fetch and invoke that same member with its receiver, endpoint and options.', wrapper);
    // Error message construction is deliberately opaque only when it cannot see a
    // tracked input or capability. The request path has no other opaque effects.
    this.matchedFunction(wrapper);
    this.matchedFunction(fetch);
    const { builder, chain } = this.requestEntry(candidate, definition, runtime!, request!);
    this.requestBuilder(builder);
    this.requestReceiverEffects(candidate.owner);
    return { chain, evidence: [
      { kind: 'source', range: range(builder), description: 'Finite input URL proof preserves http/https and localhost filtering, normalized cache key, origin/pathname/search without fragment or credentials, initialized site-status endpoint and source, and conversation_id/turn_id metadata field provenance; constructor/accessor and actual cache/policy connection are proven by the accompanying evidence.' },
      { kind: 'transport', range: range(wrapper), description: 'Guarded runtime.fetch keeps its receiver and passes the corresponding endpoint and GET options unchanged under the runtime interface assumption.' },
      { kind: 'response', range: range(definition), description: 'The same HTTP object is checked for ok before JSON parsing; the unchanged JSON binding reaches the proven strict agent predicate.' },
    ] };
  }

  /** Only request forwarding is checked here; cache behavior and class identity are ticket 12. */
  private requestEntry(candidate: Candidate, fetchMethod: E.MethodDefinition, runtime: E.Identifier, request: E.Identifier): { builder: Fn; chain: RequestChain } {
    const fetchName = fetchMethod.key.type === 'Identifier' ? fetchMethod.key.name : null;
    const forwards = this.nodes.filter((node): node is E.CallExpression => call(node) && node.callee.type === 'MemberExpression' && node.callee.object.type === 'ThisExpression' && key(node.callee) === fetchName && range(node).start >= range(candidate.owner).start && range(node).end <= range(candidate.owner).end);
    this.requestNeed(forwards.length === 1, 'REQUEST_CONNECTION', 'HTTP method needs one corresponding direct request forwarding call.', fetchMethod);
    const forward = forwards[0]!;
    let blocking: E.Node | undefined = forward;
    while (blocking && blocking.type !== 'MethodDefinition') blocking = this.parents.get(blocking);
    this.requestNeed(blocking?.type === 'MethodDefinition' && blocking.key.type === 'Identifier' && !blocking.static && !blocking.computed, 'REQUEST_CONNECTION', 'Request forwarding must belong to an instance method.', forward);
    const [blockingRuntime, blockingRequest] = this.params(blocking.value, 2, 'REQUEST_CONNECTION');
    this.requestNeed(forward.arguments.length === 2 && this.same(forward.arguments[0], blockingRuntime) && this.same(forward.arguments[1], blockingRequest), 'REQUEST_CONNECTION', 'Forwarding must retain runtime and request parameters.', forward);
    const startup = statements(blocking.value)[0];
    this.requestNeed(blocking.value.async && startup?.type === 'VariableDeclaration' && startup.declarations[0]?.id.type === 'Identifier' && startup.declarations[0].init === forward, 'REQUEST_CONNECTION', 'Request startup must be the first unconditional local declaration before the unproven cache suffix.', forward);
    const entries = candidate.owner.body.body.filter((node): node is E.MethodDefinition => node.type === 'MethodDefinition' && node.value.params.length === 3 && statements(node.value).some(statement => statement.type === 'VariableDeclaration' && statement.declarations.some(declaration => call(declaration.init) && declaration.init.arguments[1]?.type === 'ObjectExpression')));
    this.requestNeed(entries.length === 1, 'REQUEST_CONNECTION', 'Request construction needs one finite three-input entry method.', candidate.owner);
    const entry = entries[0]!, [entryRuntime, site, backend] = this.params(entry.value, 3, 'REQUEST_CONNECTION');
    const first = statements(entry.value)[0];
    this.requestNeed(first?.type === 'VariableDeclaration' && first.declarations.length === 2, 'REQUEST_CONTEXT', 'Entry must bind metadata before building its request.', entry);
    const [metadata, built] = first.declarations;
    this.requestNeed(metadata?.id.type === 'Identifier' && call(metadata.init) && member(metadata.init.callee, this.state('getTurnMetadata')) && metadata.init.callee.object.type === 'ThisExpression' && metadata.init.arguments.length === 1 && this.same(metadata.init.arguments[0], entryRuntime) && built?.id.type === 'Identifier' && call(built.init) && built.init.arguments.length === 2 && this.same(built.init.arguments[0], site), 'REQUEST_CONTEXT', 'Entry metadata must come from this.getTurnMetadata with the same runtime; builder must use the site input.', first);
    const context = properties(built.init.arguments[1], ['conversationId', 'turnId', 'urlRequestSource']);
    const optional = (node: E.Node | undefined, name: string): boolean => node?.type === 'ChainExpression' && node.expression.type === 'MemberExpression' && node.expression.optional && key(node.expression) === name && this.same(node.expression.object, metadata.id);
    this.requestNeed(context && optional(context[0]?.value, 'session_id') && optional(context[1]?.value, 'turn_id'), 'REQUEST_CONTEXT', 'Conversation and turn parameters must retain their corresponding metadata fields.', built);
    const source = context[2]!.value;
    this.requestNeed(source.type === 'ConditionalExpression' && source.test.type === 'BinaryExpression' && source.test.operator === '==' && this.same(source.test.left, backend) && literal(source.test.right, null), 'REQUEST_CONTEXT', 'Request source must distinguish a missing backend from the same backend input.', source);
    this.configuration(source.consequent, 'codex_browser_use');
    this.requestNeed(source.alternate.type === 'TemplateLiteral' && source.alternate.expressions.length === 2 && this.same(source.alternate.expressions[0], source.consequent) && this.same(source.alternate.expressions[1], backend) && source.alternate.quasis.map(item => item.value.cooked).join('|') === '|:|', 'REQUEST_CONTEXT', 'Backend-qualified source must retain the initialized source and backend.', source);
    this.allowedReads.add(source.alternate.expressions[1]!);
    const builder = this.directFunction(built.init.callee, 'REQUEST_CONNECTION');
    const second = statements(entry.value)[1];
    this.requestNeed(second?.type === 'IfStatement' && !second.alternate && second.test.type === 'BinaryExpression' && second.test.operator === '==' && this.same(second.test.left, built.id) && literal(second.test.right, null) && second.consequent.type === 'ReturnStatement' && !second.consequent.argument, 'REQUEST_CONNECTION', 'Null requests must return before forwarding.', second ?? entry);
    const sends: E.CallExpression[] = [];
    walk(entry.value, node => { if (call(node) && member(node.callee, blocking.key.type === 'Identifier' ? blocking.key.name : '') && node.callee.object.type === 'ThisExpression') sends.push(node); });
    this.requestNeed(sends.length === 1 && sends[0]!.arguments.length === 2 && this.same(sends[0]!.arguments[0], entryRuntime) && this.same(sends[0]!.arguments[1], built.id), 'REQUEST_CONNECTION', 'Entry must forward the same runtime and constructed request.', entry);
    const entryBody = statements(entry.value), empty = declared(entryBody[2]), guarded = entryBody[3], output = properties(returned(entryBody[4]), ['request', 'result']);
    const attempt = guarded?.type === 'TryStatement' && guarded.block.body.length === 1 ? guarded.block.body[0] : null;
    const assigned = attempt?.type === 'ExpressionStatement' ? attempt.expression : null;
    this.requestNeed(entryBody.length === 5 && entry.value.async && empty && !empty.init && guarded?.type === 'TryStatement' && !guarded.finalizer && guarded.handler && !guarded.handler.param && guarded.handler.body.body.length === 1 && guarded.handler.body.body[0]?.type === 'ReturnStatement' && !guarded.handler.body.body[0].argument && assigned?.type === 'AssignmentExpression' && assigned.operator === '=' && this.same(assigned.left, empty.id) && awaited(assigned.right) === sends[0] && output && this.same(output[0]?.value, built.id) && this.same(output[1]?.value, empty.id), 'REQUEST_CONNECTION', 'Entry request construction must lead directly through the single awaited forwarding call with its existing catch-return and request/result return; unknown control flow is unproven.', entry);
    // Restrict request provenance here; the separate finite cache/receiver proof
    // closes result state before any complete structural evidence is exposed.
    for (const identifier of [runtime, request, blockingRuntime!, blockingRequest!, entryRuntime!, site!, backend!, metadata.id, built.id]) this.requestValue(identifier, new Set([forward, sends[0]!, built.init, metadata.init]), new Set([built.id]));
    return { builder, chain: { fetchMethod, blocking, entry } };
  }

  private standard(node: E.Node | null | undefined, name: string): boolean {
    return node?.type === 'Identifier' && node.name === name && !this.binding(node);
  }

  private selfMember(node: E.Node | null | undefined, name: string): node is E.MemberExpression {
    return member(node, name) && node.object.type === 'ThisExpression';
  }

  private stateMember(node: E.Node | null | undefined, role: StateRole): node is E.MemberExpression {
    return this.selfMember(node, this.state(role));
  }

  receiver(candidate: Candidate): { evidence: StructuralEvidence; chain: ReceiverChain } {
    const owner = candidate.owner;
    const constructor = owner.body.body.find((item): item is E.MethodDefinition => item.type === 'MethodDefinition' && item.kind === 'constructor');
    this.requestNeed(constructor && constructor.value.params.length === 2, 'CLASS_CONSTRUCTOR', 'Class needs the finite two-default constructor.', owner);
    const [clock, metadata] = constructor.value.params;
    this.requestNeed(clock?.type === 'AssignmentPattern' && clock.left.type === 'Identifier' && member(clock.right, 'now') && this.standard(clock.right.object, 'Date') && metadata?.type === 'AssignmentPattern' && metadata.left.type === 'Identifier' && metadata.right.type === 'Identifier', 'CLASS_CONSTRUCTOR', 'Constructor defaults must be standard Date.now and the local metadata accessor.', constructor);
    const body = statements(constructor.value);
    this.requestNeed(body.length === 2 && body.every((statement, index) => statement.type === 'ExpressionStatement' && statement.expression.type === 'AssignmentExpression' && statement.expression.operator === '=' && this.stateMember(statement.expression.left, index === 0 ? 'now' : 'getTurnMetadata') && this.same(statement.expression.right, index === 0 ? clock.left : metadata.left)), 'CLASS_CONSTRUCTOR', 'Constructor must retain only the corresponding clock and metadata defaults.', constructor);
    const accessor = this.directFunction(metadata.right, 'METADATA_ACCESSOR');
    this.metadataAccessor(accessor);
    this.matchedFunction(constructor.value);
    const fields = owner.body.body.filter((item): item is E.PropertyDefinition => item.type === 'PropertyDefinition');
    this.requestNeed(new Set(fields.map(field => field.key.type === 'Identifier' ? field.key.name : null)).size === 4 && fields.length === 4 && fields.every((field, index) => field.key.type === 'Identifier' && field.key.name === this.state(stateRoles[index]!) && (index < 2 ? !field.value : field.value?.type === 'NewExpression' && this.standard(field.value.callee, 'Map') && !field.value.arguments.length)), 'CLASS_FIELDS', 'Class state must be two empty accessor fields and two fresh standard Map fields.', owner);
    const declaration = this.parents.get(owner);
    this.requestNeed(declaration?.type === 'VariableDeclarator' && declaration.id.type === 'Identifier' && this.parents.get(this.parents.get(declaration)!) === this.program, 'CLASS_LIFECYCLE', 'Class expression must have a module-local binding.', owner);
    const binding = this.track(declaration.id);
    const uses = binding.references.filter(reference => !reference.isWrite());
    this.requestNeed(uses.length === 1, 'CLASS_LIFECYCLE', 'Class must construct one unique instance.', owner);
    const construct = this.parents.get(uses[0]!.identifier), instance = construct && this.parents.get(construct);
    this.requestNeed(construct?.type === 'NewExpression' && construct.callee === uses[0]!.identifier && !construct.arguments.length && instance?.type === 'VariableDeclarator' && instance.id.type === 'Identifier' && this.parents.get(this.parents.get(instance)!) === this.program && range(construct).start > range(owner).end, 'CLASS_LIFECYCLE', 'Unique instance must be constructed directly after class establishment with its defaults.', owner);
    this.read(uses[0]!.identifier);
    this.track(instance.id);
    for (const reference of this.binding(instance.id)!.references) if (!reference.isWrite()) this.allowedReads.add(reference.identifier);
    return { chain: { instance }, evidence: { kind: 'receiver', range: range(owner), description: 'Finite constructor retains Date.now and the default metadata accessor; fresh standard Map fields belong to one unique local instance with direct method receivers.' } };
  }

  private metadataAccessor(accessor: Fn): void {
    const [runtime] = this.params(accessor, 1, 'METADATA_ACCESSOR'), body = statements(accessor);
    const direct = returned(body[0]);
    if (body.length === 1 && member(direct, 'turn') && this.same(direct.object, runtime)) { this.matchedFunction(accessor); return; }
    const value = declared(body[0]), parseIf = body[1], guard = body[2];
    const read = value?.init;
    this.requestNeed(body.length === 3 && value && read?.type === 'ChainExpression' && read.expression.type === 'MemberExpression' && read.expression.optional && key(read.expression) === 'x-codex-turn-metadata' && member(read.expression.object, 'requestMeta') && this.same(read.expression.object.object, runtime), 'METADATA_ACCESSOR', 'Default metadata must read the corresponding runtime requestMeta turn header.', accessor);
    const typeTest = (node: E.Node | null | undefined, operator: string, type: string): boolean => node?.type === 'BinaryExpression' && node.operator === operator && node.left.type === 'UnaryExpression' && node.left.operator === 'typeof' && this.same(node.left.argument, value.id) && literal(node.right, type);
    this.requestNeed(parseIf?.type === 'IfStatement' && !parseIf.alternate && typeTest(parseIf.test, '==', 'string') && parseIf.consequent.type === 'TryStatement' && !parseIf.consequent.finalizer, 'METADATA_ACCESSOR', 'String metadata must be parsed in the finite throwing parse branch.', parseIf ?? accessor);
    const attempt = parseIf.consequent, assign = attempt.block.body[0]?.type === 'ExpressionStatement' ? attempt.block.body[0].expression : null;
    this.requestNeed(attempt.block.body.length === 1 && assign?.type === 'AssignmentExpression' && assign.operator === '=' && this.same(assign.left, value.id) && call(assign.right) && member(assign.right.callee, 'parse') && this.standard(assign.right.callee.object, 'JSON') && assign.right.arguments.length === 1 && this.same(assign.right.arguments[0], value.id) && attempt.handler && !attempt.handler.param && attempt.handler.body.body.length === 1 && attempt.handler.body.body[0]?.type === 'ReturnStatement' && !attempt.handler.body.body[0].argument, 'METADATA_ACCESSOR', 'Metadata JSON must parse the same header binding and return undefined on parse errors.', attempt);
    const flatten = (node: E.Node): E.Node[] => node.type === 'LogicalExpression' && node.operator === '||' ? [...flatten(node.left), ...flatten(node.right)] : [node];
    const test = guard?.type === 'IfStatement' && guard.test.type === 'UnaryExpression' && guard.test.operator === '!' ? flatten(guard.test.argument) : [];
    const array = test[2];
    this.requestNeed(guard?.type === 'IfStatement' && !guard.alternate && test.length === 3 && this.nullTest(test[0], value.id, '==') && typeTest(test[1], '!=', 'object') && call(array) && member(array.callee, 'isArray') && this.standard(array.callee.object, 'Array') && array.arguments.length === 1 && this.same(array.arguments[0], value.id) && this.same(returned(guard.consequent), value.id), 'METADATA_ACCESSOR', 'Metadata must return only the same non-null non-array object after parsing.', guard ?? accessor);
    this.matchedFunction(accessor);
  }

  private methodName(method: E.MethodDefinition): string {
    this.requestNeed(!method.static && !method.computed && method.kind === 'method' && !method.value.generator && method.key.type === 'Identifier', 'CLASS_METHOD', 'Relevant method must have a direct instance name.', method);
    return method.key.name;
  }

  private method(owner: E.ClassExpression, name: string): E.MethodDefinition {
    const methods = owner.body.body.filter((item): item is E.MethodDefinition => item.type === 'MethodDefinition' && item.key.type === 'Identifier' && item.key.name === name);
    this.requestNeed(methods.length === 1, 'CLASS_METHOD', 'Relevant instance method must be unique.', owner);
    this.methodName(methods[0]!);
    return methods[0]!;
  }

  private selfCall(node: E.Node | null | undefined, field: StateRole, operation: string, args: (E.Node | null | undefined)[]): node is E.CallExpression {
    return call(node) && member(node.callee, operation) && this.stateMember(node.callee.object, field) && node.arguments.length === args.length && node.arguments.every((argument, index) => this.same(argument, args[index]));
  }

  private cacheKey(node: E.Node | null | undefined, request: E.Node): boolean {
    return member(node, 'cacheKey') && this.same(node.object, request);
  }

  private cacheCall(node: E.Node | null | undefined, field: StateRole, operation: string, request: E.Node): node is E.CallExpression {
    return call(node) && member(node.callee, operation) && this.stateMember(node.callee.object, field) && node.arguments.length === 1 && this.cacheKey(node.arguments[0], request);
  }

  private nullTest(node: E.Node | null | undefined, input: E.Node, operator: string): boolean {
    return node?.type === 'BinaryExpression' && node.operator === operator && this.same(node.left, input) && literal(node.right, null);
  }

  private blockedResult(node: E.Node | null | undefined, input: E.Node, cached: boolean, wait: boolean): boolean {
    const fields = properties(node, ['blocked', 'cached']);
    return !!fields && this.same(wait ? awaited(fields[0]!.value) : fields[0]!.value, input) && bool(fields[1]!.value, cached);
  }

  cache(candidate: Candidate, chain: RequestChain): StructuralEvidence {
    const { fetchMethod, blocking } = chain;
    this.methodName(fetchMethod);
    this.requestNeed(blocking.value.async, 'CACHE_FLOW', 'Cache method must directly start the proven request.', candidate.owner);
    this.methodName(blocking);
    const [, request] = this.params(blocking.value, 2, 'CACHE_FLOW');
    const body = statements(blocking.value), startup = body[0];
    this.requestNeed(body.length === 6 && startup?.type === 'VariableDeclaration' && startup.declarations.length === 2 && startup.declarations.every(item => item.id.type === 'Identifier'), 'CACHE_FLOW', 'Cache flow must start request then read cache before finite reuse branches.', blocking);
    const [pending, cached] = startup.declarations;
    const lookup = cached!.init;
    this.requestNeed(call(lookup) && lookup.callee.type === 'MemberExpression' && lookup.callee.object.type === 'ThisExpression' && key(lookup.callee) !== null && lookup.arguments.length === 1 && this.cacheKey(lookup.arguments[0], request!), 'CACHE_FLOW', 'Cache lookup must use the corresponding request cache key.', cached!);
    const cacheMethod = this.method(candidate.owner, key(lookup.callee)!);
    const hit = (node: E.Node | undefined, value: E.Node, fromCache: boolean): boolean => {
      if (node?.type !== 'IfStatement' || node.alternate || !this.nullTest(node.test, value, '!=')) return false;
      const result = returned(node.consequent), sequence = result ? expressions(result) : [];
      const discard = sequence[0], handler = call(discard) ? discard.arguments[0] : null;
      return sequence.length === 2 && call(discard) && member(discard.callee, 'catch') && this.same(discard.callee.object, pending!.id) && discard.arguments.length === 1 && handler?.type === 'ArrowFunctionExpression' && !handler.async && !handler.params.length && handler.body.type === 'BlockStatement' && !handler.body.body.length && this.blockedResult(sequence[1], value, fromCache, !fromCache);
    };
    this.requestNeed(hit(body[1], cached!.id, true), 'CACHE_DISCARDED_REQUEST', 'Cache hit must handle discarded new request rejection and return its old boolean with cached true.', body[1] ?? blocking);
    const previous = declared(body[2]);
    this.requestNeed(previous && this.cacheCall(previous.init, 'inflightRequests', 'get', request!), 'CACHE_INFLIGHT', 'Old inflight lookup must use the same request key.', body[2] ?? blocking);
    this.requestNeed(hit(body[3], previous.id, false), 'CACHE_DISCARDED_REQUEST', 'Inflight hit must handle discarded request rejection and await the old promise with cached false.', body[3] ?? blocking);
    const current = declared(body[4]), final = current?.init;
    const then = call(final) && member(final.callee, 'finally') ? final.callee.object : null;
    const save = call(then) && member(then.callee, 'then') && this.same(then.callee.object, pending!.id) && then.arguments.length === 1 ? then.arguments[0] : null;
    this.requestNeed(current && call(final) && final.arguments.length === 1 && save?.type === 'ArrowFunctionExpression' && !save.async && save.params.length === 1 && save.params[0]?.type === 'Identifier' && save.body.type !== 'BlockStatement', 'CACHE_RECORD', 'New inflight promise must derive from pending.then followed by finally.', body[4] ?? blocking);
    const saved = expressions(save.body), write = saved[0], fields = call(write) ? properties(write.arguments[1], ['blocked', 'timestampMs']) : null;
    this.requestNeed(saved.length === 2 && call(write) && member(write.callee, 'set') && this.stateMember(write.callee.object, 'cache') && write.arguments.length === 2 && this.cacheKey(write.arguments[0], request!) && fields && this.same(fields[0]?.value, save.params[0]) && call(fields[1]?.value) && this.stateMember(fields[1].value.callee, 'now') && !fields[1].value.arguments.length && this.same(saved[1], save.params[0]), 'CACHE_RECORD', 'New boolean and completion clock must be recorded under the same cache key, then returned unchanged.', save);
    const cleanup = final.arguments[0];
    this.requestNeed(cleanup?.type === 'ArrowFunctionExpression' && !cleanup.async && !cleanup.params.length && cleanup.body.type === 'BlockStatement' && cleanup.body.body.length === 1 && cleanup.body.body[0]?.type === 'ExpressionStatement', 'CACHE_CLEANUP', 'Finally must contain one synchronous identity-checked inflight cleanup.', final);
    const clear = cleanup.body.body[0].expression;
    this.requestNeed(clear.type === 'LogicalExpression' && clear.operator === '&&' && clear.left.type === 'BinaryExpression' && clear.left.operator === '===' && this.cacheCall(clear.left.left, 'inflightRequests', 'get', request!) && this.same(clear.left.right, current.id) && this.cacheCall(clear.right, 'inflightRequests', 'delete', request!), 'CACHE_CLEANUP', 'Cleanup may delete only the same current inflight promise.', clear);
    const output = returned(body[5]), sequence = output ? expressions(output) : [], store = sequence[0];
    this.requestNeed(sequence.length === 2 && call(store) && member(store.callee, 'set') && this.stateMember(store.callee.object, 'inflightRequests') && store.arguments.length === 2 && this.cacheKey(store.arguments[0], request!) && this.same(store.arguments[1], current.id) && this.blockedResult(sequence[1], current.id, false, true), 'CACHE_INFLIGHT', 'New inflight must be stored before awaiting the same promise and returning cached false.', body[5] ?? blocking);
    this.cached(cacheMethod);
    this.matchedFunction(blocking.value);
    return { kind: 'cache', range: range(blocking), description: 'Every call starts a new request before cache and inflight lookup; TTL is 86400000 ms, completion records boolean/time, cleanup deletes only the same current promise, and discarded request rejections are handled before old cache/promise reuse.' };
  }

  private cached(method: E.MethodDefinition): void {
    this.requestNeed(!method.value.async && !method.value.generator, 'CACHE_TTL', 'Cache lookup must be synchronous.', method);
    const [cacheKey] = this.params(method.value, 1, 'CACHE_TTL'), body = statements(method.value), entry = declared(body[0]), value = returned(body[1]);
    this.requestNeed(body.length === 2 && entry && this.selfCall(entry.init, 'cache', 'get', [cacheKey]) && value?.type === 'ConditionalExpression' && value.test.type === 'LogicalExpression' && value.test.operator === '||' && this.nullTest(value.test.left, entry.id, '=='), 'CACHE_TTL', 'Cache must read its key and treat missing or expired entries as misses.', method);
    const expired = value.test.right;
    this.requestNeed(expired.type === 'BinaryExpression' && expired.operator === '>=' && expired.left.type === 'BinaryExpression' && expired.left.operator === '-' && call(expired.left.left) && this.stateMember(expired.left.left.callee, 'now') && !expired.left.left.arguments.length && member(expired.left.right, 'timestampMs') && this.same(expired.left.right.object, entry.id) && expired.right.type === 'Identifier', 'CACHE_TTL', 'Expiry must compare current clock minus the corresponding completion timestamp against TTL inclusively.', expired);
    const ttl = this.binding(expired.right), declaration = ttl?.defs[0]?.node;
    const numeric = (node: E.Node | null | undefined): number | null => {
      if (node?.type === 'Literal' && typeof node.value === 'number' && Number.isFinite(node.value)) return node.value;
      if (node?.type !== 'BinaryExpression' || node.operator !== '*') return null;
      const left = numeric(node.left), right = numeric(node.right);
      return left !== null && right !== null ? left * right : null;
    };
    this.requestNeed(ttl && ttl.defs.length === 1 && declaration?.type === 'VariableDeclarator' && this.parents.get(this.parents.get(declaration)!) === this.program && range(declaration).end < range(method).start && numeric(declaration.init) === 86400000 && ttl.references.filter(reference => reference.isWrite()).length === 1, 'CACHE_TTL', 'TTL must be uniquely established finite numeric 24-hour scalar data before class use.', expired.right);
    this.read(expired.right);
    const miss = expressions(value.consequent), deletion = miss[0];
    this.requestNeed(miss.length === 2 && literal(miss[1], null) && deletion?.type === 'LogicalExpression' && deletion.operator === '&&' && this.nullTest(deletion.left, entry.id, '!=') && this.selfCall(deletion.right, 'cache', 'delete', [cacheKey]) && member(value.alternate, 'blocked') && this.same(value.alternate.object, entry.id), 'CACHE_TTL', 'Expired existing entries must be deleted; live entries must return their saved blocked boolean.', value);
    this.matchedFunction(method.value);
  }

  policy(candidate: Candidate, chain: RequestChain, receiver: ReceiverChain): StructuralEvidence {
    const { instance } = receiver;
    const uses = this.binding(instance.id)!.references.filter(reference => !reference.isWrite());
    this.requestNeed(uses.length === 1, 'POLICY_CONNECTION', 'Unique instance must have one direct checkUrl forwarding entry.', instance);
    const access = this.parents.get(uses[0]!.identifier), invoke = access && this.parents.get(access);
    this.requestNeed(access?.type === 'MemberExpression' && key(access) !== null && call(invoke), 'POLICY_CONNECTION', 'Instance entry must be a direct method invocation.', instance);
    const { entry } = chain;
    this.requestNeed(key(access) === this.methodName(entry), 'POLICY_CONNECTION', 'Policy must consume the exact request-building checkUrl entry, not another method.', invoke);
    const bridgeReturn = this.parents.get(invoke), bridgeBlock = bridgeReturn && this.parents.get(bridgeReturn), bridge = bridgeBlock && this.parents.get(bridgeBlock);
    this.requestNeed(bridge && fn(bridge) && bridge.type === 'FunctionDeclaration' && bridge.id && !bridge.async && !bridge.generator && statements(bridge).length === 1 && bridgeReturn?.type === 'ReturnStatement' && bridgeReturn.argument === invoke, 'POLICY_CONNECTION', 'Instance checkUrl result must be returned unchanged by one local bridge.', invoke);
    const inputs = this.params(bridge, 3, 'POLICY_CONNECTION');
    this.requestNeed(invoke.arguments.length === 3 && invoke.arguments.every((argument, index) => this.same(argument, inputs[index])) && entry.value.async && entry.value.params.length === 3 && statements(entry.value).length === 5, 'POLICY_CONNECTION', 'Bridge must forward the same runtime, site and backend into the proven checkUrl entry.', invoke);
    const bridgeBinding = this.track(bridge.id), calls = bridgeBinding.references.filter(reference => !reference.isWrite());
    this.requestNeed(calls.length === 1, 'POLICY_CONNECTION', 'One actual policy consumer must use the bridge; unused or multiple consumers are unproven.', bridge);
    const consumption = this.parents.get(calls[0]!.identifier);
    this.requestNeed(call(consumption) && consumption.callee === calls[0]!.identifier && consumption.arguments.length === 3, 'POLICY_CONNECTION', 'Policy must directly invoke the bridge.', calls[0]!.identifier);
    let consumer: E.Node | undefined = consumption;
    while (consumer && !fn(consumer)) consumer = this.parents.get(consumer);
    this.requestNeed(consumer && fn(consumer) && consumer.async && !consumer.generator, 'POLICY_CONNECTION', 'Actual blocked consumer must be an async policy function.', consumption);
    const body = statements(consumer);
    if (consumer.type === 'ArrowFunctionExpression' && consumer.params.length === 1) {
      const [site] = this.params(consumer, 1, 'POLICY_CONNECTION');
      const [runtime, input, backend] = consumption.arguments;
      this.requestNeed(runtime?.type === 'MemberExpression' && runtime.object.type === 'ThisExpression' && key(runtime) !== null && backend?.type === 'MemberExpression' && backend.object.type === 'ThisExpression' && key(backend) !== null && key(runtime) !== key(backend) && this.same(input, site), 'POLICY_CONNECTION', 'Inline policy must pass its site input with direct runtime/backend fields of its lexical owner.', consumption);
      const deny = body[0], test = deny?.type === 'IfStatement' && deny.test.type === 'ChainExpression' ? deny.test.expression : null;
      this.requestNeed(body.length === 1 && deny?.type === 'IfStatement' && !deny.alternate && member(test, 'blocked') && test.object.type === 'MemberExpression' && test.object.optional && key(test.object) === 'result' && awaited(test.object.object) === consumption && this.throws(deny.consequent), 'POLICY_BLOCKED', 'Inline policy must deny on the awaited bridge result optional result.blocked without replacing that result.', consumer);
      const property = this.parents.get(consumer), object = property && this.parents.get(property), field = object && this.parents.get(object);
      this.requestNeed(property?.type === 'Property' && property.value === consumer && !property.computed && property.kind === 'init' && object?.type === 'ObjectExpression' && field?.type === 'PropertyDefinition' && !field.static && !field.computed && field.value === object, 'POLICY_CONNECTION', 'Inline consumer must be installed directly in an instance policy table.', consumer);
      this.inlinePolicyReceiver(consumer, property, object, field, runtime, backend);
    } else {
      const parameters = this.params(consumer, 3, 'POLICY_CONNECTION');
      this.requestNeed(consumption.arguments.every((argument, index) => this.same(argument, parameters[index])), 'POLICY_CONNECTION', 'Policy invocation must retain runtime/site/backend input provenance.', consumption);
      const status = declared(body[0]), guard = body[1], deny = body[2];
      this.requestNeed(body.length === 3 && status && awaited(status.init) === consumption && guard?.type === 'IfStatement' && !guard.alternate && this.nullTest(guard.test, status.id, '==') && guard.consequent.type === 'ReturnStatement' && !guard.consequent.argument && deny?.type === 'IfStatement' && !deny.alternate && member(deny.test, 'blocked') && member(deny.test.object, 'result') && this.same(deny.test.object.object, status.id) && this.throws(deny.consequent), 'POLICY_BLOCKED', 'Actual policy must await checkUrl, return on missing status and throw on that same status.result.blocked.', consumer);
    }
    this.read(calls[0]!.identifier);
    this.matchedFunction(bridge);
    this.matchedFunction(consumer);
    this.matchedFunction(entry.value);
    for (const item of candidate.owner.body.body) if (item.type === 'MethodDefinition' && !this.provenMethods.has(item.value)) this.unusedThrowHelper(item, entry);
    this.requestNeed(candidate.owner.body.body.every(item => item.type !== 'MethodDefinition' || this.provenMethods.has(item.value)), 'CLASS_METHOD', 'Every class method must have a finite proven body; unknown methods can affect state or receivers.', candidate.owner);
    return { kind: 'consumption', range: range(consumer), description: 'The unique instance checkUrl entry returns request/result through the direct bridge to actual policy result.blocked denial; its existing catch returns undefined on request failure. An isolated unused throw helper is not consumption evidence.' };
  }

  /** The inline shape has a second receiver: close its class, instance and table. */
  private inlinePolicyReceiver(consumer: Fn, property: E.Property, object: E.ObjectExpression, field: E.PropertyDefinition, runtime: E.MemberExpression, backend: E.MemberExpression): void {
    const name = (node: E.Node): string | null => node.type === 'Identifier' ? node.name : node.type === 'Literal' && typeof node.value === 'string' ? node.value : null;
    const tableName = name(field.key), callbackName = name(property.key);
    const classBody = this.parents.get(field), owner = classBody && this.parents.get(classBody);
    this.requestNeed(tableName && callbackName && !['__proto__', 'constructor', 'prototype'].includes(tableName) && !['__proto__', 'constructor', 'prototype'].includes(callbackName) && object.properties.length === 1 && !property.method && owner?.type === 'ClassExpression' && !owner.superClass && owner.body.body.length === 1 && owner.body.body[0] === field, 'POLICY_RECEIVER', 'Inline policy owner must be a finite class with only its fresh single-callback policy table; inheritance and additional effects are unproven.', field);
    const declaration = this.parents.get(owner);
    this.requestNeed(declaration?.type === 'VariableDeclarator' && declaration.id.type === 'Identifier' && this.parents.get(this.parents.get(declaration)!) === this.program, 'POLICY_LIFECYCLE', 'Inline policy class needs a module-local binding and unique constructed receiver.', owner);
    const binding = this.track(declaration.id), uses = binding.references.filter(reference => !reference.isWrite());
    this.requestNeed(uses.length === 1, 'POLICY_LIFECYCLE', 'Inline policy class needs exactly one direct construction; an uninstantiated callback is not actual consumption.', owner);
    const construct = this.parents.get(uses[0]!.identifier), instance = construct && this.parents.get(construct);
    this.requestNeed(construct?.type === 'NewExpression' && construct.callee === uses[0]!.identifier && !construct.arguments.length && instance?.type === 'VariableDeclarator' && instance.id.type === 'Identifier' && this.parents.get(this.parents.get(instance)!) === this.program && range(construct).start > range(owner).end, 'POLICY_LIFECYCLE', 'Inline policy receiver must be constructed locally after class establishment, without arguments or aliases.', owner);
    this.read(uses[0]!.identifier);
    const receiver = this.track(instance.id);
    let entries = 0;
    for (const reference of receiver.references) {
      if (reference.isWrite()) continue; // The final binding gate rejects reassignment.
      const access = this.parents.get(reference.identifier), use = access && this.parents.get(access);
      this.requestNeed(access?.type === 'MemberExpression' && access.object === reference.identifier && !access.optional && key(access) !== null && range(access).start > range(construct).end, 'POLICY_RECEIVER', 'Inline policy receiver alias, escape or dynamic access is unproven.', reference.identifier);
      if (key(access) === tableName) {
        const invoke = use && this.parents.get(use);
        this.requestNeed(use?.type === 'MemberExpression' && use.object === access && !use.optional && key(use) === callbackName && call(invoke) && invoke.callee === use && invoke.arguments.length === consumer.params.length, 'POLICY_RECEIVER', 'Actual inline table and callback must only be used for direct entry calls; replacement, extraction and table escape are unproven.', access);
        entries++;
      } else {
        this.requestNeed([key(runtime), key(backend)].includes(key(access)) && use?.type === 'AssignmentExpression' && use.operator === '=' && use.left === access && this.parents.get(use)?.type === 'ExpressionStatement' && this.parents.get(this.parents.get(use)!) === this.program, 'POLICY_RECEIVER', 'Outer receiver may only establish its runtime/backend fields directly; other field access or mutation is unproven.', access);
      }
      this.allowedReads.add(reference.identifier);
    }
    this.requestNeed(entries > 0, 'POLICY_LIFECYCLE', 'Inline policy table needs a direct actual entry call; an unused table is not consumption evidence.', instance);
    walk(owner, node => {
      if (node.type === 'ThisExpression') this.requestNeed(node === runtime.object || node === backend.object, 'POLICY_RECEIVER', 'Inline lexical receiver escapes its proven runtime/backend reads.', node);
    });
  }

  private unusedThrowHelper(method: E.MethodDefinition, entry: E.MethodDefinition): void {
    this.methodName(method);
    const [runtime, site, backend] = this.params(method.value, 3, 'CLASS_METHOD'), body = statements(method.value), status = declared(body[0]), deny = body[1];
    const invoke = awaited(status?.init), test = deny?.type === 'IfStatement' && deny.test.type === 'ChainExpression' ? deny.test.expression : null;
    this.requestNeed(method.value.async && body.length === 2 && status && call(invoke) && this.selfMember(invoke.callee, this.methodName(entry)) && invoke.arguments.length === 3 && invoke.arguments.every((argument, index) => this.same(argument, [runtime, site, backend][index])) && member(test, 'blocked') && test.object.type === 'MemberExpression' && test.object.optional && key(test.object) === 'result' && this.same(test.object.object, status.id) && deny?.type === 'IfStatement' && !deny.alternate && this.throws(deny.consequent), 'CLASS_METHOD', 'Additional throw helper needs a finite nonmutating body; it cannot substitute for actual policy consumption.', method);
    this.matchedFunction(method.value);
  }

  /** Current-file impact checks complement the matched constructor and state lifecycle. */
  private requestReceiverEffects(owner: E.ClassExpression): void {
    this.requestNeed(!owner.superClass && owner.body.body.every(item => item.type !== 'StaticBlock' && !item.static && !item.computed), 'REQUEST_RECEIVER', 'Inherited, static or computed class effects can replace the request methods.', owner);
    const methods = owner.body.body.flatMap(item => item.type === 'MethodDefinition' && item.key.type === 'Identifier' ? [item.key.name] : []);
    const methodNames = new Set(methods);
    this.requestNeed(methodNames.size === methods.length && owner.body.body.every(item => item.type !== 'PropertyDefinition' || item.key.type !== 'Identifier' || !methodNames.has(item.key.name)), 'REQUEST_RECEIVER', 'Duplicate methods or instance fields can shadow the proven request method.', owner);
    walk(owner, node => {
      if (node.type !== 'ThisExpression') return;
      const use = this.parents.get(node);
      this.requestNeed(use?.type === 'MemberExpression' && use.object === node && !use.optional && key(use) !== null && !['__proto__', 'prototype', 'constructor'].includes(key(use)!), 'REQUEST_RECEIVER', 'Instance self escape or dynamic property access can change request methods.', node);
      const parent = this.parents.get(use);
      if (methodNames.has(key(use)!)) this.requestNeed(call(parent) && parent.callee === use, 'REQUEST_RECEIVER', 'Request method mutation, alias or extraction is unproven.', use);
      if (key(use) === this.state('getTurnMetadata')) {
        let enclosing: E.Node | undefined = use;
        while (enclosing && enclosing.type !== 'MethodDefinition') enclosing = this.parents.get(enclosing);
        const constructorAssignment = enclosing?.type === 'MethodDefinition' && enclosing.kind === 'constructor' && parent?.type === 'AssignmentExpression' && parent.operator === '=' && parent.left === use && parent.right.type === 'Identifier';
        this.requestNeed(constructorAssignment || call(parent) && parent.callee === use, 'REQUEST_RECEIVER', 'Request metadata accessor is replaced, extracted or escaped outside construction.', use);
      }
    });
    const declaration = this.parents.get(owner);
    this.requestNeed(declaration?.type === 'VariableDeclarator' && declaration.id.type === 'Identifier', 'REQUEST_RECEIVER', 'Request class needs a local binding for current-file impact checks.', owner);
    const binding = this.binding(declaration.id);
    this.requestNeed(binding, 'REQUEST_RECEIVER', 'Request class binding is ambiguous.', declaration);
    for (const reference of binding.references) {
      const node = reference.identifier, parent = this.parents.get(node);
      if (reference.isWrite()) { this.requestNeed(reference.init, 'REQUEST_RECEIVER', 'Request class binding is replaced.', node); continue; }
      this.requestNeed(parent?.type === 'NewExpression' && parent.callee === node && parent.arguments.length === 0, 'REQUEST_RECEIVER', 'Request class prototype mutation, alias, subclass or external escape is unproven.', node);
      const instance = this.parents.get(parent);
      this.requestNeed(instance?.type === 'VariableDeclarator' && instance.id.type === 'Identifier', 'REQUEST_RECEIVER', 'Constructed request receiver escapes its local binding.', parent);
      const receiver = this.binding(instance.id);
      this.requestNeed(receiver, 'REQUEST_RECEIVER', 'Request receiver binding is ambiguous.', instance);
      for (const use of receiver.references) {
        if (use.isWrite()) { this.requestNeed(use.init, 'REQUEST_RECEIVER', 'Request receiver binding is replaced.', use.identifier); continue; }
        const memberUse = this.parents.get(use.identifier), invocation = memberUse && this.parents.get(memberUse);
        this.requestNeed(memberUse?.type === 'MemberExpression' && memberUse.object === use.identifier && !memberUse.optional && key(memberUse) !== null && call(invocation) && invocation.callee === memberUse, 'REQUEST_RECEIVER', 'Request receiver alias, method extraction, mutation or unknown escape is unproven.', use.identifier);
        const methodName = key(memberUse);
        this.requestNeed(owner.body.body.some(item => item.type === 'MethodDefinition' && !item.static && !item.computed && item.key.type === 'Identifier' && item.key.name === methodName), 'REQUEST_RECEIVER', 'Request receiver invokes an unknown instance method.', invocation);
      }
    }
  }

  private requestValue(identifier: E.Identifier, calls: Set<E.Node>, returns: Set<E.Node>): void {
    const binding = this.track(identifier);
    for (const reference of binding.references) {
      const node = reference.identifier, parent = this.parents.get(node);
      if (reference.isWrite()) {
        this.requestNeed(reference.init, 'REQUEST_MUTATION', 'Request-chain values cannot be reassigned.', node);
        continue;
      }
      let allowed = false;
      if (call(parent) && calls.has(parent)) allowed = true;
      if (parent?.type === 'MemberExpression' && parent.object === node) {
        const name = key(parent);
        const read = name === 'cacheKey' || name === 'endpoint' || name === 'session_id' || name === 'turn_id';
        let target: E.Node = parent, outer = this.parents.get(target);
        while (outer && (outer.type === 'Property' && outer.value === target || outer.type === 'ObjectPattern' || outer.type === 'ArrayPattern' || outer.type === 'RestElement' || outer.type === 'AssignmentPattern' && outer.left === target)) { target = outer; outer = this.parents.get(target); }
        allowed = read && !(outer?.type === 'AssignmentExpression' && outer.left === target) && outer?.type !== 'UpdateExpression' && !(outer?.type === 'UnaryExpression' && outer.operator === 'delete') && !(outer?.type === 'ForOfStatement' && outer.left === target) && !(outer?.type === 'ForInStatement' && outer.left === target);
      }
      if (parent?.type === 'BinaryExpression' && ['==', '!='].includes(parent.operator) && literal(parent.right, null)) allowed = true;
      if (parent?.type === 'Property' && parent.value === node && returns.has(identifier) && parent.key.type === 'Identifier' && parent.key.name === 'request') allowed = true;
      // The HTTP method and transport have already had every statement matched.
      if (this.allowedReads.has(node)) allowed = true;
      this.requestNeed(allowed, 'REQUEST_ESCAPE', 'Request-chain value escapes its proven forwarding, field read or metadata use.', node);
      this.allowedReads.add(node);
    }
  }

  private requestBuilder(builder: Fn): void {
    this.requestNeed(builder.params.length === 2 && builder.params[0]?.type === 'Identifier', 'REQUEST_INPUT', 'Input builder must take site and optional request context.', builder);
    const site = builder.params[0], context = this.context(builder.params[1], true);
    const body = statements(builder), [empty, parse, protocol, hostStatement, missing, result] = body;
    const url = declared(empty), host = declared(hostStatement);
    this.requestNeed(body.length === 6 && url && !url.init && parse?.type === 'TryStatement' && !parse.finalizer && parse.handler && parse.block.body.length === 1 && parse.block.body[0]?.type === 'ExpressionStatement', 'REQUEST_INPUT', 'Input URL parsing must have one assignment and an error-only catch.', builder);
    const assignment = parse.block.body[0].expression;
    this.requestNeed(assignment.type === 'AssignmentExpression' && assignment.operator === '=' && this.same(assignment.left, url.id) && this.urlNew(assignment.right, site) && parse.handler.body.body.length === 1 && this.throws(parse.handler.body.body[0]), 'REQUEST_INPUT', 'The same site input must be parsed with standard URL; invalid input must throw.', parse);
    const protocolTest = protocol?.type === 'IfStatement' ? protocol.test : null;
    const scheme = (node: E.Node, value: string): boolean => node.type === 'BinaryExpression' && node.operator === '!==' && member(node.left, 'protocol') && this.same(node.left.object, url.id) && literal(node.right, value);
    this.requestNeed(protocol?.type === 'IfStatement' && !protocol.alternate && protocolTest?.type === 'LogicalExpression' && protocolTest.operator === '&&' && scheme(protocolTest.left, 'http:') && scheme(protocolTest.right, 'https:') && literal(returned(protocol.consequent), null), 'REQUEST_PROTOCOL', 'Input URL must reject protocols other than http and https.', protocol ?? builder);
    const lower = host?.init;
    const trim = call(lower) && member(lower.callee, 'toLowerCase') && lower.arguments.length === 0 ? lower.callee.object : null;
    this.requestNeed(host && call(trim) && member(trim.callee, 'trim') && trim.arguments.length === 0 && member(trim.callee.object, 'hostname') && this.same(trim.callee.object.object, url.id), 'REQUEST_HOST', 'Cache host must be trimmed lowercase hostname of the same input URL.', hostStatement ?? builder);
    this.requestNeed(missing?.type === 'IfStatement' && !missing.alternate && missing.test.type === 'BinaryExpression' && missing.test.operator === '===' && member(missing.test.left, 'length') && this.same(missing.test.left.object, host.id) && literal(missing.test.right, 0) && this.throws(missing.consequent), 'REQUEST_HOST', 'Empty normalized host must throw.', missing ?? builder);
    const conditional = returned(result);
    this.requestNeed(conditional?.type === 'ConditionalExpression' && call(conditional.test) && conditional.test.arguments.length === 1 && this.same(conditional.test.arguments[0], host.id) && literal(conditional.consequent, null), 'REQUEST_LOCALHOST', 'Local hosts must be excluded before building a request.', result ?? builder);
    this.localHost(this.directFunction(conditional.test.callee, 'REQUEST_LOCALHOST'));
    const fields = properties(conditional.alternate, ['cacheKey', 'displayUrl', 'endpoint']);
    this.requestNeed(fields, 'REQUEST_ENDPOINT', 'Request must contain exactly cacheKey, displayUrl and endpoint.', conditional.alternate);
    const cache = fields[0]!.value;
    this.requestNeed(cache.type === 'ConditionalExpression' && call(cache.test) && member(cache.test.callee, 'startsWith') && this.same(cache.test.callee.object, host.id) && cache.test.arguments.length === 1 && literal(cache.test.arguments[0], 'www.') && call(cache.consequent) && member(cache.consequent.callee, 'slice') && this.same(cache.consequent.callee.object, host.id) && cache.consequent.arguments.length === 1 && literal(cache.consequent.arguments[0], 4) && this.same(cache.alternate, host.id), 'REQUEST_CACHE_KEY', 'Cache key must remove only a leading www. from the normalized hostname.', cache);
    const display = fields[1]!.value, endpoint = fields[2]!.value;
    this.requestNeed(call(display) && display.arguments.length === 1 && this.same(display.arguments[0], url.id), 'REQUEST_DISPLAY', 'Display URL must be derived from the same parsed input.', display);
    this.display(this.directFunction(display.callee, 'REQUEST_DISPLAY'));
    this.requestNeed(call(endpoint) && endpoint.arguments.length === 2 && this.same(endpoint.arguments[0], url.id), 'REQUEST_ENDPOINT', 'Endpoint builder must receive the same parsed input URL.', endpoint);
    const passed = properties(endpoint.arguments[1], ['conversationId', 'turnId', 'urlRequestSource']);
    this.requestNeed(passed && passed.every((item, index) => this.same(item.value, context[index])), 'REQUEST_CONTEXT', 'Split builder must receive the unchanged corresponding context fields.', endpoint);
    this.endpoint(this.directFunction(endpoint.callee, 'REQUEST_ENDPOINT'));
    this.matchedFunction(builder);
  }

  private localHost(helper: Fn): void {
    const [host] = this.params(helper, 1, 'REQUEST_LOCALHOST');
    const flatten = (node: E.Node): E.Node[] => node.type === 'LogicalExpression' && node.operator === '||' ? [...flatten(node.left), ...flatten(node.right)] : [node];
    const value = returned(statements(helper)[0]);
    this.requestNeed(statements(helper).length === 1 && value, 'REQUEST_LOCALHOST', 'Local-host predicate must be one finite disjunction.', helper);
    const tests = flatten(value);
    const equals = (node: E.Node | undefined, value: string): boolean => node?.type === 'BinaryExpression' && node.operator === '===' && this.same(node.left, host) && literal(node.right, value);
    const suffix = tests[1];
    this.requestNeed(tests.length === 5 && equals(tests[0], 'localhost') && call(suffix) && member(suffix.callee, 'endsWith') && this.same(suffix.callee.object, host) && suffix.arguments.length === 1 && literal(suffix.arguments[0], '.localhost') && equals(tests[2], '127.0.0.1') && equals(tests[3], '[::1]') && equals(tests[4], '::1'), 'REQUEST_LOCALHOST', 'Localhost, its subdomains and IPv4/IPv6 loopback must retain the finite exclusion semantics.', helper);
    this.matchedFunction(helper);
  }

  private display(helper: Fn): void {
    const [url] = this.params(helper, 1, 'REQUEST_DISPLAY');
    const body = statements(helper), copy = declared(body[0]), text = declared(body[2]);
    const assignment = body[1]?.type === 'ExpressionStatement' ? body[1].expression : null;
    const value = returned(body[3]);
    this.requestNeed(body.length === 4 && copy && this.urlNew(copy.init, url!, 'origin') && assignment?.type === 'AssignmentExpression' && assignment.operator === '=' && member(assignment.left, 'pathname') && this.same(assignment.left.object, copy.id) && member(assignment.right, 'pathname') && this.same(assignment.right.object, url) && text && this.invoke(text.init, copy.id, 'toString', []) && value?.type === 'ConditionalExpression' && value.test.type === 'BinaryExpression' && value.test.operator === '===' && member(value.test.left, 'pathname') && this.same(value.test.left.object, copy.id) && literal(value.test.right, '/') && call(value.consequent) && member(value.consequent.callee, 'slice') && this.same(value.consequent.callee.object, text.id) && value.consequent.arguments.length === 2 && literal(value.consequent.arguments[0], 0) && value.consequent.arguments[1]?.type === 'UnaryExpression' && value.consequent.arguments[1].operator === '-' && literal(value.consequent.arguments[1].argument, 1) && this.same(value.alternate, text.id), 'REQUEST_DISPLAY', 'Display helper must copy origin/pathname and strip only the root trailing slash.', helper);
    this.matchedFunction(helper);
  }

  private endpoint(helper: Fn): void {
    this.requestNeed(helper.params.length === 2 && helper.params[0]?.type === 'Identifier', 'REQUEST_ENDPOINT', 'Endpoint helper needs URL and request context inputs.', helper);
    const url = helper.params[0], context = this.context(helper.params[1], false), body = statements(helper);
    const copy = declared(body[0]), endpoint = declared(body[2]);
    const assigns = body[1]?.type === 'ExpressionStatement' ? expressions(body[1].expression) : [];
    this.requestNeed(body.length === 4 && copy && this.urlNew(copy.init, url, 'origin') && assigns.length === 2 && assigns.every((item, index) => item.type === 'AssignmentExpression' && item.operator === '=' && member(item.left, index === 0 ? 'pathname' : 'search') && this.same(item.left.object, copy.id) && member(item.right, index === 0 ? 'pathname' : 'search') && this.same(item.right.object, url)), 'REQUEST_SITE_URL', 'site_url must copy origin, pathname and search of the same URL, excluding credentials and fragment.', helper);
    const address = endpoint?.init;
    this.requestNeed(endpoint && address?.type === 'NewExpression' && address.callee.type === 'Identifier' && address.callee.name === 'URL' && !this.binding(address.callee) && address.arguments.length === 1 && address.arguments[0]?.type === 'TemplateLiteral' && address.arguments[0].expressions.length === 1 && address.arguments[0].quasis.map(item => item.value.cooked).join('|') === '|/aura/site_status', 'REQUEST_ENDPOINT', 'Endpoint must use standard URL and initialized backend plus /aura/site_status.', endpoint ?? helper);
    this.configuration(address.arguments[0].expressions[0]!, 'https://chatgpt.com/backend-api');
    const value = returned(body[3]), sequence = value ? expressions(value) : [];
    const set = (node: E.Node | undefined, name: string, input: E.Node | undefined, stringified = false): boolean => call(node) && member(node.callee, 'set') && member(node.callee.object, 'searchParams') && this.same(node.callee.object.object, endpoint.id) && node.arguments.length === 2 && literal(node.arguments[0], name) && (stringified ? this.invoke(node.arguments[1], copy.id, 'toString', []) : this.same(node.arguments[1], input));
    const optional = (node: E.Node | undefined, name: string, input: E.Node | undefined): boolean => node?.type === 'LogicalExpression' && node.operator === '&&' && node.left.type === 'BinaryExpression' && node.left.operator === '!=' && this.same(node.left.left, input) && literal(node.left.right, null) && set(node.right, name, input);
    this.requestNeed(sequence.length === 5 && set(sequence[0], 'site_url', copy.id, true) && set(sequence[1], 'url_request_source', context[2]) && optional(sequence[2], 'conversation_id', context[0]) && optional(sequence[3], 'turn_id', context[1]) && this.invoke(sequence[4], endpoint.id, 'toString', []), 'REQUEST_CONTEXT', 'Endpoint parameters must keep site_url, source and null-guarded conversation/turn values and return that endpoint.', helper);
    this.matchedFunction(helper);
  }

  private closeHostEffects(): void {
    const capabilities = new Set(['Object', 'Function', 'Set', 'TextEncoder', 'Error', 'URL', 'URLSearchParams', 'String', 'Map', 'Date', 'Promise', 'JSON', 'Array']);
    const aliases = new Set<Variable>();
    const codeGenerators = new Set<Variable>();
    // These wrappers can carry a value without changing its identity. Treat all
    // alternatives as possible; unsupported coercions/calls are not proof of a
    // capability becoming unrelated data.
    const carried = (node: E.Node, classify: (node: E.Node | null | undefined) => boolean): boolean => {
      if (node.type === 'LogicalExpression') return classify(node.left) || classify(node.right);
      if (node.type === 'SequenceExpression') return classify(node.expressions.at(-1));
      if (node.type === 'ConditionalExpression') return classify(node.consequent) || classify(node.alternate);
      if (node.type === 'AssignmentExpression' || node.type === 'AssignmentPattern') return classify(node.right);
      if (node.type === 'AwaitExpression' || node.type === 'SpreadElement' || node.type === 'RestElement') return classify(node.argument);
      if (node.type === 'ChainExpression') return classify(node.expression);
      return false;
    };
    const generatesCode = (node: E.Node | null | undefined): boolean => {
      if (!node) return false;
      if (node.type === 'Identifier') return this.standard(node, 'Function') || this.standard(node, 'eval') || codeGenerators.has(this.binding(node)!);
      if (node.type === 'MemberExpression') {
        if (key(node) === 'constructor' && host(node.object)) return true;
        if (globalObject(node.object) || host(node.object)) return key(node) === 'Function' || key(node) === 'eval' || key(node) === null;
      }
      if (node.type === 'ArrayExpression') return node.elements.some(item => generatesCode(item));
      if (node.type === 'ObjectExpression') return node.properties.some(item => generatesCode(item.type === 'Property' ? item.value : item.argument));
      return carried(node, generatesCode);
    };
    const globalAliases = new Set<Variable>();
    const globalObject = (node: E.Node | null | undefined): boolean => !!node && (node.type === 'Identifier' && (!this.binding(node) && ['globalThis', 'global'].includes(node.name) || globalAliases.has(this.binding(node)!)) || carried(node, globalObject));
    const finiteKeys = (node: E.Node, seen = new Set<Variable>()): string[] | null => {
      if (node.type === 'Identifier') {
        const binding = this.binding(node), declaration = binding?.defs[0]?.node;
        if (!binding || seen.has(binding) || binding.defs.length !== 1 || declaration?.type !== 'VariableDeclarator' || !declaration.init || binding.references.filter(reference => reference.isWrite()).some(reference => !reference.init)) return null;
        return finiteKeys(declaration.init, new Set([...seen, binding]));
      }
      if (node.type === 'Literal' && typeof node.value === 'string') return [node.value];
      if (node.type === 'ConditionalExpression') { const yes = finiteKeys(node.consequent, seen), no = finiteKeys(node.alternate, seen); return yes && no ? [...yes, ...no] : null; }
      if (node.type === 'BinaryExpression' && node.operator === '+' && node.left.type === 'Literal' && typeof node.left.value === 'string' && node.right.type === 'Literal' && typeof node.right.value === 'string') return [node.left.value + node.right.value];
      return null;
    };
    const unrelatedGlobalKey = (node: E.MemberExpression): boolean => {
      const names = key(node) !== null ? [key(node)!] : node.computed ? finiteKeys(node.property) : null;
      return !!names && names.every(name => !capabilities.has(name) && !['__proto__', 'prototype', 'constructor'].includes(name));
    };
    const host = (node: E.Node | null | undefined): boolean => {
      if (!node) return false;
      if (node.type === 'Identifier') return aliases.has(this.binding(node)!) || !this.binding(node) && capabilities.has(node.name);
      if (node.type === 'MemberExpression') return host(node.object) || globalObject(node.object) && !unrelatedGlobalKey(node);
      if (call(node) && member(node.callee, 'getPrototypeOf') && this.standard(node.callee.object, 'Object') && node.arguments.length === 1) return host(node.arguments[0]);
      if (fn(node) && node.body.type !== 'BlockStatement') return host(node.body) || globalObject(node.body);
      if (node.type === 'ConditionalExpression') return host(node.consequent) || globalObject(node.consequent) || host(node.alternate) || globalObject(node.alternate);
      if (node.type === 'ArrayExpression') return node.elements.some(item => item && (host(item) || globalObject(item)));
      if (node.type === 'ObjectExpression') return node.properties.some(item => item.type === 'Property' ? host(item.value) || globalObject(item.value) : host(item.argument) || globalObject(item.argument));
      return carried(node, value => host(value) || globalObject(value));
    };
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of this.nodes) {
        const left = node.type === 'VariableDeclarator' ? node.id : node.type === 'AssignmentExpression' ? node.left : null;
        const right = node.type === 'VariableDeclarator' ? node.init : node.type === 'AssignmentExpression' ? node.right : null;
        if (!left || !right) continue;
        const identifiers = (pattern: E.Node): E.Identifier[] => {
          if (pattern.type === 'Identifier') return [pattern];
          if (pattern.type === 'ArrayPattern') return pattern.elements.flatMap(item => item ? identifiers(item) : []);
          if (pattern.type === 'ObjectPattern') return pattern.properties.flatMap(item => identifiers(item.type === 'Property' ? item.value : item.argument));
          if (pattern.type === 'AssignmentPattern') return identifiers(pattern.left);
          if (pattern.type === 'RestElement') return identifiers(pattern.argument);
          return [];
        };
        const targets = identifiers(left);
        for (const target of targets) {
          const binding = this.binding(target), values: E.Node[] = [right];
          let ancestor: E.Node | undefined = target;
          while (ancestor && ancestor !== left) {
            ancestor = this.parents.get(ancestor);
            if (ancestor?.type === 'AssignmentPattern') values.push(ancestor.right);
          }
          const globalDestructure = left.type !== 'Identifier' && values.some(globalObject);
          if (binding && (values.some(generatesCode) || globalDestructure) && !codeGenerators.has(binding)) { codeGenerators.add(binding); changed = true; }
          if (binding && (values.some(value => host(value) && !globalObject(value)) || globalDestructure) && !aliases.has(binding)) { aliases.add(binding); changed = true; }
          if (binding && values.some(globalObject) && !globalAliases.has(binding)) { globalAliases.add(binding); changed = true; }
        }
      }
    }
    for (const node of this.nodes) {
      const unsupportedTransfer = node.type === 'AssignmentPattern' ? node.right : node.type === 'ForOfStatement' || node.type === 'ForInStatement' ? node.right : node.type === 'ThrowStatement' || node.type === 'YieldExpression' ? node.argument : null;
      requireStage(this.hostDefaults.has(node) || !host(unsupportedTransfer) && !globalObject(unsupportedTransfer), 'DEFERRED_HOST_MUTATION', 'Relevant capability propagation through defaults, iteration, exceptions or yield is outside the finite host proof.', node);
      if (node.type === 'CallExpression' || node.type === 'NewExpression') {
        const invoked = node.callee.type === 'SequenceExpression' ? node.callee.expressions.at(-1) : node.callee;
        requireStage(!generatesCode(invoked), 'DEFERRED_DYNAMIC_SCOPE', 'Dynamic code generation cannot preserve relevant standard capabilities.', node);
      }
      const written = node.type === 'AssignmentExpression' ? node.left : node.type === 'UpdateExpression' ? node.argument : node.type === 'UnaryExpression' && node.operator === 'delete' ? node.argument : node.type === 'ForInStatement' || node.type === 'ForOfStatement' ? node.left : null;
      const checkWrite = (target: E.Node): void => {
        const aliasSetup = target === written && node.type === 'AssignmentExpression' && node.operator === '=' && (host(node.right) || globalObject(node.right));
        requireStage(!(target.type === 'MemberExpression' && (host(target) || host(target.object) || globalObject(target.object) && !unrelatedGlobalKey(target))) && !(target.type === 'Identifier' && host(target) && !aliasSetup), 'DEFERRED_HOST_MUTATION', 'Current-file mutation of a relevant standard capability or its alias is unproven.', target);
        // A member's computed key is evaluated, not assigned. Its calls are
        // inspected separately; String(key) does not mutate the String binding.
        if (target.type === 'ArrayPattern') for (const item of target.elements) if (item) checkWrite(item);
        if (target.type === 'ObjectPattern') for (const item of target.properties) checkWrite(item.type === 'RestElement' ? item.argument : item.value);
        if (target.type === 'AssignmentPattern') checkWrite(target.left);
      };
      if (written) checkWrite(written);
      if (node.type === 'ExportNamedDeclaration' && node.declaration?.type === 'VariableDeclaration') for (const item of node.declaration.declarations) requireStage(!host(item.init) && !globalObject(item.init), 'DEFERRED_HOST_MUTATION', 'Exported standard capabilities can be changed by unknown consumers.', node);
      if (node.type === 'ExportSpecifier') requireStage(!host(node.local) && !globalObject(node.local), 'DEFERRED_HOST_MUTATION', 'Relevant standard capability alias escapes through export.', node);
      if (node.type === 'ExportDefaultDeclaration' && node.declaration.type !== 'FunctionDeclaration' && node.declaration.type !== 'ClassDeclaration') requireStage(!host(node.declaration) && !globalObject(node.declaration), 'DEFERRED_HOST_MUTATION', 'Relevant standard capability escapes through default export.', node);
      if (node.type === 'ReturnStatement' && (host(node.argument) || globalObject(node.argument))) requireStage(false, 'DEFERRED_HOST_MUTATION', 'Returning a relevant capability to unknown callers is unproven.', node);
      if (node.type === 'AssignmentExpression' && node.left.type === 'MemberExpression' && (host(node.right) || globalObject(node.right))) requireStage(false, 'DEFERRED_HOST_MUTATION', 'Relevant capability is stored on an externally reachable object.', node);
      if (node.type === 'TaggedTemplateExpression') requireStage(!node.quasi.expressions.some(item => host(item) || globalObject(item)), 'DEFERRED_HOST_MUTATION', 'Relevant capability escapes to a tagged template call.', node);
      if (node.type === 'NewExpression') for (const argument of node.arguments) requireStage(!host(argument) && !globalObject(argument), 'DEFERRED_HOST_MUTATION', 'Relevant standard capability escapes to an unknown constructor.', node);
      // Optional calls still transfer capabilities when their callee is present.
      if (node.type === 'CallExpression') {
        if (node.callee.type === 'MemberExpression' && host(node.callee.object)) {
          const operation = key(node.callee);
          const directStandard = node.callee.object.type === 'Identifier' && !this.binding(node.callee.object) && capabilities.has(node.callee.object.name);
          requireStage(this.ambient.provedCall(node) || directStandard && operation !== null && !['__defineGetter__', '__defineSetter__'].includes(operation), 'DEFERRED_HOST_MUTATION', 'Calls through a relevant capability alias, prototype or dynamic method are outside the finite host proof.', node);
        }
        for (const [index, argument] of node.arguments.entries()) if (host(argument) || globalObject(argument)) {
          const target = this.definition(node.callee), parameter = target?.params[index];
          const reads = parameter?.type === 'Identifier' ? this.binding(parameter)?.references : null;
          const observesType = !!target && !target.async && !!reads?.length && reads.every(reference => {
            const parent = this.parents.get(reference.identifier);
            return !reference.isWrite() && parent?.type === 'BinaryExpression' && parent.operator === 'instanceof' && parent.right === reference.identifier;
          });
          requireStage(observesType, 'DEFERRED_HOST_MUTATION', 'A relevant standard capability is passed to an unproven call or reflective mutation.', node);
        }
      }
    }
  }

  closeRelevantEffects(): void {
    for (const initializer of this.initializers.values()) for (const statement of statements(initializer.callback)) {
      if (statement.type !== 'ExpressionStatement') continue;
      for (const node of expressions(statement.expression)) if (node.type === 'AssignmentExpression' && node.left.type === 'Identifier' && this.tracked.has(this.binding(node.left)!)) this.allowedWrites.add(node.left);
    }
    for (const binding of this.tracked) {
      if (this.initializedData.has(binding)) requireStage(binding.references.filter(reference => reference.isWrite()).length === 1, 'DEFERRED_REASSIGNED_BINDING', 'Relevant initialization data must have exactly one assignment.', binding.identifiers[0] ?? this.program);
    }
    for (const binding of this.tracked) for (const reference of binding.references) {
      requireStage(reference.isWrite() ? reference.init || this.allowedWrites.has(reference.identifier) : this.allowedReads.has(reference.identifier), reference.isWrite() ? 'DEFERRED_REASSIGNED_BINDING' : 'DEFERRED_ESCAPED_BINDING', reference.isWrite() ? 'Relevant function, initializer or configuration binding is reassigned.' : 'Relevant function, initializer or configuration escapes its proven use.', reference.identifier);
    }
    // Keep established binding diagnostics first, then close every admitted
    // callback's assignment effects, including otherwise unused local settings.
    for (const initializer of this.initializers.values()) for (const statement of statements(initializer.callback)) {
      if (statement.type !== 'ExpressionStatement') continue;
      for (const expression of expressions(statement.expression)) if (expression.type === 'AssignmentExpression' && expression.left.type === 'Identifier') {
        const binding = this.binding(expression.left), declaration = binding?.defs[0]?.node;
        requireStage(binding?.defs.length === 1 && declaration?.type === 'VariableDeclarator' && this.parents.get(this.parents.get(declaration)!) === this.program, 'DEFERRED_INITIALIZER_EFFECT', 'Initializer assignments require a module-local data binding; unresolved global writes may invoke setters.', expression.left);
      }
    }
    // Lexically unrelated bundle calls/imports/writes are permitted. Dynamic scope
    // capabilities can access otherwise private bindings and are never unrelated.
    this.closeHostEffects();
    for (const node of this.nodes) {
      requireStage(node.type !== 'WithStatement' && !(call(node) && node.callee.type === 'Identifier' && node.callee.name === 'eval'), 'DEFERRED_DYNAMIC_SCOPE', 'Dynamic scope cannot preserve the relevant initialization and predicate bindings.', node);
    }
  }
}
