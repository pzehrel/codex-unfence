import { parse } from 'acorn';
import type { Variable } from 'eslint-scope';
import type * as E from 'estree';
import type { SourceRange, StructuralEvidence } from './analysis.js';

// Private, finite syntax/value proof. These records are never effect waivers.
// In particular an import cycle or a conditional origin cannot discharge itself.
type Fn = E.FunctionDeclaration | E.FunctionExpression | E.ArrowFunctionExpression;
interface ResourceInterface {
  imports: { module: string; name: string; parameters: string[]; results: string[] }[];
  exports: { name: string; kind: number; index: number }[];
}
interface Graph {
  nodes: E.Node[];
  parents: Map<E.Node, E.Node>;
  bindings: Map<E.Node, Variable>;
  definition(node: E.Node): Fn | null;
  same(a: E.Node | null | undefined, b: E.Node | null | undefined): boolean;
  standard(node: E.Node, name: string): boolean;
  owner(node: E.Node): Fn | E.Program;
}
const summaryBrand = Symbol('resource-summary');
const callbackBrand = Symbol('resource-callback');
class VerifierIdentity { declare private verifierIdentity: void }
function verifiedRecord<T extends object>(fields: T): T & VerifierIdentity {
  const record = Object.assign(new VerifierIdentity(), fields);
  Object.freeze(record);
  return record;
}

// Private module interface. AST nodes and scope variables are borrowed identities
// from this analysis, not copies, public proof inputs or effect authorizations.
type ResourceEvidence = Readonly<Omit<StructuralEvidence, 'range'> & { range: Readonly<SourceRange> }>;
export interface ResourceSummary extends VerifierIdentity {
  readonly [summaryBrand]: true;
  readonly evidence: readonly ResourceEvidence[];
  readonly callbacks: readonly ResourceCallback[];
}
export interface ResourceRequirement {
  readonly id: keyof typeof requirementDescriptions | 'unsupported-structure';
  readonly operation: E.Node;
  readonly allocation: E.NewExpression | E.ObjectExpression | E.ArrayExpression | null;
  readonly state: 'unsatisfied';
  readonly detail?: string;
}
type CallbackField = 'rawDestructor' | 'getActualType' | 'upcast' | 'downcast';
interface BoundFunction { readonly node: Fn; readonly binding: Variable }
interface BoundValue { readonly formal: E.Pattern; readonly binding: Variable }
interface ResourceFlow {
  readonly imports: E.ObjectExpression;
  readonly namespace: E.Property;
  readonly importTable: E.ObjectExpression;
  readonly importsBinding: Variable;
  readonly instantiate: E.CallExpression;
  readonly bytes: BoundFunction;
  readonly bytesCall: E.CallExpression;
  readonly route: BoundFunction;
  readonly routeCall: E.CallExpression;
  readonly initializer: BoundFunction;
  readonly initializerCall: E.CallExpression;
  readonly receiveResult: BoundFunction;
  readonly resultCall: E.CallExpression;
  readonly receive: BoundFunction;
  readonly receiveCalls: readonly E.CallExpression[];
  readonly saveExports: E.AssignmentExpression;
  readonly assignExports: E.CallExpression;
  readonly exportAssignment: BoundFunction;
}
type CallbackOrigin = Readonly<{
  kind: 'resource-table-function';
  tableBinding: Variable;
  tableStore: E.AssignmentExpression;
  tableExport: E.MemberExpression;
  lookup: BoundFunction;
  lookupCall: E.CallExpression;
  cacheBinding: Variable;
  cacheAllocation: E.ArrayExpression;
}> | Readonly<{
  kind: 'closed-signature-wrapper';
  wrapper: BoundFunction;
  wrapperCall: E.CallExpression;
  closure: Fn;
  captures: Readonly<{ signature: Variable; pointer: Variable; flag: Variable; invoke: Variable }>;
  invoke: BoundFunction;
  wide: BoundFunction;
  functionsBinding: Variable;
  functionsAllocation: E.ObjectExpression;
  exports: readonly Readonly<{ store: E.AssignmentExpression; source: E.MemberExpression }>[];
}> | Readonly<{
  // Only the guarded syntax is established. Zero still requires the i32 ABI
  // and invocation/lifetime conditions; this is not a proved scalar value.
  kind: 'guarded-optional-zero';
  guard: E.LogicalExpression;
  pointerBinding: Variable;
}>;
export interface ResourceCallback extends VerifierIdentity { readonly [callbackBrand]: true }
export interface ResourceCallbackFacts extends VerifierIdentity {
  readonly [callbackBrand]: true;
  readonly operation: E.AssignmentExpression;
  readonly allocation: E.NewExpression;
  readonly field: CallbackField;
  readonly constructor: BoundFunction;
  readonly arguments: readonly Readonly<{ index: number; argument: E.Node; argumentBinding: Variable | null; formal: E.Pattern; formalBinding: Variable | null }>[];
  readonly importer: BoundFunction;
  readonly importProperty: E.Property;
  readonly scheduler: Readonly<{ call: E.CallExpression; callback: Fn; target: BoundFunction }>;
  readonly conversion: Readonly<{
    assignment: E.AssignmentExpression;
    call: E.CallExpression;
    pointer: BoundValue;
    signature: BoundValue;
    argumentIndex: number;
    guard: E.LogicalExpression | null;
    resolver: BoundFunction;
    selector: BoundFunction;
    selection: E.ConditionalExpression;
  }>;
  readonly resource: ResourceFlow;
  readonly origins: readonly CallbackOrigin[];
  readonly references: readonly E.Node[];
  readonly requirements: readonly ResourceRequirement[];
}
const summaryContexts = new WeakMap<ResourceSummary, { graph: Graph; factory: Fn; callbacks: readonly ResourceCallbackFacts[] }>();

/** Reject summaries from another parsed graph/factory, including equal text. */
export function resourceCallbacks(summary: ResourceSummary, graph: Graph, factory: Fn): readonly ResourceCallbackFacts[] | null {
  const context = summaryContexts.get(summary);
  return context?.graph === graph && context.factory === factory ? context.callbacks : null;
}

interface Operation {
  role: string;
  node: E.Node;
  receiver: E.Node;
  origin: 'resource-instance' | 'resource-table' | 'resource-function' | 'closed-wrapper' | 'resource-function-or-closed-wrapper' | 'own-record';
  effects: string;
  references: E.Node[];
  requirements: readonly ResourceRequirement[];
  status: 'proved' | 'conditional' | 'pruned' | 'unknown';
}
interface MetadataField {
  node: E.AssignmentExpression;
  receiver: E.NewExpression;
  name: CallbackField;
  constructor: Fn;
  callback: Fn;
  scheduled: E.CallExpression;
  scheduler: Fn;
  formal: number;
  conversion: E.CallExpression;
  assignment: E.AssignmentExpression;
  pointer: E.Pattern;
  signature: E.Pattern;
  guard: E.LogicalExpression | null;
}
const fn = (node: E.Node | null | undefined): node is Fn => !!node && ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type);
const call = (node: E.Node | null | undefined): node is E.CallExpression => node?.type === 'CallExpression' && !node.optional;
const statements = (node: Fn): E.Statement[] => node.body.type === 'BlockStatement' ? node.body.body : [];
const expressions = (node: E.Node | null | undefined): E.Expression[] => node?.type === 'SequenceExpression' ? node.expressions : node && ['AssignmentExpression', 'CallExpression', 'LogicalExpression', 'Identifier', 'MemberExpression'].includes(node.type) ? [node as E.Expression] : [];
const range = (node: E.Node): SourceRange => { const located = node as E.Node & { start: number; end: number }; return { start: located.start, end: located.end, unit: 'utf16' }; };
const key = (node: E.Node | null | undefined): string | null => node?.type === 'Identifier' ? node.name : node?.type === 'Literal' && typeof node.value === 'string' ? node.value : null;
const member = (node: E.Node | null | undefined, name?: string): node is E.MemberExpression => node?.type === 'MemberExpression' && !node.optional && (name === undefined || key(node.property) === name && (!node.computed || node.property.type === 'Literal'));
const plain = (property: E.Property | E.SpreadElement): property is E.Property => property.type === 'Property' && property.kind === 'init' && !property.computed && !property.method && key(property.key) !== '__proto__';
// IDs are stable requirements; descriptions are only the public diagnostic
// projection. Several distinct obligations retain the existing grouped wording.
const requirementDescriptions = {
  'source-bytes': 'adjacent bytes, copy/options and cache call ordering must be closed',
  'copy-options': 'adjacent bytes, copy/options and cache call ordering must be closed',
  'cache-order': 'adjacent bytes, copy/options and cache call ordering must be closed',
  'hooks-absent': 'inherited instantiateWasm and hooks must be absent with all intervening JavaScript effects proved',
  'intervening-effects': 'inherited instantiateWasm and hooks must be absent with all intervening JavaScript effects proved',
  'decoder-effects': 'byte/signature decoders, initialization callbacks and error branches need individual effect proofs',
  'initialization-readiness': 'byte/signature decoders, initialization callbacks and error branches need individual effect proofs',
  'error-effects': 'byte/signature decoders, initialization callbacks and error branches need individual effect proofs',
  'abi-key-category': 'numeric ABI keys, own properties and unchanged standard prototypes must be proved',
  'own-data-property': 'numeric ABI keys, own properties and unchanged standard prototypes must be proved',
  'standard-prototypes': 'numeric ABI keys, own properties and unchanged standard prototypes must be proved',
  'scheduler-effects': 'scheduler, metadata publication and every later invocation/receiver/lifetime remain unproved',
  'metadata-publication': 'scheduler, metadata publication and every later invocation/receiver/lifetime remain unproved',
  'callback-invocation': 'scheduler, metadata publication and every later invocation/receiver/lifetime remain unproved',
  'callback-receiver': 'scheduler, metadata publication and every later invocation/receiver/lifetime remain unproved',
  'callback-lifetime': 'scheduler, metadata publication and every later invocation/receiver/lifetime remain unproved',
};
const requirementIds = Object.keys(requirementDescriptions) as (keyof typeof requirementDescriptions)[];
function renderRequirements(requirements: readonly ResourceRequirement[]): string {
  return [...new Set(requirements.map(requirement => requirement.id === 'unsupported-structure' ? requirement.detail! : requirementDescriptions[requirement.id]))].join('; ') || 'none for this individual syntax fact';
}
function renderEvidence(operations: readonly Operation[]): StructuralEvidence[] {
  return operations.map(operation => ({ kind: 'source', range: range(operation.node), description: `${operation.role}: ${operation.status}; ${operation.effects} Origin ${operation.origin}; ${operation.references.length} local references accounted for this operation. Remaining conditions: ${renderRequirements(operation.requirements)}. This record never authorizes a host effect or certifies a cycle.` }));
}

/** Read only the already parsed source and independently measured interface. */
export function resourceProvenance(graph: Graph, factory: Fn, resource: ResourceInterface): ResourceSummary {
  return new Provenance(graph, factory, resource).inspect();
}

class Provenance {
  readonly operations: Operation[] = [];
  readonly callbacks: ResourceCallbackFacts[] = [];
  constructor(readonly graph: Graph, readonly factory: Fn, readonly resource: ResourceInterface) {}
  local(node: E.Node): boolean {
    let owner = this.graph.owner(node);
    while (owner !== this.factory && owner.type !== 'Program') owner = this.graph.owner(owner);
    return owner === this.factory;
  }
  uses(identifier: E.Node): E.Node[] { return this.graph.bindings.get(identifier)?.references.filter(reference => !reference.init).map(reference => reference.identifier) ?? []; }
  immutable(identifier: E.Node): boolean {
    const binding = this.graph.bindings.get(identifier);
    return !!binding && binding.defs.length === 1 && binding.references.every(reference => !reference.isWrite() || reference.init);
  }
  bindingNode(node: Fn): E.Node | null {
    if (node.type === 'FunctionDeclaration') return node.id;
    const parent = this.graph.parents.get(node);
    return parent?.type === 'VariableDeclarator' ? parent.id : null;
  }
  closedFunction(node: Fn, allowed: (use: E.Node, parent: E.Node | undefined) => boolean): boolean {
    const id = this.bindingNode(node);
    return !!id && this.immutable(id) && this.uses(id).every(use => allowed(use, this.graph.parents.get(use)));
  }
  directCalls(node: Fn): E.CallExpression[] | null {
    const calls: E.CallExpression[] = [];
    return this.closedFunction(node, (use, parent) => {
      if (!call(parent) || parent.callee !== use) return false;
      calls.push(parent); return true;
    }) ? calls : null;
  }
  value(identifier: E.Node): E.Expression | null {
    const binding = this.graph.bindings.get(identifier), definition = binding?.defs[0]?.node;
    return binding?.defs.length === 1 && definition?.type === 'VariableDeclarator' ? definition.init : null;
  }
  requirements(node: E.Node, receiver: E.Node, ids = requirementIds): readonly ResourceRequirement[] {
    const allocation = receiver.type === 'NewExpression' || receiver.type === 'ObjectExpression' || receiver.type === 'ArrayExpression' ? receiver : null;
    return Object.freeze(ids.map(id => Object.freeze({ id, operation: node, allocation, state: 'unsatisfied' as const })));
  }
  record(role: string, node: E.Node, receiver: E.Node, origin: Operation['origin'], effects: string, references: E.Node[], ids = requirementIds): readonly ResourceRequirement[] {
    const requirements = this.requirements(node, receiver, ids);
    this.operations.push({ role, node, receiver, origin, effects, references, requirements, status: requirements.length ? 'conditional' : 'proved' });
    return requirements;
  }
  fail(node: E.Node, role: string, detail: string): ResourceSummary {
    const requirement: ResourceRequirement = Object.freeze({ id: 'unsupported-structure', operation: node, allocation: null, state: 'unsatisfied', detail });
    this.operations.push({ role, node, receiver: node, origin: 'own-record', effects: 'No origin or effect authorization.', references: [], requirements: [requirement], status: 'unknown' });
    return this.summary();
  }
  summary(): ResourceSummary {
    const callbacks = Object.freeze([...this.callbacks]);
    const summary: ResourceSummary = verifiedRecord({
      [summaryBrand]: true as const,
      evidence: Object.freeze(renderEvidence(this.operations).map(entry => Object.freeze({ ...entry, range: Object.freeze(entry.range) }))),
      callbacks: Object.freeze(callbacks.map((): ResourceCallback => verifiedRecord({ [callbackBrand]: true as const }))),
    });
    summaryContexts.set(summary, { graph: this.graph, factory: this.factory, callbacks });
    return summary;
  }
  bound(node: Fn, reference = this.bindingNode(node)!): BoundFunction {
    return Object.freeze({ node, binding: this.graph.bindings.get(reference)! });
  }
  // Exact small helper grammars, alpha-renamed using resolved binding identity.
  // This compares syntax only, never evaluates source or interprets arbitrary JS.
  shape(node: Fn, source: string): Map<string, E.Node> | null {
    const program = parse(`(${source})`, { ecmaVersion: 2022, sourceType: 'module' }) as unknown as E.Program;
    const statement = program.body[0];
    if (statement?.type !== 'ExpressionStatement') return null;
    const captures = new Map<string, E.Node>();
    const compare = (actual: unknown, expected: unknown, parent?: Record<string, unknown>, field?: string): boolean => {
      if (expected === null || typeof expected !== 'object') return actual === expected;
      if (!actual || typeof actual !== 'object') return false;
      if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => compare(actual[index], item));
      const a = actual as Record<string, unknown>, b = expected as Record<string, unknown>;
      if (b.type === 'Identifier') {
        if (a.type !== 'Identifier') return false;
        const name = String(b.name), id = actual as E.Identifier;
        const literalKey = field === 'property' && parent?.type === 'MemberExpression' && !parent.computed || field === 'key' && parent?.type === 'Property' && !parent.computed;
        if (literalKey) return a.name === b.name;
        if (name === 'arguments') return id.name === 'arguments' && !this.graph.bindings.get(id)?.defs.length;
        const previous = captures.get(name);
        if (previous) return this.graph.same(previous, id) || previous.type === 'Identifier' && previous.name === id.name && !this.graph.bindings.has(previous) && !this.graph.bindings.has(id);
        captures.set(name, id); return true;
      }
      // Literal regexp objects are compared through their ESTree regex fields.
      return Object.keys(b).filter(name => !['start', 'end', 'range', 'loc', 'raw', 'value'].includes(name) || name === 'value' && !b.regex).every(name => compare(a[name], b[name], b, name));
    };
    return compare(node, statement.expression) ? captures : null;
  }
  inspect(): ResourceSummary {
    const instantiations = this.graph.nodes.filter((node): node is E.CallExpression => call(node) && this.local(node) && member(node.callee, 'instantiate') && this.graph.standard(node.callee.object, 'WebAssembly'));
    if (instantiations.length !== 1) return this.summary();
    const instantiate = instantiations[0]!, bytesFunction = this.graph.owner(instantiate);
    if (!fn(bytesFunction) || bytesFunction.params.length !== 2 || instantiate.arguments.length !== 2 || !this.graph.same(instantiate.arguments[1], bytesFunction.params[1])) return this.fail(instantiate, 'Resource import association', 'instantiate must receive the selected import parameter without substitution');
    const instantiateAwait = this.graph.parents.get(instantiate), instantiateReturn = instantiateAwait && this.graph.parents.get(instantiateAwait);
    if (instantiateAwait?.type !== 'AwaitExpression' || instantiateReturn?.type !== 'ReturnStatement' || instantiateReturn.argument !== instantiateAwait) return this.fail(instantiate, 'Resource instance result', 'instantiate result must be returned directly, never substituted after a decoy operation');
    const byteReturns = this.graph.nodes.filter(node => node.type === 'ReturnStatement' && this.graph.owner(node) === bytesFunction);
    if (byteReturns.length !== 1 || byteReturns[0] !== instantiateReturn) return this.fail(bytesFunction, 'Resource instance result', 'every successful byte-instantiation return must be the resource result');
    if (!this.immutable(bytesFunction.params[1]!) || this.uses(bytesFunction.params[1]!).some(use => use !== instantiate.arguments[1])) return this.fail(instantiate, 'Resource import association', 'instantiate import formal has an additional writer, alias or unknown consumer');
    const byteCalls = this.directCalls(bytesFunction);
    if (byteCalls?.length !== 1) return this.fail(bytesFunction, 'Resource import association', 'byte-instantiation helper has an extra caller, write or escape');
    const byteCall = byteCalls[0]!, route = this.graph.owner(byteCall);
    if (!fn(route) || route.params.length !== 3 || byteCall.arguments.length !== 2 || !this.graph.same(byteCall.arguments[0], route.params[1]) || !this.graph.same(byteCall.arguments[1], route.params[2]) || this.graph.parents.get(byteCall)?.type !== 'ReturnStatement') return this.fail(byteCall, 'Resource import association', 'finite route must forward the same import binding');
    const routeReturns = this.graph.nodes.filter((node): node is E.ReturnStatement => node.type === 'ReturnStatement' && this.graph.owner(node) === route);
    if (routeReturns.some(statement => statement.argument !== byteCall && !(statement.argument?.type === 'AwaitExpression' && call(statement.argument.argument) && member(statement.argument.argument.callee, 'instantiateStreaming') && this.graph.standard(statement.argument.argument.callee.object, 'WebAssembly') && this.graph.same(statement.argument.argument.arguments[1], route.params[2])))) return this.fail(route, 'Resource instance result', 'route returns a value outside the finite resource-instantiation alternatives');
    if (!this.immutable(route.params[2]!) || this.uses(route.params[2]!).some(use => use !== byteCall.arguments[1] && !routeReturns.some(statement => statement.argument?.type === 'AwaitExpression' && call(statement.argument.argument) && statement.argument.argument.arguments[1] === use))) return this.fail(route, 'Resource import association', 'route import formal has an additional writer, alias or unknown consumer');
    const routeCalls = this.directCalls(route);
    if (routeCalls?.length !== 1) return this.fail(route, 'Resource import association', 'route helper has an extra caller, write or escape');
    const routeCall = routeCalls[0]!, initializer = this.graph.owner(routeCall);
    if (!fn(initializer) || routeCall.arguments.length !== 3 || routeCall.arguments[2]?.type !== 'Identifier') return this.fail(routeCall, 'Resource import association', 'finite initializer and its selected import binding are missing');
    const importsId = routeCall.arguments[2], importsCall = this.value(importsId);
    const importFactory = call(importsCall) ? this.graph.definition(importsCall.callee) : null;
    const importReturn = importFactory && statements(importFactory)[0];
    if (!call(importsCall) || importsCall.arguments.length || !importFactory || statements(importFactory).length !== 1 || importReturn?.type !== 'ReturnStatement' || importReturn.argument?.type !== 'ObjectExpression' || !this.closedFunction(importFactory, (use, parent) => parent === importsCall && importsCall.callee === use)) return this.fail(importsId, 'Resource import association', 'import allocation helper must have one closed call and one object return');
    const modules = importReturn.argument;
    if (modules.properties.length !== 1 || !modules.properties.every(plain)) return this.fail(modules, 'Resource import association', 'import namespace must be one own data property');
    const namespace = modules.properties[0]! as E.Property;
    if (namespace.value.type !== 'Identifier' || !this.immutable(namespace.value)) return this.fail(namespace, 'Resource import association', 'import function record must have immutable allocation identity');
    const importTable = this.value(namespace.value);
    if (importTable?.type !== 'ObjectExpression' || !importTable.properties.every(plain) || this.uses(namespace.value).some(use => use !== namespace.value)) return this.fail(namespace, 'Resource import association', 'import function record has a write, alias or publication beyond the finite namespace');
    const importers = new Set<Fn>(), importProperties = new Set<E.Node>(), names = new Set<string>();
    for (const property of importTable.properties as E.Property[]) {
      const name = key(property.key), target = this.graph.definition(property.value);
      if (!name || names.has(name) || !target || !this.local(target)) return this.fail(property, 'Resource import association', 'each import must be one distinct own data property containing a local function binding');
      names.add(name); importers.add(target); importProperties.add(property);
    }
    if (this.resource.imports.length !== names.size || this.resource.imports.some(item => item.module !== key(namespace.key) || !names.has(item.name))) return this.fail(importTable, 'Resource import association', 'source import module/name set differs from the independently decoded resource interface');
    const importOnly = (target: Fn): boolean => this.closedFunction(target, (use, parent) => !!parent && importProperties.has(parent) && (parent as E.Property).value === use);
    const initializerCalls = this.directCalls(initializer);
    if (initializerCalls?.length !== 1 || this.graph.owner(initializerCalls[0]!) !== this.factory || this.graph.parents.get(initializerCalls[0]!)?.type !== 'AwaitExpression') return this.fail(initializer, 'Resource import association', 'initializer must have one awaited factory caller and cannot escape');
    const resultAwait = this.graph.parents.get(routeCall), resultCall = resultAwait && this.graph.parents.get(resultAwait);
    const receiveResult = call(resultCall) ? this.graph.definition(resultCall.callee) : null;
    const received = receiveResult && statements(receiveResult)[0];
    if (resultAwait?.type !== 'AwaitExpression' || !call(resultCall) || resultCall.arguments.length !== 1 || resultCall.arguments[0] !== resultAwait || !receiveResult || statements(receiveResult).length !== 1 || received?.type !== 'ReturnStatement' || !call(received.argument) || received.argument.arguments.length !== 1 || !member(received.argument.arguments[0], 'instance') || !this.graph.same(received.argument.arguments[0].object, receiveResult.params[0]) || !this.closedFunction(receiveResult, (use, parent) => parent === resultCall && resultCall.callee === use)) return this.fail(routeCall, 'Resource instance result', 'awaited instantiate result must flow through a closed .instance receiver');
    const receive = this.graph.definition(received.argument.callee), receiveBody = receive && statements(receive)[0];
    const sequence = receiveBody?.type === 'ReturnStatement' ? expressions(receiveBody.argument) : [];
    const [save, assign, ready, returned] = sequence;
    if (!receive || sequence.length !== 4 || statements(receive).length !== 1 || save?.type !== 'AssignmentExpression' || save.operator !== '=' || !member(save.right, 'exports') || !this.graph.same(save.right.object, receive.params[0]) || !call(assign) || assign.arguments.length !== 1 || !this.graph.same(assign.arguments[0], save.left) || !call(ready) || !this.graph.same(returned, save.left)) return this.fail(received, 'Resource instance result', 'instance.exports must flow directly into one finite export-assignment helper');
    if (!this.immutable(receive.params[0]!) || !this.immutable(receiveResult.params[0]!)) return this.fail(receive, 'Resource instance result', 'instance/result formals cannot be replaced');
    const exportAssignment = this.graph.definition(assign.callee);
    if (!exportAssignment || this.directCalls(exportAssignment)?.length !== 1 || this.directCalls(exportAssignment)?.[0] !== assign) return this.fail(assign, 'Resource export origin', 'export assignment helper has another caller, write or escape');
    // All receive calls must be either this result edge or the explicit optional
    // instantiateWasm callback. The latter remains a condition, never pruned.
    const receiveCalls = this.directCalls(receive);
    if (!receiveCalls || receiveCalls.some(operation => operation !== received.argument && !this.optionalReceive(operation, initializer))) return this.fail(receive, 'Resource instance result', 'receiver has an unaccounted caller or publication');
    const importUses = this.uses(importsId);
    if (!this.immutable(importsId) || importUses.some(use => use !== importsId && !this.optionalImport(use, initializer))) return this.fail(importsId, 'Resource import association', 'selected import object escapes its route/custom-instantiation branches');
    this.record('Resource import record allocation', importTable, importTable, 'own-record', `${names.size} distinct own function-valued properties match the independently measured import module/name set; this is a syntax/reference fact, not a proof of import bodies.`, this.uses(namespace.value), []);
    this.record('Resource import association', instantiate, importTable, 'resource-instance', `${names.size} measured imports match the finite own module/name allocation and B/M/R/Y forwarding edges; import bodies and signatures/argument effects remain separate obligations.`, [...this.uses(namespace.value), ...importUses]);
    this.record('Resource instance result', save, save.right.object, 'resource-instance', 'The awaited result.instance.exports edge reaches the single export-assignment call; custom instantiateWasm remains conditional.', receiveCalls);
    const exportOps = statements(exportAssignment).flatMap(statement => statement.type === 'ExpressionStatement' ? expressions(statement.expression) : []);
    if (!exportOps.length || statements(exportAssignment).some(statement => statement.type !== 'ExpressionStatement')) return this.fail(exportAssignment, 'Resource export origin', 'export-assignment helper contains unsupported statements');
    if (!exportAssignment.params[0] || !this.immutable(exportAssignment.params[0])) return this.fail(exportAssignment, 'Resource export origin', 'export assignment formal has another writer');
    const stores: { target: E.MemberExpression | E.Identifier; source: E.MemberExpression; operation: E.AssignmentExpression }[] = [];
    const flatten = (operation: E.Expression): boolean => {
      if (operation.type !== 'AssignmentExpression' || operation.operator !== '=' || !['Identifier', 'MemberExpression'].includes(operation.left.type)) return false;
      if (operation.right.type === 'AssignmentExpression') {
        if (!flatten(operation.right)) return false;
        const inner = stores[stores.length - 1]!;
        stores.push({ target: operation.left as E.Identifier | E.MemberExpression, source: inner.source, operation }); return true;
      }
      const source = operation.right;
      if (!member(source) || source.computed || !this.graph.same(source.object, exportAssignment.params[0]) || !this.resource.exports.some(item => item.name === key(source.property))) return false;
      stores.push({ target: operation.left as E.Identifier | E.MemberExpression, source, operation }); return true;
    };
    if (!exportOps.every(flatten)) return this.fail(exportAssignment, 'Resource export origin', 'each export store must read a measured own export without a JavaScript replacement');
    const tableStore = stores.filter(store => store.target.type === 'Identifier' && this.resource.exports.some(item => item.kind === 1 && item.name === key(store.source.property)));
    if (tableStore.length !== 1) return this.fail(exportAssignment, 'Resource table origin', 'one exact resource table export assignment is required');
    const table = tableStore[0]!, tableUses = this.uses(table.target);
    const tableBinding = this.graph.bindings.get(table.target), tableDefinition = tableBinding?.defs[0]?.node;
    if (tableBinding?.defs.length !== 1 || tableDefinition?.type !== 'VariableDeclarator' || tableDefinition.init !== null) return this.fail(table.operation, 'Resource table origin', 'table binding must begin uninitialized; a foreign initial table is not a resource origin');
    const getUse = tableUses.find(use => member(this.graph.parents.get(use), 'get'));
    const get = getUse && this.graph.parents.get(getUse), getCall = get && this.graph.parents.get(get), lookup = getCall && this.graph.owner(getCall);
    if (!call(getCall) || !fn(lookup) || tableUses.some(use => use !== table.target && use !== getUse)) return this.fail(table.operation, 'Resource table origin', 'table export has an additional writer, alias or access');
    const lookupShape = this.shape(lookup, 'pointer=>{var callback=cache[pointer];return callback||(cache[pointer]=callback=table.get(pointer)),callback}');
    if (!lookupShape || !this.graph.same(lookupShape.get('table'), table.target)) return this.fail(lookup, 'Resource table cache', 'table cache must have only the finite get/store/return operations');
    if (!this.immutable(lookupShape.get('pointer')!)) return this.fail(lookup, 'Resource table cache', 'table pointer formal cannot be replaced');
    const cache = lookupShape.get('cache')!, cacheValue = this.value(cache);
    if (!this.immutable(cache) || cacheValue?.type !== 'ArrayExpression' || cacheValue.elements.length || this.uses(cache).some(use => this.graph.owner(use) !== lookup)) return this.fail(cache, 'Resource table cache', 'cache needs one fresh empty allocation, exactly matched reads/writes and no escape');
    this.record('Resource table export', table.operation, table.target, 'resource-table', 'The sole table writer reads the measured resource table export; the only read is the finite table.get lookup.', tableUses);
    this.record('Resource table cache', lookup.body, cacheValue, 'resource-function', 'An empty cache has exactly one read and one get-derived write at the same pointer; no foreign JavaScript callback can replace the cached value through a binding reference.', this.uses(cache));
    const lookupCalls = this.directCalls(lookup);
    if (!lookupCalls) return this.fail(lookup, 'Resource callback origin', 'table-function lookup is replaced or escaped');
    const selectors = lookupCalls.filter(operation => this.graph.parents.get(operation)?.type === 'ConditionalExpression');
    if (selectors.length !== 1) return this.fail(lookup, 'Resource callback origin', 'one finite signature selector is required');
    const selection = this.graph.parents.get(selectors[0]!) as E.ConditionalExpression;
    if (selection.alternate !== selectors[0] || !call(selection.consequent)) return this.fail(selection, 'Resource callback origin', 'signature selector must choose the table function or a closed wrapper');
    const wrapper = this.graph.definition(selection.consequent.callee);
    const wrapperShape = wrapper && this.shape(wrapper, 'function(signature,pointer){let flag=arguments.length>2&&arguments[2]!==void 0&&arguments[2];return function(){return invoke(signature,pointer,[...arguments],flag)}}');
    if (!wrapper || !wrapperShape || this.directCalls(wrapper)?.length !== 1 || this.directCalls(wrapper)?.[0] !== selection.consequent) return this.fail(selection, 'Resource closed wrapper', 'wrapper must only capture the exact signature/pointer and forward arguments, with no extra caller or escape');
    const invokeId = wrapperShape.get('invoke')!, invoke = this.graph.definition(invokeId);
    const invokeShape = invoke && this.shape(invoke, 'function(signature,pointer){let args=arguments.length>2&&arguments[2]!==void 0?arguments[2]:[];if(arguments.length>3&&arguments[3]!==void 0&&arguments[3],signature.includes("j"))return wide(signature,pointer,args);var result=lookup(pointer)(...args);function identity(value){return value}return result}');
    if (!invoke || !invokeShape || this.directCalls(invoke)?.length !== 1 || !this.graph.same(invokeShape.get('lookup'), this.bindingNode(lookup))) return this.fail(wrapper, 'Resource closed wrapper', 'invocation dispatcher does not preserve the finite table/wide-call branches');
    const wide = this.graph.definition(invokeShape.get('wide')!);
    const wideShape = wide && this.shape(wide, '(signature,pointer,args)=>{signature=signature.replace(/p/g,"i");var callback=functions[signature];return callback(pointer,...args)}');
    if (!wide || !wideShape || this.directCalls(wide)?.length !== 1) return this.fail(invoke, 'Resource wide callback cache', 'wide dispatcher must read one private function record after finite p-to-i normalization');
    const functions = wideShape.get('functions')!, functionsValue = this.value(functions);
    const functionStores = stores.filter(store => store.target.type === 'MemberExpression' && this.graph.same(store.target.object, functions));
    if (!this.immutable(functions) || functionsValue?.type !== 'ObjectExpression' || functionsValue.properties.length || !functionStores.length || functionStores.some(store => store.target.type !== 'MemberExpression' || store.target.computed || !this.resource.exports.some(item => item.kind === 0 && item.name === key(store.source.property))) || this.uses(functions).some(use => this.graph.owner(use) !== wide && !functionStores.some(store => store.target.type === 'MemberExpression' && store.target.object === use))) return this.fail(functions, 'Resource wide callback cache', 'wide function record has a foreign write/access/escape or a nonfunction export');
    const ownKeys = functionStores.map(store => key((store.target as E.MemberExpression).property));
    if (ownKeys.includes('__proto__') || new Set(ownKeys).size !== ownKeys.length) return this.fail(functions, 'Resource wide callback cache', 'wide function stores must be distinct own data keys');
    for (const store of functionStores) this.record('Resource wide callback export', store.operation, functionsValue, 'resource-function', 'This distinct dispatch field receives only a measured function export; signature membership and own-key proof remain conditions.', this.uses(functions));
    this.record('Resource closed wrapper', wrapper.body, wrapper, 'closed-wrapper', 'The returned JavaScript closure captures signature, pointer and the optional scalar flag, and only forwards its arguments to the closed resource dispatcher.', this.uses(this.bindingNode(wrapper)!));
    const selector = this.graph.owner(selection), resolver = this.graph.owner(selector);
    if (!fn(selector) || !fn(resolver) || !this.resolver(resolver, selector, selection, lookup, wrapper)) return this.fail(selection, 'Resource callback origin', 'signature decoder/selector/result operations do not match the finite resolver grammar');
    const resolverCalls = this.directCalls(resolver);
    if (!resolverCalls || resolverCalls.some(operation => !importers.has(this.graph.owner(operation) as Fn) || !importOnly(this.graph.owner(operation) as Fn))) return this.fail(resolver, 'Resource callback origin', 'callback resolver has a JavaScript direct caller, escaped importer or unaccounted reference');
    for (const operation of lookupCalls) {
      if (operation === selectors[0] || this.graph.owner(operation) === invoke) continue;
      const importer = this.graph.owner(operation), parent = this.graph.parents.get(operation);
      if (!fn(importer) || !importers.has(importer) || !importOnly(importer) || !call(parent) || parent.callee !== operation || operation.arguments.length !== 1 || !this.graph.same(operation.arguments[0], importer.params[0])) return this.fail(operation, 'Resource callback origin', 'direct table invoker has an unknown caller, pointer origin or escaped function value');
      this.record('Resource table invoker', operation, table.target, 'resource-function', 'Imported wrapper calls the selected table function directly with its first ABI parameter as pointer; surrounding exception/stack effects still require proof.', this.uses(this.bindingNode(importer)!));
    }
    const resourceFlow: ResourceFlow = Object.freeze({
      imports: modules, namespace, importTable, importsBinding: this.graph.bindings.get(importsId)!,
      instantiate, bytes: this.bound(bytesFunction), bytesCall: byteCall,
      route: this.bound(route), routeCall, initializer: this.bound(initializer), initializerCall: initializerCalls[0]!,
      receiveResult: this.bound(receiveResult), resultCall, receive: this.bound(receive),
      receiveCalls: Object.freeze([...receiveCalls]), saveExports: save, assignExports: assign,
      exportAssignment: this.bound(exportAssignment),
    });
    const wrapperReturn = statements(wrapper).at(-1);
    // The exact helper grammar above establishes this returned closure and its
    // captured flag declaration; retaining them adds no new proof condition.
    const closure = (wrapperReturn as E.ReturnStatement).argument as Fn;
    const tableOrigin: CallbackOrigin = Object.freeze({
      kind: 'resource-table-function', tableBinding: tableBinding!, tableStore: table.operation, tableExport: table.source,
      lookup: this.bound(lookup), lookupCall: selectors[0]!, cacheBinding: this.graph.bindings.get(cache)!, cacheAllocation: cacheValue,
    });
    const wrapperOrigin: CallbackOrigin = Object.freeze({
      kind: 'closed-signature-wrapper', wrapper: this.bound(wrapper), wrapperCall: selection.consequent,
      closure, captures: Object.freeze({
        signature: this.graph.bindings.get(wrapperShape.get('signature')!)!,
        pointer: this.graph.bindings.get(wrapperShape.get('pointer')!)!,
        flag: this.graph.bindings.get(wrapperShape.get('flag')!)!,
        invoke: this.graph.bindings.get(invokeId)!,
      }), invoke: this.bound(invoke), wide: this.bound(wide),
      functionsBinding: this.graph.bindings.get(functions)!, functionsAllocation: functionsValue,
      exports: Object.freeze(functionStores.map(store => Object.freeze({ store: store.operation, source: store.source }))),
    });
    for (const importer of importers) {
      const calls = resolverCalls.filter(operation => this.graph.owner(operation) === importer);
      const property = (importTable.properties as E.Property[]).find(item => this.graph.definition(item.value) === importer);
      const signature = property && this.resource.imports.find(item => item.name === key(property.key));
      if (calls.length !== 4 || importer.params.length !== 13 || signature?.parameters.length !== 13 || signature.parameters.some(type => type !== 'i32') || signature.results.length) continue;
      const fields = this.metadata(importer, calls, resolver);
      for (const field of fields) {
        const requirements = this.record('Resource callback origin', field.node, field.receiver, 'resource-function-or-closed-wrapper', `The ${field.name} field receives only the connected resource table function or closed signature wrapper${field.guard ? ', or zero on its guarded optional conversion path' : ''}; storing this value does not prove its later invocation. The imported class entry has thirteen measured i32 parameters and no JavaScript caller outside its import property.`, [...this.uses(this.bindingNode(importer)!), ...this.uses(this.bindingNode(resolver)!)]);
        const pointerBinding = this.graph.bindings.get(field.pointer)!;
        const origins: CallbackOrigin[] = [tableOrigin, wrapperOrigin];
        if (field.guard) origins.push(Object.freeze({ kind: 'guarded-optional-zero', guard: field.guard, pointerBinding }));
        this.callbacks.push(verifiedRecord({
          [callbackBrand]: true as const, operation: field.node, allocation: field.receiver, field: field.name,
          constructor: this.bound(field.constructor),
          arguments: Object.freeze(field.receiver.arguments.map((argument, index) => {
            const formal = field.constructor.params[index]!;
            return Object.freeze({ index, argument, argumentBinding: this.graph.bindings.get(argument) ?? null, formal, formalBinding: this.graph.bindings.get(formal) ?? null });
          })),
          importer: this.bound(importer), importProperty: property!,
          scheduler: Object.freeze({ call: field.scheduled, callback: field.callback, target: this.bound(field.scheduler, field.scheduled.callee) }),
          conversion: Object.freeze({
            assignment: field.assignment, call: field.conversion,
            pointer: Object.freeze({ formal: field.pointer, binding: pointerBinding }),
            signature: Object.freeze({ formal: field.signature, binding: this.graph.bindings.get(field.signature)! }),
            argumentIndex: field.formal, guard: field.guard, resolver: this.bound(resolver), selector: this.bound(selector), selection,
          }),
          resource: resourceFlow, origins: Object.freeze(origins),
          references: Object.freeze([...this.uses(this.bindingNode(importer)!), ...this.uses(this.bindingNode(resolver)!)]), requirements,
        }));
      }
    }
    return this.summary();
  }
  ancestor(node: E.Node, type: string): E.Node | null {
    let parent = this.graph.parents.get(node);
    while (parent && parent !== this.factory) { if (parent.type === type) return parent; parent = this.graph.parents.get(parent); }
    return null;
  }
  optionalReceive(node: E.CallExpression, initializer: Fn): boolean {
    const callback = this.graph.owner(node), operation = this.graph.parents.get(callback);
    return fn(callback) && call(operation) && member(operation.callee, 'instantiateWasm') && operation.arguments[1] === callback && this.graph.owner(this.graph.owner(callback)) === initializer && !!this.ancestor(operation, 'ConditionalExpression');
  }
  optionalImport(node: E.Node, initializer: Fn): boolean {
    const parent = this.graph.parents.get(node);
    return call(parent) && member(parent.callee, 'instantiateWasm') && parent.arguments[0] === node && this.graph.owner(this.graph.owner(node)) === initializer;
  }
  resolver(resolver: Fn, selector: Fn, selection: E.ConditionalExpression, lookup: Fn, wrapper: Fn): boolean {
    if (resolver.params.length !== 2 || statements(selector).length !== 1 || statements(selector)[0]?.type !== 'ReturnStatement' || (statements(selector)[0] as E.ReturnStatement).argument !== selection || !this.directCalls(selector) || this.directCalls(selector)?.length !== 1) return false;
    const [signature, pointer] = resolver.params, test = selection.test;
    if (!call(test) || !member(test.callee, 'includes') || !this.graph.same(test.callee.object, signature) || test.arguments.length !== 1 || test.arguments[0]?.type !== 'Literal' || test.arguments[0].value !== 'j' || !call(selection.consequent) || !call(selection.alternate) || this.graph.definition(selection.consequent.callee) !== wrapper || this.graph.definition(selection.alternate.callee) !== lookup || selection.consequent.arguments.length !== 2 || !this.graph.same(selection.consequent.arguments[0], signature) || !this.graph.same(selection.consequent.arguments[1], pointer) || selection.alternate.arguments.length !== 1 || !this.graph.same(selection.alternate.arguments[0], pointer)) return false;
    const body = statements(resolver);
    if (body.length !== 4 || body[1] !== selector || body[0]?.type !== 'ExpressionStatement' || body[2]?.type !== 'VariableDeclaration' || body[2].declarations.length !== 1 || body[3]?.type !== 'ReturnStatement') return false;
    const prefix = expressions(body[0].expression), decode = prefix[prefix.length - 1], result = body[2].declarations[0]!;
    if (prefix.length !== 2 || prefix[0]?.type !== 'LogicalExpression' || decode?.type !== 'AssignmentExpression' || decode.operator !== '=' || !this.graph.same(decode.left, signature) || !call(decode.right) || !this.graph.definition(decode.right.callee) && !this.graph.bindings.has(decode.right.callee) || decode.right.arguments.length !== 1 || !this.graph.same(decode.right.arguments[0], signature) || !call(result.init) || this.graph.definition(result.init.callee) !== selector || result.init.arguments.length) return false;
    const returned = expressions(body[3].argument), check = returned[0];
    if (returned.length !== 2 || !this.graph.same(returned[1], result.id) || check?.type !== 'LogicalExpression' || check.operator !== '&&' || check.left.type !== 'BinaryExpression' || !['!=', '!=='].includes(check.left.operator) || check.left.left.type !== 'UnaryExpression' || check.left.left.operator !== 'typeof' || !this.graph.same(check.left.left.argument, result.id) || check.left.right.type !== 'Literal' || check.left.right.value !== 'function' || !call(check.right)) return false;
    // Opaque error and decoder effects are explicit obligations, not skipped.
    const within = (node: E.Node, root: E.Node): boolean => {
      let current: E.Node | undefined = node;
      while (current && current !== resolver) { if (current === root) return true; current = this.graph.parents.get(current); }
      return false;
    };
    return this.immutable(result.id) && this.uses(result.id).every(use => within(use, check.left) || use === returned[1]) && this.uses(pointer!).every(use => within(use, selection) || within(use, check.right)) && this.uses(signature!).every(use => within(use, decode) || within(use, selection) || within(use, check.right));
  }
  metadata(importer: Fn, calls: E.CallExpression[], resolver: Fn): MetadataField[] {
    const expected = new Map<number, CallbackField>([[5, 'getActualType'], [7, 'upcast'], [9, 'downcast'], [12, 'rawDestructor']]);
    const assignments = new Map<Variable, { call: E.CallExpression; assignment: E.AssignmentExpression; pointer: E.Pattern; signature: E.Pattern; guard: E.LogicalExpression | null }>();
    for (const operation of calls) {
      const parent = this.graph.parents.get(operation);
      if (parent?.type !== 'AssignmentExpression' || parent.operator !== '=' || operation.arguments.length !== 2 || !this.graph.same(parent.left, operation.arguments[1])) return [];
      const index = importer.params.findIndex(parameter => this.graph.same(parameter, parent.left));
      const signature = importer.params[index - 1];
      if (!expected.has(index) || !signature || !this.immutable(signature) || this.uses(signature).some(use => use !== operation.arguments[0]) || !this.graph.same(operation.arguments[0], signature) || this.graph.definition(operation.callee) !== resolver) return [];
      const binding = this.graph.bindings.get(parent.left);
      if (!binding || assignments.has(binding) || binding.references.some(reference => reference.isWrite() && reference.identifier !== parent.left)) return [];
      let guard: E.LogicalExpression | null = null;
      if ([7, 9].includes(index)) {
        const protection = this.graph.parents.get(parent);
        if (protection?.type !== 'LogicalExpression' || protection.operator !== '&&' || protection.right !== parent || !this.graph.same(protection.left, parent.left)) return [];
        guard = protection;
      }
      assignments.set(binding, { call: operation, assignment: parent, pointer: importer.params[index]!, signature, guard });
    }
    if (assignments.size !== 4) return [];
    const creations = this.graph.nodes.filter((node): node is E.NewExpression => node.type === 'NewExpression' && this.local(node) && this.graph.owner(this.graph.owner(node)) === importer);
    const fields: MetadataField[] = [];
    for (const creation of creations) {
      const constructor = this.graph.definition(creation.callee), callback = this.graph.owner(creation);
      if (!constructor || !fn(callback)) continue;
      const scheduled = this.graph.parents.get(callback);
      if (!call(scheduled) || scheduled.arguments.length !== 3 || scheduled.arguments[2] !== callback) continue;
      const scheduler = this.graph.definition(scheduled.callee);
      if (!scheduler) continue;
      const constructorCallsClosed = this.closedFunction(constructor, (use, parent) => parent === creation && creation.callee === use);
      if (!constructorCallsClosed || constructor.params.length !== creation.arguments.length) continue;
      const operations = statements(constructor).flatMap(statement => statement.type === 'ExpressionStatement' ? expressions(statement.expression) : []);
      if (statements(constructor).some(statement => statement.type !== 'ExpressionStatement')) continue;
      const names = new Set<string>();
      if (!operations.every(operation => {
        if (operation.type !== 'AssignmentExpression' || operation.operator !== '=' || !member(operation.left) || operation.left.computed || operation.left.object.type !== 'ThisExpression') return false;
        const name = key(operation.left.property);
        if (!name || name === '__proto__' || names.has(name)) return false;
        names.add(name);
        return constructor.params.some(parameter => this.graph.same(parameter, operation.right)) || operation.right.type === 'ArrayExpression' && !operation.right.elements.length;
      })) continue;
      const candidate: typeof fields = [];
      for (const operation of operations) {
        if (operation.type !== 'AssignmentExpression' || !member(operation.left)) continue;
        const formal = constructor.params.findIndex(parameter => this.graph.same(parameter, operation.right));
        const argument = creation.arguments[formal], binding = argument && this.graph.bindings.get(argument), original = binding && assignments.get(binding);
        if (!original) continue;
        const index = importer.params.findIndex(parameter => this.graph.same(parameter, argument));
        const name = expected.get(index);
        if (!name || key(operation.left.property) !== name) continue;
        candidate.push({ node: operation, receiver: creation, name, constructor, callback, scheduled, scheduler, formal, conversion: original.call, assignment: original.assignment, pointer: original.pointer, signature: original.signature, guard: original.guard });
      }
      if (candidate.length === 4) {
        const closed = [...assignments].every(([binding, conversion]) => binding.references.every(reference => {
          const operation = conversion.call;
          const use = reference.identifier, parent = this.graph.parents.get(use);
          if (parent === this.graph.parents.get(operation) || parent === operation) return true;
          if (parent?.type === 'LogicalExpression' && parent.left === use && parent.right === this.graph.parents.get(operation)) return true;
          return parent === creation && creation.arguments.includes(use);
        }));
        if (closed) fields.push(...candidate);
      }
    }
    return fields;
  }
}
