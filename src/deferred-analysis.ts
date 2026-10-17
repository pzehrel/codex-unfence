import { analyze } from 'eslint-scope';
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

interface Candidate { wrapper: Fn; generic: Fn; key: E.Identifier; consumption: E.CallExpression; owner: E.ClassExpression }
interface Initializer { binding: Variable; declaration: E.VariableDeclarator; callback: Fn; dependencies: Initializer[] }

/** A separate finite stage proof. It never grants a target or relaxes the legacy proof. */
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
    proof.closeRelevantEffects();
    result.evidence.push(initialization, {
      kind: 'predicate', range: range(candidate.wrapper),
      description: 'Object guards protect feature_status; the initialized agent key blocks only on strict equality to true. Stage evidence only.',
    });
    result.diagnostics.push(
      { code: 'UNPROVEN_REQUEST_CHAIN', severity: 'error', message: 'Request URL builder, runtime transport, HTTP success and JSON response binding remain unproven.', range: range(candidate.consumption) },
      { code: 'UNPROVEN_CACHE_POLICY', severity: 'error', message: 'Cache/inflight control flow, receiver identity and actual checkUrl to policy consumption remain unproven.', range: range(candidate.owner) },
      { code: 'DEFERRED_TRANSFORM_DISABLED', severity: 'error', message: 'Deferred stages do not establish structural compatibility; target, transformation and plan publication remain disabled.', range: range(candidate.consumption) },
    );
  } catch (error) {
    if (!(error instanceof UnprovenStage)) throw error;
    result.diagnostics.push({ code: error.code, severity: 'error', message: error.message, range: range(error.node) });
  }
  return result;
}

class DeferredProof {
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
          this.initialValue(expression.right, expression.left);
          const dataBinding = this.binding(expression.left);
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
      if (prior && writes && writeCount === 1 && this.same(items.at(-1), parameter)) return;
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
          if (caller) { this.checkEarlyActivation(caller, root, seen); continue; }
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

  private closeHostEffects(): void {
    const capabilities = new Set(['Object', 'Set', 'TextEncoder', 'Error']);
    const aliases = new Set<Variable>();
    const globalAliases = new Set<Variable>();
    const globalObject = (node: E.Node | null | undefined): boolean => node?.type === 'Identifier' && (!this.binding(node) && ['globalThis', 'global'].includes(node.name) || globalAliases.has(this.binding(node)!));
    const staticKey = (node: E.MemberExpression): string | null => {
      const direct = key(node);
      if (direct !== null) return direct;
      const property = node.property;
      return property.type === 'BinaryExpression' && property.operator === '+' && property.left.type === 'Literal' && typeof property.left.value === 'string' && property.right.type === 'Literal' && typeof property.right.value === 'string' ? property.left.value + property.right.value : null;
    };
    const host = (node: E.Node | null | undefined): boolean => {
      if (!node) return false;
      if (node.type === 'Identifier') return aliases.has(this.binding(node)!) || !this.binding(node) && capabilities.has(node.name);
      return node.type === 'MemberExpression' && (host(node.object) || globalObject(node.object) && staticKey(node) !== null && capabilities.has(staticKey(node)!));
    };
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of this.nodes) {
        const left = node.type === 'VariableDeclarator' ? node.id : node.type === 'AssignmentExpression' ? node.left : null;
        const right = node.type === 'VariableDeclarator' ? node.init : node.type === 'AssignmentExpression' ? node.right : null;
        if (!left || !right) continue;
        const targets = left.type === 'Identifier' ? [left] : left.type === 'ObjectPattern' ? left.properties.flatMap(item => item.type === 'Property' && item.value.type === 'Identifier' ? [item.value] : []) : [];
        for (const target of targets) {
          const binding = this.binding(target);
          if (binding && host(right) && !aliases.has(binding)) { aliases.add(binding); changed = true; }
          if (binding && globalObject(right) && !globalAliases.has(binding)) { globalAliases.add(binding); changed = true; }
        }
      }
    }
    for (const node of this.nodes) {
      const written = node.type === 'AssignmentExpression' ? node.left : node.type === 'UpdateExpression' ? node.argument : node.type === 'UnaryExpression' && node.operator === 'delete' ? node.argument : node.type === 'ForInStatement' || node.type === 'ForOfStatement' ? node.left : null;
      if (written) walk(written, target => {
        const aliasSetup = target === written && node.type === 'AssignmentExpression' && node.operator === '=' && (host(node.right) || globalObject(node.right));
        requireStage(!(target.type === 'MemberExpression' && (host(target) || host(target.object))) && !(target.type === 'Identifier' && host(target) && !aliasSetup), 'DEFERRED_HOST_MUTATION', 'Current-file mutation of a relevant standard capability or its alias is unproven.', target);
      });
      if (call(node)) {
        for (const [index, argument] of node.arguments.entries()) if (host(argument)) {
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
    // Lexically unrelated bundle calls/imports/writes are permitted. Dynamic scope
    // capabilities can access otherwise private bindings and are never unrelated.
    this.closeHostEffects();
    for (const node of this.nodes) {
      requireStage(node.type !== 'WithStatement' && !(call(node) && node.callee.type === 'Identifier' && node.callee.name === 'eval'), 'DEFERRED_DYNAMIC_SCOPE', 'Dynamic scope cannot preserve the relevant initialization and predicate bindings.', node);
    }
  }
}
