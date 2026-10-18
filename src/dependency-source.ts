import type { ParsedSource, SourceContext } from './source-context.js';
import { resourceProvenance } from './resource-provenance.js';
import { loaderConfigurationProof } from './loader-configuration-proof.js';
import { handleProvenance } from './handle-provenance.js';
import { descriptorProvenance } from './descriptor-provenance.js';
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
export function proveDependencySource(parsed: ParsedSource, resource: Parameters<typeof resourceProvenance>[2]): SourceProof {
  const proof: SourceProof = { evidence: [], diagnostics: [] };
  if (!parsed.context) { proof.diagnostics.push({ code: 'DEPENDENCY_SOURCE_PARSE', severity: 'error', message: 'Dependency source must parse as an ECMAScript module.' }); return proof; }
  const program = parsed.context.program;
  const graph = new SourceGraph(parsed.context);
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
  const resources = resourceProvenance(graph, initialization.factory, resource);
  proof.evidence.push(...resources.evidence.map(entry => ({ ...entry, range: { ...entry.range } })));
  const handles = handleProvenance(graph, initialization.factory, resources);
  proof.evidence.push(...handles.evidence.map(entry => ({ ...entry, range: { ...entry.range } })));
  const descriptors = descriptorProvenance(graph, initialization.factory, resources, resource);
  proof.evidence.push(...descriptors.evidence.map(entry => ({ ...entry, range: { ...entry.range } })));
  const loaderConfiguration = loaderConfigurationProof(graph, initialization.factory, resources, { loader, initialization: initialization.node, wrapper: initialization.wrapper, cache });
  proof.evidence.push(...loaderConfiguration.evidence.map(entry => ({ ...entry, range: { ...entry.range } })));
  const glue = graph.prototypeEffects(initialization.factory);
  proof.evidence.push(...glue.evidence);
  if (glue.blocker) return fail('DEPENDENCY_GLUE_EFFECT_UNPROVEN', 'A directly reached JavaScript glue prototype operation lacks a finite private constructor, receiver or method-effect proof. The resource contract does not cover this JavaScript write.', glue.blocker);
  return fail('DEPENDENCY_LIFETIME_UNPROVEN', 'Private cache references, all decode callsites, inherited hooks and the resource import consumer graph remain unproven.', cache);
}

class SourceGraph {
  readonly nodes: readonly E.Node[];
  readonly parents: ReadonlyMap<E.Node, E.Node>;
  readonly bindings: ReadonlyMap<E.Node, Variable>;
  readonly program: E.Program;
  constructor(readonly context: SourceContext) {
    this.program = context.program;
    this.nodes = context.nodes;
    this.parents = context.parents;
    this.bindings = context.bindings;
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
  // Discovery follows direct calls only. Each supported operation gets its own
  // summary; absence of a blocker never proves the remaining lifetime graph.
  prototypeEffects(factory: Fn): { evidence: StructuralEvidence[]; blocker: E.Node | null } {
    const evidence: StructuralEvidence[] = [], seen = new Set<Fn>([factory]);
    const inspect = (node: E.Node, owner: Fn): E.Node | null => {
      if (fn(node) && node !== owner) return null;
      if (call(node)) {
        if (member(node.callee, 'assign') && this.standard(node.callee.object, 'Object')) {
          const prototype = this.prototypeOrigin(node.arguments[0]);
          if (prototype) {
            if (!this.privatePrototype(node, prototype, factory)) return node;
            evidence.push({ kind: 'receiver', range: position(node), description: 'This individual prototype installation has a closed private constructor and local instances. Every installed method has finite scalar effects on a proven private receiver; constructor, prototype and instance references cannot escape or replace methods. Standard-prototype and the remaining import/lifetime effects remain separate obligations.' });
          }
        }
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
    const blocker = inspect(factory.body, factory);
    if (blocker?.type === 'CallExpression') {
      const prototype = this.prototypeOrigin(blocker.arguments[0]);
      if (prototype) evidence.push(...this.registrationFieldStores(factory, prototype));
    }
    return { evidence, blocker };
  }
  // An operation-local summary, deliberately weaker than a private type proof.
  // It proves stores on a newly allocated receiver and traces their callback
  // location, not argument effects, scheduler behavior or returned-object use.
  registrationFieldStores(factory: Fn, prototype: E.MemberExpression): StructuralEvidence[] {
    const base = this.bindings.get(prototype.object);
    if (!this.immutable(base)) return [];
    const callbacks = new Set<Fn>();
    for (const reference of base!.references) {
      const access = this.parents.get(reference.identifier), callback = this.owner(reference.identifier);
      if (!member(access, 'prototype') || !fn(callback) || callback === factory) continue;
      const registration = this.parents.get(callback), importer = this.owner(callback);
      if (!call(registration) || registration.arguments[2] !== callback || callback.params.length !== 1 || callback.params[0]?.type !== 'Identifier' || callback.async || callback.generator || !fn(importer) || this.owner(importer) !== factory || !this.definition(registration.callee) || registration.arguments.length !== 3) continue;
      const identifiers = importer.type === 'FunctionDeclaration' && importer.id ? [importer.id] : this.parents.get(importer)?.type === 'VariableDeclarator' ? [(this.parents.get(importer) as E.VariableDeclarator).id] : [];
      const binding = identifiers[0] ? this.bindings.get(identifiers[0]) : undefined;
      const objectReference = binding?.references.some(use => {
        const property = this.parents.get(use.identifier), object = property ? this.parents.get(property) : undefined;
        return !use.isWrite() && property?.type === 'Property' && property.kind === 'init' && !property.computed && property.value === use.identifier && object?.type === 'ObjectExpression' && this.owner(object) === factory;
      });
      if (objectReference) callbacks.add(callback);
    }
    const evidence: StructuralEvidence[] = [];
    for (const callback of callbacks) {
      const candidates: E.NewExpression[] = [];
      walk(callback.body, node => { if (node.type === 'NewExpression' && this.owner(node) === callback) candidates.push(node); });
      for (const creation of candidates) {
        const constructor = this.definition(creation.callee), binding = this.bindings.get(creation.callee);
        if (!constructor || constructor.type !== 'FunctionDeclaration' || constructor.async || constructor.generator || this.owner(constructor) !== factory || constructor.params.some(parameter => parameter.type !== 'Identifier') || constructor.params.length !== creation.arguments.length || !this.immutable(binding)) continue;
        if (binding!.references.some(reference => {
          const parent = this.parents.get(reference.identifier);
          return parent?.type !== 'NewExpression' || parent.callee !== reference.identifier || !callbacks.has(this.owner(parent) as Fn);
        })) continue;
        const operations = body(constructor).flatMap(statement => statement.type === 'ExpressionStatement' ? statement.expression.type === 'SequenceExpression' ? statement.expression.expressions : [statement.expression] : []);
        if (!operations.length || body(constructor).some(statement => statement.type !== 'ExpressionStatement')) continue;
        const names = new Set<string>();
        const valid = operations.every(operation => {
          if (operation.type !== 'AssignmentExpression' || operation.operator !== '=' || operation.left.type !== 'MemberExpression' || operation.left.optional || operation.left.computed || operation.left.object.type !== 'ThisExpression' || operation.left.property.type !== 'Identifier') return false;
          const name = operation.left.property.name;
          if (['__proto__', 'prototype'].includes(name) || names.has(name)) return false;
          names.add(name);
          return constructor.params.some(parameter => this.same(parameter, operation.right)) || operation.right.type === 'ArrayExpression' && !operation.right.elements.length;
        });
        if (!valid) continue;
        for (const operation of operations) evidence.push({ kind: 'receiver', range: position(operation), description: 'This store creates a fresh own data field on the implicit receiver of a direct local new-construction. Its RHS only reads a formal parameter or allocates an empty array. The constructor binding is referenced only by new-constructions in structurally associated registration callbacks sharing this local base prototype. Argument evaluation, standard-prototype interference, callback/scheduler effects, descriptor publication and lifetime are NOT proved by this operation summary.' });
      }
    }
    return evidence;
  }
  prototypeOrigin(node: E.Node | undefined): E.MemberExpression | null {
    if (member(node, 'prototype')) return node;
    const binding = node ? this.bindings.get(node) : undefined, declaration = binding?.defs[0]?.node;
    return binding?.defs.length === 1 && declaration?.type === 'VariableDeclarator' && member(declaration.init, 'prototype') ? declaration.init : null;
  }
  owner(node: E.Node): Fn | E.Program {
    let parent = this.parents.get(node);
    while (parent && !fn(parent) && parent.type !== 'Program') parent = this.parents.get(parent);
    return parent as Fn | E.Program;
  }
  immutable(binding: Variable | undefined): boolean {
    return !!binding && binding.defs.length === 1 && binding.references.every(reference => !reference.isWrite() || reference.init);
  }
  directStatement(node: E.Node, owner: Fn): E.Statement | null {
    const parent = this.parents.get(node);
    if (parent?.type === 'ExpressionStatement' && this.parents.get(parent) === owner.body) return parent;
    if (parent?.type === 'VariableDeclarator') {
      const declaration = this.parents.get(parent);
      if (declaration?.type === 'VariableDeclaration' && declaration.declarations.length === 1 && this.parents.get(declaration) === owner.body) return declaration;
    }
    return null;
  }
  privatePrototype(operation: E.CallExpression, prototype: E.MemberExpression, factory: Fn): boolean {
    const constructor = this.definition(prototype.object), installer = this.owner(operation);
    if (!constructor || constructor.type !== 'FunctionDeclaration' || constructor.async || constructor.generator || this.owner(constructor) !== factory || !fn(installer) || installer === factory || this.owner(installer) !== factory || operation.arguments.length !== 2) return false;
    const methods = operation.arguments[1];
    if (methods?.type !== 'ObjectExpression' || !methods.properties.length || !this.immutable(this.bindings.get(prototype.object))) return false;
    const methodMap = new Map<string, Fn>();
    const callbackUses = new Map<Variable, Set<E.Node>>();
    const nameOf = (node: E.Node): string | null => node.type === 'Identifier' ? node.name : node.type === 'Literal' && typeof node.value === 'string' ? node.value : null;
    const safeName = (name: string | null): name is string => !!name && !['__proto__', 'prototype', 'constructor'].includes(name);
    for (const property of methods.properties) {
      if (property.type !== 'Property' || property.computed || property.kind !== 'init') return false;
      const name = nameOf(property.key);
      const method = property.value.type === 'FunctionExpression' ? property.value : property.value.type === 'Identifier' ? this.definition(property.value) : null;
      if (!safeName(name) || methodMap.has(name) || !method) return false;
      if (property.value.type === 'Identifier') {
        const binding = this.bindings.get(property.value);
        if (!this.immutable(binding) || this.owner(method) !== factory) return false;
        const uses = callbackUses.get(binding!) ?? new Set<E.Node>();
        uses.add(property.value);
        callbackUses.set(binding!, uses);
      }
      methodMap.set(name, method);
    }
    for (const [binding, uses] of callbackUses) if (binding.references.some(reference => !reference.init && !uses.has(reference.identifier))) return false;
    const ownFields = new Set<string>();
    for (const statement of body(constructor)) {
      if (statement.type !== 'ExpressionStatement') return false;
      const expressions = statement.expression.type === 'SequenceExpression' ? statement.expression.expressions : [statement.expression];
      for (const expression of expressions) {
        if (expression.type !== 'AssignmentExpression' || expression.operator !== '=' || expression.left.type !== 'MemberExpression' || expression.left.computed || expression.left.optional || expression.left.object.type !== 'ThisExpression') return false;
        const name = nameOf(expression.left.property);
        if (!safeName(name) || methodMap.has(name) || ownFields.has(name)) return false;
        ownFields.add(name);
      }
    }
    if (!ownFields.size) return false;
    // No prototype aliases beyond the single installer-local alias, if present.
    const target = operation.arguments[0];
    if (target !== prototype) {
      const alias = target ? this.bindings.get(target) : undefined, declaration = alias?.defs[0]?.node;
      if (!this.immutable(alias) || declaration?.type !== 'VariableDeclarator' || declaration.id.type !== 'Identifier' || declaration.init !== prototype || this.owner(declaration) !== installer || alias!.references.some(reference => !reference.init && reference.identifier !== target)) return false;
    }
    const statements = body(installer), installationStatement = this.directStatement(operation, installer);
    if (!installationStatement || installer.params.length || installer.async || installer.generator || statements.length !== (target === prototype ? 1 : 2) || statements.at(-1) !== installationStatement) return false;
    if (target !== prototype) {
      const first = statements[0];
      if (first?.type !== 'VariableDeclaration' || first.declarations.length !== 1 || first.declarations[0]?.init !== prototype) return false;
    }
    const installerBinding = installer.type === 'FunctionDeclaration' && installer.id ? this.bindings.get(installer.id) : undefined;
    if (!this.immutable(installerBinding) || installerBinding!.references.length !== 1) return false;
    const installationCall = this.parents.get(installerBinding!.references[0]!.identifier);
    if (!call(installationCall) || installationCall.callee !== installerBinding!.references[0]!.identifier || installationCall.arguments.length || !this.directStatement(installationCall, factory)) return false;
    const binding = this.bindings.get(prototype.object)!;
    const instances = new Map<Variable, E.NewExpression>();
    for (const reference of binding.references) {
      if (reference.identifier === prototype.object) continue;
      const creation = this.parents.get(reference.identifier), declaration = creation ? this.parents.get(creation) : undefined;
      if (creation?.type !== 'NewExpression' || creation.callee !== reference.identifier || declaration?.type !== 'VariableDeclarator' || declaration.init !== creation || declaration.id.type !== 'Identifier' || !this.directStatement(creation, factory) || position(creation).start <= position(installationCall).end || creation.arguments.length !== constructor.params.length || !creation.arguments.every(argument => this.scalarLiteral(argument))) return false;
      const instance = this.bindings.get(declaration.id);
      if (!this.immutable(instance)) return false;
      instances.set(instance!, creation);
    }
    if (!instances.size) return false;
    const tableUses = new Set<E.Node>(), receivers = new Map<Variable, E.Expression>(instances);
    for (const [instance] of instances) for (const reference of instance.references) {
      if (reference.init || tableUses.has(reference.identifier)) continue;
      const parent = this.parents.get(reference.identifier);
      const invocation = parent?.type === 'ArrowFunctionExpression' && parent.body === reference.identifier ? this.parents.get(parent) : parent;
      if (!call(invocation) || invocation.arguments[1] !== (parent?.type === 'ArrowFunctionExpression' ? parent : reference.identifier)) continue;
      const table = this.descriptorTable(invocation, factory, instances);
      if (!table) return false;
      for (const use of table.uses) tableUses.add(use);
      for (const [receiver, creation] of table.receivers) receivers.set(receiver, creation);
    }
    let consumers = 0;
    for (const [instance, creation] of receivers) {
      const declaration = this.parents.get(creation);
      if (declaration?.type !== 'VariableDeclarator') return false;
      const boundReceivers = new Set<E.Node>();
      for (const use of instance.references) {
        if (tableUses.has(use.identifier)) continue;
        if (use.init || boundReceivers.has(use.identifier)) continue;
        const access = this.parents.get(use.identifier), invocation = access ? this.parents.get(access) : undefined;
        if (access?.type !== 'MemberExpression' || access.object !== use.identifier || access.computed || access.optional) return false;
        const name = nameOf(access.property), method = name ? methodMap.get(name) : undefined;
        if (!method) return false;
        consumers++;
        if (member(invocation, 'bind') && invocation.object === access) {
          const bindingCall = this.parents.get(invocation), boundDeclaration = bindingCall ? this.parents.get(bindingCall) : undefined;
          if (!call(bindingCall) || bindingCall.callee !== invocation || bindingCall.arguments.length !== 1 || !this.same(bindingCall.arguments[0], declaration.id) || boundDeclaration?.type !== 'VariableDeclarator' || boundDeclaration.id.type !== 'Identifier' || boundDeclaration.init !== bindingCall || !this.directStatement(bindingCall, factory) || position(bindingCall).start <= position(creation).end) return false;
          boundReceivers.add(bindingCall.arguments[0]!);
          const bound = this.bindings.get(boundDeclaration.id);
          if (!this.immutable(bound)) return false;
          for (const reference of bound!.references) {
            if (reference.init) continue;
            const callsite = this.parents.get(reference.identifier);
            if (!call(callsite) || callsite.callee !== reference.identifier || !this.directStatement(callsite, factory) || position(callsite).start <= position(bindingCall).end || callsite.arguments.length !== method.params.length || !callsite.arguments.every(argument => this.scalarLiteral(argument))) return false;
          }
        } else if (!call(invocation) || invocation.callee !== access || !this.directStatement(invocation, factory) || position(invocation).start <= position(creation).end || invocation.arguments.length !== method.params.length || !invocation.arguments.every(argument => this.scalarLiteral(argument))) return false;
      }
    }
    if (!consumers) return false;
    const active = new Set<Fn>();
    const scalar = (node: E.Node | null | undefined, parameters: E.Identifier[]): boolean => {
      if (!node) return false;
      if (this.scalarLiteral(node) || node.type === 'Identifier' && parameters.some(parameter => this.same(parameter, node))) return true;
      if (node.type === 'MemberExpression') return !node.computed && !node.optional && node.object.type === 'ThisExpression' && node.property.type === 'Identifier' && ownFields.has(node.property.name);
      if (node.type === 'UnaryExpression') return ['!', '+', '-', '~', 'void', 'typeof'].includes(node.operator) && scalar(node.argument, parameters);
      if (node.type === 'BinaryExpression' || node.type === 'LogicalExpression') return !['in', 'instanceof'].includes(node.operator) && scalar(node.left, parameters) && scalar(node.right, parameters);
      if (node.type === 'ConditionalExpression') return scalar(node.test, parameters) && scalar(node.consequent, parameters) && scalar(node.alternate, parameters);
      if (node.type === 'SequenceExpression') return node.expressions.every(expression => scalar(expression, parameters));
      if (node.type === 'AssignmentExpression') return node.operator === '=' && node.left.type === 'MemberExpression' && !node.left.computed && !node.left.optional && node.left.object.type === 'ThisExpression' && node.left.property.type === 'Identifier' && ownFields.has(node.left.property.name) && scalar(node.right, parameters);
      if (call(node) && node.callee.type === 'MemberExpression' && !node.callee.computed && !node.callee.optional && node.callee.object.type === 'ThisExpression' && node.callee.property.type === 'Identifier') {
        const method = methodMap.get(node.callee.property.name);
        return !!method && node.arguments.length === method.params.length && node.arguments.every(argument => scalar(argument, parameters)) && finiteMethod(method);
      }
      return false;
    };
    const finiteMethod = (method: Fn): boolean => {
      if (method.async || method.generator || method.params.some(parameter => parameter.type !== 'Identifier') || active.has(method)) return false;
      active.add(method);
      const parameters = method.params as E.Identifier[];
      const finiteStatement = (statement: E.Statement): boolean => {
        if (statement.type === 'ExpressionStatement') return scalar(statement.expression, parameters);
        if (statement.type === 'ReturnStatement') return !statement.argument || scalar(statement.argument, parameters);
        if (statement.type === 'BlockStatement') return statement.body.every(finiteStatement);
        if (statement.type === 'IfStatement') return scalar(statement.test, parameters) && finiteStatement(statement.consequent) && (!statement.alternate || finiteStatement(statement.alternate));
        return false;
      };
      const result = body(method).every(finiteStatement);
      active.delete(method);
      return result;
    };
    return finiteMethod(constructor) && [...methodMap.values()].every(finiteMethod);
  }
  descriptorTable(registration: E.CallExpression, factory: Fn, instances: Map<Variable, E.NewExpression>): { uses: Set<E.Node>; receivers: Map<Variable, E.Expression> } | null {
    const registrationHelper = this.definition(registration.callee);
    let register = registrationHelper;
    let callbackProvider: Fn | null = null;
    if (registrationHelper && body(registrationHelper).length === 1) {
      const statement = body(registrationHelper)[0], forwarding = statement?.type === 'ExpressionStatement' ? statement.expression : null;
      if (call(forwarding) && registrationHelper.params.length === 2 && registrationHelper.params.every(parameter => parameter.type === 'Identifier') && forwarding.arguments.length === 2 && this.same(forwarding.arguments[0], registrationHelper.params[0]) && call(forwarding.arguments[1]) && this.same(forwarding.arguments[1].callee, registrationHelper.params[1]) && forwarding.arguments[1].arguments.length === 0) {
        callbackProvider = registrationHelper;
        register = this.definition(forwarding.callee);
      }
    }
    if (!register || register.type !== 'FunctionDeclaration' || register.async || register.generator || this.owner(register) !== factory || register.params.length !== 2 || register.params.some(parameter => parameter.type !== 'Identifier')) return null;
    const [guard, write] = body(register);
    if (body(register).length !== 2 || guard?.type !== 'IfStatement' || guard.alternate || !call(guard.test) || !member(guard.test.callee, 'hasOwn') || !this.standard(guard.test.callee.object, 'Object') || guard.test.arguments.length !== 2 || !this.same(guard.test.arguments[1], register.params[0]) || !this.finiteThrow(guard.consequent) || write?.type !== 'ExpressionStatement' || write.expression.type !== 'AssignmentExpression' || write.expression.operator !== '=' || write.expression.left.type !== 'MemberExpression' || !write.expression.left.computed || write.expression.left.optional || !this.same(write.expression.left.property, register.params[0]) || !this.same(write.expression.right, register.params[1]) || !this.same(write.expression.left.object, guard.test.arguments[0])) return null;
    const table = write.expression.left.object, tableBinding = this.bindings.get(table), declaration = tableBinding?.defs[0]?.node;
    if (!this.immutable(tableBinding) || declaration?.type !== 'VariableDeclarator' || declaration.init?.type !== 'ObjectExpression' || declaration.init.properties.length || !this.directStatement(declaration.init, factory)) return null;
    const registerBinding = register.id ? this.bindings.get(register.id) : undefined;
    if (!this.immutable(registerBinding)) return null;
    const records = new Map<number, E.CallExpression>(), uses = new Set<E.Node>(), receivers = new Map<Variable, E.Expression>();
    const calls: { invocation: E.CallExpression; value: E.Node }[] = [];
    for (const reference of registerBinding!.references) {
      const invocation = this.parents.get(reference.identifier);
      if (!call(invocation) || invocation.callee !== reference.identifier || invocation.arguments.length !== 2) return null;
      if (callbackProvider && this.owner(invocation) === callbackProvider) {
        if (callbackProvider.type !== 'FunctionDeclaration' || callbackProvider.async || callbackProvider.generator || this.owner(callbackProvider) !== factory || !callbackProvider.id) return null;
        const providerBinding = this.bindings.get(callbackProvider.id);
        if (!this.immutable(providerBinding)) return null;
        for (const use of providerBinding!.references) {
          const callsite = this.parents.get(use.identifier), callback = call(callsite) ? callsite.arguments[1] : null;
          if (!call(callsite) || callsite.callee !== use.identifier || callsite.arguments.length !== 2 || !this.directStatement(callsite, factory) || callback?.type !== 'ArrowFunctionExpression' || callback.async || callback.generator || callback.params.length || callback.body.type !== 'Identifier') return null;
          calls.push({ invocation: callsite, value: callback.body });
        }
      } else {
        if (!this.directStatement(invocation, factory) || !invocation.arguments[1]) return null;
        calls.push({ invocation, value: invocation.arguments[1] });
      }
    }
    for (const { invocation, value } of calls) {
      const key = invocation.arguments[0];
      if (key?.type !== 'Literal' || typeof key.value !== 'number' || !Number.isSafeInteger(key.value) || key.value <= 0 || records.has(key.value) || value.type !== 'Identifier') return null;
      const instance = this.bindings.get(value), creation = instance ? instances.get(instance) : undefined;
      if (!creation || position(creation).end >= position(invocation).start || position(declaration).end >= position(invocation).start) return null;
      records.set(key.value, invocation);
      uses.add(value);
    }
    let lookup: Fn | null = null;
    for (const reference of tableBinding!.references) {
      if (reference.init || reference.identifier === table || reference.identifier === guard.test.arguments[0]) continue;
      const owner = this.owner(reference.identifier);
      if (!fn(owner) || owner === register || lookup && lookup !== owner) return null;
      lookup = owner;
    }
    if (!lookup || lookup.type !== 'FunctionDeclaration' || this.owner(lookup) !== factory || lookup.async || lookup.generator || lookup.params.length !== 1 || lookup.params[0]?.type !== 'Identifier') return null;
    const [read, missing, returned] = body(lookup);
    const descriptor = read?.type === 'VariableDeclaration' && read.declarations.length === 1 ? read.declarations[0] : null;
    if (body(lookup).length !== 3 || !descriptor || descriptor.id.type !== 'Identifier' || descriptor.init?.type !== 'MemberExpression' || !descriptor.init.computed || descriptor.init.optional || !this.same(descriptor.init.object, table) || !this.same(descriptor.init.property, lookup.params[0]) || missing?.type !== 'IfStatement' || missing.alternate || missing.test.type !== 'BinaryExpression' || missing.test.operator !== '===' || !this.same(missing.test.left, descriptor.id) || !(missing.test.right.type === 'Identifier' && this.standard(missing.test.right, 'undefined') || missing.test.right.type === 'UnaryExpression' && missing.test.right.operator === 'void' && this.scalarLiteral(missing.test.right.argument)) || !this.finiteThrow(missing.consequent) || returned?.type !== 'ReturnStatement' || !this.same(returned.argument, descriptor.id)) return null;
    const lookupBinding = lookup.id ? this.bindings.get(lookup.id) : undefined;
    if (!this.immutable(lookupBinding)) return null;
    for (const reference of lookupBinding!.references) {
      const invocation = this.parents.get(reference.identifier), selected = invocation ? this.parents.get(invocation) : undefined;
      if (!call(invocation) || invocation.callee !== reference.identifier || invocation.arguments.length !== 1 || selected?.type !== 'VariableDeclarator' || selected.id.type !== 'Identifier' || selected.init !== invocation || !this.directStatement(invocation, factory)) return null;
      const key = invocation.arguments[0], registered = key?.type === 'Literal' && typeof key.value === 'number' ? records.get(key.value) : null;
      const binding = this.bindings.get(selected.id);
      if (!registered || position(registered).end >= position(invocation).start || !this.immutable(binding)) return null;
      receivers.set(binding!, invocation);
    }
    return { uses, receivers };
  }
  finiteThrow(node: E.Statement): boolean {
    return node.type === 'ThrowStatement' && node.argument.type === 'CallExpression' && !node.argument.optional && this.standard(node.argument.callee, 'Error') && node.argument.arguments.length === 1 && node.argument.arguments[0]?.type === 'Literal' && typeof node.argument.arguments[0].value === 'string';
  }
  scalarLiteral(node: E.Node): boolean {
    return node.type === 'Literal' && (node.value === null || ['string', 'number', 'boolean'].includes(typeof node.value)) || node.type === 'UnaryExpression' && ['!', '+', '-', '~', 'void'].includes(node.operator) && this.scalarLiteral(node.argument);
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
