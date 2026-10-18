import { resourceCallbacks } from './resource-provenance.js';
import type { resourceProvenance, ResourceRequirement, ResourceSummary } from './resource-provenance.js';
import type * as E from 'estree';
import type { StructuralEvidence } from './analysis.js';

type Graph = Parameters<typeof resourceProvenance>[0];
type Fn = Parameters<typeof resourceProvenance>[1];
type AllocationNode = E.NewExpression | E.ObjectExpression | E.ArrayExpression;
type Status = 'proved' | 'conditional' | 'unknown';
const brand = Symbol('loader-configuration-proof');
class Verified { declare private verifierIdentity: void }
function record<T extends object>(fields: T): Readonly<T> & Verified {
  const result = Object.assign(new Verified(), fields);
  Object.freeze(result);
  return result;
}
interface Requirement extends Verified {
  readonly id: string;
  readonly operation: E.Node;
  readonly allocation: AllocationNode | null;
  readonly state: 'unsatisfied';
}
interface Allocation extends Verified {
  readonly node: AllocationNode;
  readonly prototype: 'Object.prototype' | 'Uint8Array.prototype' | 'WeakMap.prototype' | 'Array.prototype';
  readonly ownFields: readonly string[];
  readonly writers: readonly E.Node[];
  readonly publications: readonly E.Node[];
  readonly requirements: readonly Requirement[];
}
interface Failure extends Verified {
  readonly operation: E.Node;
  readonly route: 'fallback' | 'propagate' | 'reject-memo' | 'preserve-cache';
  readonly detail: string;
}
interface Operation extends Verified {
  readonly role: string;
  readonly node: E.Node;
  readonly receiver: E.Node;
  readonly allocation: Allocation | null;
  readonly references: readonly E.Node[];
  readonly writers: readonly E.Node[];
  readonly effects: string;
  readonly requirements: readonly (Requirement | ResourceRequirement)[];
  readonly status: Status;
}
export interface LoaderConfigurationSummary extends Verified {
  readonly [brand]: true;
  readonly evidence: readonly StructuralEvidence[];
}
interface Facts {
  readonly allocations: readonly Allocation[];
  readonly operations: readonly Operation[];
  readonly failures: readonly Failure[];
  // Preserve incoming requirement objects verbatim, including their identities.
  readonly incomingRequirements: readonly ResourceRequirement[];
  readonly callbackFacts: NonNullable<ReturnType<typeof resourceCallbacks>>;
  readonly context: Readonly<Context>;
  readonly copy: CopyFlow | null;
  readonly readiness: ReadinessFlow | null;
}
interface CopyFlow extends Verified {
  readonly byteLength: E.MemberExpression;
  readonly view: Allocation;
  readonly set: E.CallExpression;
  readonly bufferGet: E.MemberExpression;
  readonly wasmBinary: E.Property;
  readonly inner: Allocation;
  readonly overrides: E.Property;
  readonly outer: Allocation;
  readonly configure: E.CallExpression;
  readonly requirements: readonly Requirement[];
}
interface ReadinessFlow extends Verified {
  readonly configureAwait: E.AwaitExpression;
  readonly secondAwait: E.AwaitExpression;
  readonly forwarding: E.CallExpression;
  readonly cacheAwait: E.AwaitExpression;
  readonly cacheCall: E.CallExpression;
  readonly optionsFormal: E.Identifier;
  readonly snapshot: E.ObjectExpression;
  readonly snapshotSpreads: readonly E.SpreadElement[];
  readonly decodeUses: readonly E.CallExpression[];
}
interface Context { readonly loader: Fn; readonly initialization: Fn; readonly wrapper: Fn; readonly cache: Fn }
const contexts = new WeakMap<LoaderConfigurationSummary, { graph: Graph; factory: Fn; resources: ResourceSummary; facts: Facts }>();
/** Internal consumer boundary; equal source reparsed elsewhere is foreign. */
export function loaderConfigurationFacts(summary: LoaderConfigurationSummary, graph: Graph, factory: Fn, resources: ResourceSummary): Facts | null {
  const context = contexts.get(summary);
  return context?.graph === graph && context.factory === factory && context.resources === resources ? context.facts : null;
}
const fn = (node: E.Node | undefined | null): node is Fn => !!node && ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type);
const call = (node: E.Node | undefined | null): node is E.CallExpression => node?.type === 'CallExpression' && !node.optional;
const key = (node: E.Node): string | null => node.type === 'Identifier' ? node.name : node.type === 'Literal' && typeof node.value === 'string' ? node.value : null;
const member = (node: E.Node | undefined | null, name: string): node is E.MemberExpression => node?.type === 'MemberExpression' && !node.optional && key(node.property) === name && (!node.computed || node.property.type === 'Literal');
const body = (node: Fn): E.Statement[] => node.body.type === 'BlockStatement' ? node.body.body : [];
const expressions = (node: E.Expression): E.Expression[] => node.type === 'SequenceExpression' ? node.expressions : [node];
const range = (node: E.Node) => { const located = node as E.Node & { start: number; end: number }; return { start: located.start, end: located.end, unit: 'utf16' as const }; };

/** Additional finite facts only: no requirement discharge or host-effect waiver. */
export function loaderConfigurationProof(graph: Graph, factory: Fn, resources: ResourceSummary, context: Context): LoaderConfigurationSummary {
  return new LoaderProof(graph, factory, resources, context).inspect();
}
class LoaderProof {
  readonly allocations: Allocation[] = [];
  readonly operations: Operation[] = [];
  readonly failures: Failure[] = [];
  readonly incoming: ResourceRequirement[] = [];
  callbacks: NonNullable<ReturnType<typeof resourceCallbacks>> = Object.freeze([]);
  copy: CopyFlow | null = null;
  readiness: ReadinessFlow | null = null;
  constructor(readonly graph: Graph, readonly factory: Fn, readonly resources: ResourceSummary, readonly context: Context) {}
  requirements(node: E.Node, allocation: AllocationNode | null, ids: string[]): readonly Requirement[] {
    return Object.freeze(ids.map(id => record({ id, operation: node, allocation, state: 'unsatisfied' as const })));
  }
  add(role: string, node: E.Node, receiver: E.Node, effects: string, ids: string[], allocation: Allocation | null = null, references: E.Node[] = [], writers: E.Node[] = []): void {
    const requirements = Object.freeze([...this.incoming, ...this.requirements(node, allocation?.node ?? null, ['resource-association', ...ids])]);
    this.operations.push(record({ role, node, receiver, allocation, effects, requirements, references: Object.freeze(references), writers: Object.freeze(writers), status: requirements.length ? 'conditional' as const : 'proved' as const }));
  }
  unknown(node: E.Node, role: string, detail: string): void {
    this.operations.push(record({ role, node, receiver: node, allocation: null, effects: detail, requirements: Object.freeze([...this.incoming, ...this.requirements(node, null, ['unsupported-structure'])]), references: Object.freeze([]), writers: Object.freeze([]), status: 'unknown' as const }));
  }
  allocation(node: AllocationNode, prototype: Allocation['prototype'], ownFields: string[], writers: E.Node[], publications: E.Node[]): Allocation {
    const allocation = record({ node, prototype, ownFields: Object.freeze(ownFields), writers: Object.freeze(writers), publications: Object.freeze(publications), requirements: this.requirements(node, node, ['standard-prototypes', 'intervening-effects', 'publication-lifetime']) });
    this.allocations.push(allocation);
    return allocation;
  }
  fail(operation: E.Node, route: Failure['route'], detail: string): void { this.failures.push(record({ operation, route, detail })); }
  uses(node: E.Node): E.Node[] { return this.graph.bindings.get(node)?.references.filter(reference => !reference.init).map(reference => reference.identifier) ?? []; }
  immutable(node: E.Node): boolean {
    const binding = this.graph.bindings.get(node);
    return !!binding && binding.defs.length === 1 && binding.references.every(reference => !reference.isWrite() || reference.init);
  }
  value(node: E.Node): E.Expression | null {
    const binding = this.graph.bindings.get(node), definition = binding?.defs[0]?.node;
    return binding?.defs.length === 1 && definition?.type === 'VariableDeclarator' ? definition.init : null;
  }
  id(node: Fn): E.Node | null {
    if (node.type === 'FunctionDeclaration') return node.id;
    const parent = this.graph.parents.get(node);
    return parent?.type === 'VariableDeclarator' ? parent.id : null;
  }
  directCalls(node: Fn): E.CallExpression[] | null {
    const id = this.id(node);
    if (!id || !this.immutable(id)) return null;
    const calls: E.CallExpression[] = [];
    for (const use of this.uses(id)) {
      const parent = this.graph.parents.get(use);
      if (!call(parent) || parent.callee !== use) return null;
      calls.push(parent);
    }
    return calls;
  }
  summary(): LoaderConfigurationSummary {
    const evidence = this.operations.map(operation => Object.freeze({ kind: 'source' as const, range: Object.freeze(range(operation.node)), description: `Loader ${operation.role}: ${operation.status}; ${operation.effects} ${operation.references.length} binding references retained; ${operation.writers.length} binding writers retained. Remaining requirements: ${[...new Set(operation.requirements.map(requirement => requirement.id))].join(', ') || 'none for this syntax fact'}. No hook is pruned; this record never authorizes an effect or proves a cycle.` }));
    const summary = record({ [brand]: true as const, evidence: Object.freeze(evidence) });
    const facts = record({ allocations: Object.freeze([...this.allocations]), operations: Object.freeze([...this.operations]), failures: Object.freeze([...this.failures]), incomingRequirements: Object.freeze([...this.incoming]), callbackFacts: this.callbacks, context: Object.freeze({ ...this.context }), copy: this.copy, readiness: this.readiness });
    contexts.set(summary, { graph: this.graph, factory: this.factory, resources: this.resources, facts });
    return summary;
  }
  inspect(): LoaderConfigurationSummary {
    const callbacks = resourceCallbacks(this.resources, this.graph, this.factory);
    if (callbacks === null || !Object.values(this.context).every(node => this.graph.nodes.includes(node))) {
      this.unknown(this.factory, 'context identity', 'Foreign graph, factory or resource summary.');
      return this.summary();
    }
    this.callbacks = callbacks;
    // Context identity authenticates borrowed facts, not successful provenance.
    // Every local operation keeps resource-association as an open requirement,
    // including summaries without callbacks or with failed origin association.
    for (const callback of callbacks) this.incoming.push(...callback.requirements);
    // Discover the connected default-record and two-cache-caller family.
    // Other families retain their existing evidence and refusal unchanged.
    const declarations = body(this.context.cache)[1];
    const tuple = declarations?.type === 'VariableDeclaration' ? declarations.declarations[0] : null;
    const fallback = tuple?.init?.type === 'ConditionalExpression' ? tuple.init.consequent : null;
    const defaultsReference = fallback?.type === 'ArrayExpression' ? fallback.elements[0] : null;
    const defaults = defaultsReference && this.value(defaultsReference);
    if (defaults?.type !== 'ObjectExpression' || !defaults.properties.some(property => property.type === 'Property' && key(property.key) === 'locateFile') || this.directCalls(this.context.cache)?.length !== 2) return this.summary();
    this.factoryReferences();
    this.sourceAndCopy();
    this.cacheTransitions();
    this.defaultsAndEquality();
    this.readinessOrdering();
    this.factoryOptions();
    return this.summary();
  }
  factoryOptions(): void {
    const formal = this.factory.params[0];
    const input = formal?.type === 'AssignmentPattern' ? formal.left : formal;
    if (input?.type !== 'Identifier' || !this.immutable(input)) { this.unknown(this.factory, 'factory options unsupported', 'Factory options parameter is rebound or unsupported; no alias identity is established.'); return; }
    const aliases = new Set<E.Node>([input]);
    // Only direct immutable variable aliases. Other publications and aliases
    // remain explicit requirements, never silently broaden this origin set.
    for (const node of this.graph.nodes) {
      if (node.type === 'VariableDeclarator' && node.init?.type === 'Identifier' && aliases.size && [...aliases].some(alias => this.graph.same(alias, node.init)) && node.id.type === 'Identifier' && this.immutable(node.id) && this.graph.owner(node) === this.factory) aliases.add(node.id);
    }
    const own = (node: E.Node): boolean => [...aliases].some(alias => this.graph.same(alias, node));
    const requirements = ['hooks-absent', 'intervening-effects', 'dynamic-export-collisions', 'then-assimilation', 'callback-invocation', 'publication-lifetime'];
    for (const node of this.graph.nodes) {
      if (node.type !== 'MemberExpression' || node.optional || !own(node.object) || !this.inside(node, this.factory)) continue;
      const parent = this.graph.parents.get(node);
      const writer = parent?.type === 'AssignmentExpression' && parent.left === node || parent?.type === 'UpdateExpression' || parent?.type === 'UnaryExpression' && parent.operator === 'delete';
      if (writer) {
        this.add('factory option write', parent!, node.object, 'Options/module write has a dynamic or ordinary key; collision with hook names, then and __proto__ is not excluded. Property setters, key coercion, receiver mutation and later reads need separate proofs.', requirements, null, this.uses(node.object), [parent!]);
      } else {
        let loop = false;
        for (let ancestor = this.graph.parents.get(node); ancestor && ancestor !== this.factory; ancestor = this.graph.parents.get(ancestor)) if (['ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement'].includes(ancestor.type)) loop = true;
        this.add('factory option Get', node, node.object, `Individual ${node.computed ? 'computed' : key(node.property)} Get keeps its branch and invocation separate; repeated Gets may select different values. ${loop ? 'This loop source occurrence does not bound invocation count.' : 'Source occurrence is not a callback invocation bound.'} No own/inherited hook absence or return-then assimilation is established.`, requirements, null, this.uses(node.object));
      }
    }
  }
  factoryReferences(): void {
    const id = this.id(this.factory), uses = id && this.uses(id);
    if (!id || !this.immutable(id) || uses?.length !== 2) { this.unknown(this.factory, 'factory references unsupported', 'Factory has another binding writer, alias, call or publication.'); return; }
    for (const use of uses) {
      const parent = this.graph.parents.get(use);
      if (!call(parent) || parent.arguments[0] !== use) { this.unknown(use, 'factory references unsupported', 'Factory reference is outside the two cache-key forwarding positions.'); return; }
      const target = this.graph.definition(parent.callee);
      if (target !== this.context.cache && (!target || target.params.length < 1 || !target.async)) { this.unknown(use, 'factory references unsupported', 'Factory reference has an unknown consumer.'); return; }
    }
    this.add('factory references', this.factory, id, 'Exactly two outer factory references occupy first-argument positions for cache keys or an async consumer, with no binding writers or extra alias/publication. The async consumer is not proved a decoder by this record. Callback, factory parameter, dynamic module exports and later receiver publication remain requirements.', ['factory-effects', 'hooks-absent', 'intervening-effects', 'dynamic-export-collisions', 'then-assimilation', 'publication-lifetime'], null, uses);
  }
  readinessOrdering(): void {
    const initialized = this.directCalls(this.context.initialization), factories = this.id(this.factory);
    if (initialized?.length !== 1 || !factories) { this.unknown(this.context.initialization, 'readiness unsupported', 'Initialization has an extra reference or no single direct caller.'); return; }
    const initializeCall = initialized[0]!, initializeAwait = this.graph.parents.get(initializeCall), caller = this.graph.owner(initializeCall);
    if (initializeAwait?.type !== 'AwaitExpression' || !fn(caller) || !caller.async) return;
    const attempt = body(caller).find((node): node is E.TryStatement => node.type === 'TryStatement');
    if (!attempt || !this.inside(initializeAwait, attempt.block) || !attempt.handler) return;
    const candidates = this.graph.nodes.filter((node): node is E.CallExpression => call(node) && this.graph.owner(node) === caller && this.inside(node, attempt.block) && range(node).start > range(initializeAwait).end && this.graph.parents.get(node)?.type === 'AwaitExpression');
    if (candidates.length !== 1) { this.unknown(caller, 'readiness unsupported', 'No unique second awaited decoder call after configuration.'); return; }
    const second = candidates[0]!;
    if (!this.linearBefore(initializeAwait, second, attempt.block)) { this.unknown(caller, 'readiness unsupported', 'Configuration is conditional or outside the linear sequence before the decoder.'); return; }
    const wrapper = this.graph.definition(second.callee), wrapperCalls = wrapper && this.directCalls(wrapper);
    if (!wrapper || wrapperCalls?.length !== 1 || wrapperCalls[0] !== second || wrapper.async || wrapper.generator || body(wrapper).length !== 1) return;
    const returned = body(wrapper)[0];
    const forwarded = returned?.type === 'ReturnStatement' ? returned.argument : null;
    if (!call(forwarded) || !this.graph.same(forwarded.arguments[0], factories)) return;
    const decoder = this.graph.definition(forwarded.callee), decoderCalls = decoder && this.directCalls(decoder);
    if (!decoder || !decoder.async || decoder.generator || decoderCalls?.length !== 1 || decoderCalls[0] !== forwarded || decoder.params.length < 1 || decoder.params[0]?.type !== 'Identifier' || !this.immutable(decoder.params[0])) return;
    const waits = this.graph.nodes.filter((node): node is E.AwaitExpression => node.type === 'AwaitExpression' && this.graph.owner(node) === decoder);
    if (waits.length !== 1 || !call(waits[0]!.argument)) return;
    const wait = waits[0]!, cached = wait.argument as E.CallExpression;
    if (this.graph.definition(cached.callee) !== this.context.cache || cached.arguments.length !== 2 || !this.graph.same(cached.arguments[0], decoder.params[0]) || cached.arguments[1]?.type !== 'ObjectExpression' || cached.arguments[1].properties.length !== 1) return;
    const immediate = cached.arguments[1].properties[0];
    if (immediate?.type !== 'Property' || immediate.computed || immediate.kind !== 'init' || key(immediate.key) !== 'fireImmediately' || !(immediate.value.type === 'Literal' && immediate.value.value === true || immediate.value.type === 'UnaryExpression' && immediate.value.operator === '!' && immediate.value.argument.type === 'Literal' && immediate.value.argument.value === 0)) return;
    const declaration = this.graph.parents.get(wait);
    if (declaration?.type !== 'VariableDeclarator' || declaration.id.type !== 'Identifier' || !this.immutable(declaration.id)) return;
    const options = decoder.params[2];
    const optionsId = options?.type === 'AssignmentPattern' ? options.left : options;
    if (optionsId?.type !== 'Identifier' || !this.immutable(optionsId)) return;
    const snapshots = this.graph.nodes.filter((node): node is E.ObjectExpression => node.type === 'ObjectExpression' && this.graph.owner(node) === decoder && range(node).end < range(wait).start && node.properties.some(property => property.type === 'SpreadElement' && this.graph.same(property.argument, optionsId)));
    if (snapshots.length !== 1) return;
    const members = this.graph.nodes.filter((node): node is E.MemberExpression => node.type === 'MemberExpression' && this.graph.owner(node) === decoder && this.graph.same(node.object, declaration.id));
    const malloc = members.filter(node => member(node, '_malloc'));
    const heaps = members.filter(node => member(node, 'HEAPU8'));
    const frees = members.filter(node => member(node, '_free'));
    const decodes = members.filter(node => !member(node, '_malloc') && !member(node, 'HEAPU8') && !member(node, '_free') && call(this.graph.parents.get(node)));
    if (!malloc.length || !heaps.length || !frees.length || !decodes.length || members.some(node => range(node).start < range(wait).end)) return;
    const snapshot = snapshots[0]!, snapshotDeclaration = this.graph.parents.get(snapshot);
    if (snapshotDeclaration?.type !== 'VariableDeclarator' || snapshotDeclaration.id.type !== 'Identifier' || !this.immutable(snapshotDeclaration.id)) return;
    const decodeUses = decodes.flatMap(node => {
      const invocation = this.graph.parents.get(node);
      return call(invocation) && invocation.arguments.some(argument => this.graph.same(argument, snapshotDeclaration.id)) ? [invocation] : [];
    });
    if (!decodeUses.length) return;
    // Require each module operation's evaluation to follow the await in the
    // same block. Branch-local decoders are allowed; their effects remain open.
    const awaitStatement = this.statement(wait, decoder);
    if (!awaitStatement || this.graph.parents.get(awaitStatement) !== decoder.body || members.some(node => !this.linearBefore(wait, node, decoder.body as E.BlockStatement, true))) return;
    this.readiness = record({ configureAwait: initializeAwait, secondAwait: this.graph.parents.get(second) as E.AwaitExpression, forwarding: forwarded, cacheAwait: wait, cacheCall: cached, optionsFormal: optionsId, snapshot, snapshotSpreads: Object.freeze(snapshot.properties.filter((property): property is E.SpreadElement => property.type === 'SpreadElement' && this.graph.same(property.argument, optionsId))), decodeUses: Object.freeze(decodeUses) });
    const ids = ['initialization-readiness', 'factory-effects', 'hooks-absent', 'inherited-equalityFn', 'then-assimilation', 'intervening-effects', 'decoder-effects', 'error-effects'];
    this.add('readiness ordering', second, declaration.id, 'The first configuration await is not module readiness. The second awaited wrapper forwards the same factory to the decoder, whose fireImmediately cache call is separately awaited. Options spread occurs before this await; malloc, HEAPU8, decode and free accesses follow it. Factory readiness, repeated or inherited hooks and then assimilation remain conditions, not proved completion.', ids, null, this.uses(declaration.id));
    const catches = attempt.handler.body.body;
    const last = catches[catches.length - 1];
    const undefinedReturn = !attempt.finalizer && (!attempt.handler.param || attempt.handler.param.type === 'Identifier') && catches.length === 1 && last?.type === 'ReturnStatement' && (last.argument == null || last.argument.type === 'Identifier' && this.graph.standard(last.argument, 'undefined') || last.argument.type === 'UnaryExpression' && last.argument.operator === 'void' && last.argument.argument.type === 'Literal');
    if (undefinedReturn) this.add('caller errors', attempt, caller, 'Lexical catch converts explicit await failures to undefined. A final unawaited return call can yield a thenable rejection outside this lexical catch. This proves no null fallback, no decoder effect closure and no factory hook/error timing.', ['error-effects', 'then-assimilation', 'intervening-effects']);
  }
  inside(node: E.Node, ancestor: E.Node): boolean {
    for (let current: E.Node | undefined = node; current; current = this.graph.parents.get(current)) if (current === ancestor) return true;
    return false;
  }
  statement(node: E.Node, owner: Fn): E.Statement | null {
    let current: E.Node | undefined = node;
    while (current && current !== owner.body) {
      const parent = this.graph.parents.get(current);
      if (parent?.type === 'BlockStatement' && current.type !== 'VariableDeclarator') return current as E.Statement;
      current = parent;
    }
    return null;
  }
  linearBefore(first: E.Node, later: E.Node, block: E.BlockStatement, allowLaterBranch = false): boolean {
    const path = (node: E.Node): E.Node[] => {
      const result: E.Node[] = [];
      for (let current: E.Node | undefined = node; current && current !== block; current = this.graph.parents.get(current)) result.push(current);
      return result;
    };
    const left = path(first), right = path(later);
    const straight = (nodes: E.Node[]): boolean => nodes.every(node => ['AwaitExpression', 'CallExpression', 'MemberExpression', 'VariableDeclarator', 'VariableDeclaration', 'ExpressionStatement', 'SequenceExpression', 'ReturnStatement', 'Identifier'].includes(node.type));
    if (!straight(left) || !allowLaterBranch && !straight(right)) return false;
    const statement = left[left.length - 1], next = right[right.length - 1];
    if (!statement || !next || this.graph.parents.get(statement) !== block || this.graph.parents.get(next) !== block) return false;
    if (statement !== next) return block.body.indexOf(statement as E.Statement) < block.body.indexOf(next as E.Statement);
    const common = left.find(node => right.includes(node));
    if (common?.type === 'VariableDeclaration') {
      const a = left.find(node => node.type === 'VariableDeclarator'), b = right.find(node => node.type === 'VariableDeclarator');
      return !!a && !!b && common.declarations.indexOf(a as E.VariableDeclarator) < common.declarations.indexOf(b as E.VariableDeclarator);
    }
    if (common?.type === 'SequenceExpression') {
      const a = left.find(node => this.graph.parents.get(node) === common), b = right.find(node => this.graph.parents.get(node) === common);
      return !!a && !!b && common.expressions.indexOf(a as E.Expression) < common.expressions.indexOf(b as E.Expression);
    }
    return false;
  }
  defaultsAndEquality(): void {
    const { cache } = this.context;
    const options = cache.params[1];
    if (options?.type !== 'AssignmentPattern' || options.left.type !== 'ObjectPattern') return;
    const equalityProperty = options.left.properties[1];
    const equalityReference = equalityProperty?.type === 'Property' && equalityProperty.value.type === 'AssignmentPattern' ? equalityProperty.value.right : null;
    const equality = equalityReference && this.graph.definition(equalityReference);
    if (!equality || !equalityReference || !this.immutable(equalityReference) || this.uses(equalityReference).some(use => use !== equalityReference)) {
      this.unknown(cache, 'equality references', 'Default equality helper has an extra reference, alias, writer or publication.');
    } else if (this.equalGrammar(equality)) {
      this.add('equality syntax', equality, equalityReference, 'Finite Object.is identity short circuit, three Object.keys calls, every callback, Object.hasOwn and indexed Gets compare own enumerable string keys and values. Symbols, prototype, descriptors and nonenumerable properties are not compared. Identity cannot detect in-place mutation and never proves hooks absence or resource identity.', ['equality-effects', 'standard-prototypes', 'indexed-get-effects', 'iterator-effects', 'hooks-absent', 'intervening-effects'], null, this.uses(equalityReference));
    } else this.unknown(equality, 'equality unsupported', 'Default equality is outside the finite Object.is/own-string comparison grammar.');
    const declarations = body(cache)[1];
    const tuple = declarations?.type === 'VariableDeclaration' ? declarations.declarations[0] : null;
    const fallback = tuple?.init?.type === 'ConditionalExpression' ? tuple.init.consequent : null;
    const reference = fallback?.type === 'ArrayExpression' ? fallback.elements[0] : null;
    const defaults = reference && this.value(reference);
    if (!reference || !this.immutable(reference) || this.uses(reference).some(use => use !== reference) || defaults?.type !== 'ObjectExpression' || defaults.properties.length !== 1) { this.unknown(cache, 'defaults provenance', 'Default object has an extra writer, alias, publication or unsupported allocation.'); return; }
    const property = defaults.properties[0];
    if (property?.type !== 'Property' || property.computed || property.method || property.kind !== 'init' || key(property.key) !== 'locateFile' || !fn(property.value)) { this.unknown(defaults, 'defaults provenance', 'Default object must supply exactly one own locateFile callback.'); return; }
    const allocation = this.allocation(defaults, 'Object.prototype', ['locateFile'], [], [fallback!]);
    this.add('defaults allocation', defaults, defaults, 'One fresh default record has own locateFile callback and ordinary prototype; callback effects remain conditional. Default identity is not proof of unchanged contents, absence of inherited hooks or future factory receiver provenance.', ['default-callback-effects', 'standard-prototypes', 'hooks-absent', 'intervening-effects', 'publication-lifetime'], allocation, this.uses(reference));
  }
  equalGrammar(equality: Fn): boolean {
    if (equality.async || equality.generator || equality.params.length !== 2 || equality.params.some(parameter => parameter.type !== 'Identifier') || body(equality).length !== 1) return false;
    const statement = body(equality)[0], value = statement?.type === 'ReturnStatement' ? statement.argument : null;
    if (value?.type !== 'LogicalExpression' || value.operator !== '||') return false;
    const [left, right] = equality.params;
    const intrinsic = (node: E.Node | null | undefined, name: string, args: (E.Node | null | undefined)[]): node is E.CallExpression => call(node) && member(node.callee, name) && this.graph.standard(node.callee.object, 'Object') && node.arguments.length === args.length && node.arguments.every((argument, index) => this.graph.same(argument, args[index]));
    if (!intrinsic(value.left, 'is', [left, right]) || value.right.type !== 'LogicalExpression' || value.right.operator !== '&&') return false;
    const lengths = value.right.left, every = value.right.right;
    if (lengths.type !== 'BinaryExpression' || lengths.operator !== '===' || !member(lengths.left, 'length') || !member(lengths.right, 'length') || !intrinsic(lengths.left.object, 'keys', [left]) || !intrinsic(lengths.right.object, 'keys', [right]) || !call(every) || !member(every.callee, 'every') || !intrinsic(every.callee.object, 'keys', [left]) || every.arguments.length !== 1 || !fn(every.arguments[0])) return false;
    const callback = every.arguments[0], parameter = callback.params[0];
    if (callback.async || callback.generator || callback.params.length !== 1 || parameter?.type !== 'Identifier' || callback.body.type === 'BlockStatement') return false;
    const check = callback.body;
    if (check.type !== 'LogicalExpression' || check.operator !== '&&' || !intrinsic(check.left, 'hasOwn', [right, parameter]) || check.right.type !== 'BinaryExpression' || check.right.operator !== '===') return false;
    const indexed = (node: E.Node, receiver: E.Node | undefined): boolean => node.type === 'MemberExpression' && node.computed && !node.optional && this.graph.same(node.object, receiver) && this.graph.same(node.property, parameter);
    return indexed(check.right.left, left) && indexed(check.right.right, right) && equality.params.every(parameter => this.immutable(parameter)) && this.immutable(parameter);
  }
  cacheTransitions(): void {
    // The producer's finite cache grammar has already matched. Keep exact
    // operations and allocation identities; no caller or property effects close.
    const { cache } = this.context;
    const statements = body(cache), declarations = statements[1], branch = statements[2], tail = statements[3];
    if (declarations?.type !== 'VariableDeclaration' || branch?.type !== 'IfStatement' || branch.consequent.type !== 'BlockStatement' || tail?.type !== 'ExpressionStatement') return;
    const tuple = declarations.declarations[0], selected = declarations.declarations[1];
    if (tuple?.init?.type !== 'ConditionalExpression' || tuple.init.test.type !== 'BinaryExpression' || tuple.init.test.left.type !== 'AssignmentExpression' || !call(tuple.init.test.left.right) || !member(tuple.init.test.left.right.callee, 'get') || !selected) return;
    const get = tuple.init.test.left.right, map = get.callee.type === 'MemberExpression' ? get.callee.object : get;
    const mapNode = this.value(map);
    if (mapNode?.type !== 'NewExpression' || !this.immutable(map)) { this.unknown(map, 'cache references', 'Cache allocation binding is mutable or unavailable.'); return; }
    const readyStatement = branch.consequent.body[1], returned = branch.consequent.body[2];
    const ready = readyStatement?.type === 'VariableDeclaration' ? readyStatement.declarations[0] : null;
    const write = returned?.type === 'ReturnStatement' && returned.argument?.type === 'SequenceExpression' ? returned.argument.expressions[0] : null;
    const deferred = tail.expression.type === 'LogicalExpression' ? tail.expression.right : null;
    if (!ready || !call(ready.init) || ready.init.arguments[0]?.type !== 'ObjectExpression' || !call(write) || !call(deferred)) return;
    const allocation = this.allocation(mapNode, 'WeakMap.prototype', [], [write, deferred], []);
    const ids = ['cache-order', 'standard-prototypes', 'inherited-fireImmediately', 'inherited-equalityFn', 'equality-effects', 'iterator-effects', 'spread-get-effects', 'factory-effects', 'reentry', 'hooks-absent', 'then-assimilation', 'intervening-effects'];
    this.add('cache transition', deferred, map, 'When fireImmediately is false and equal, the cache preserves its entry; false and unequal stores [selected] and drops any old result. A cold false/no-override call compares defaults with themselves and performs no factory call or write only if equality returns truthy.', ids, allocation, this.uses(map), [write, deferred]);
    this.add('cache transition', branch.consequent.body[0]!, map, 'Immediate branch with a truthy old result and equal options reuses that result. A falsy result is not reused. Equality is the supplied parameter, not an assumed intrinsic or hook-absence test.', ids, allocation, this.uses(map), [write, deferred]);
    this.add('cache transition', write, map, 'If the synchronous factory throws before set, the cache preserves its old entry. A returned promise is cached before later rejection; no eviction or retry is installed. Cache method Get or set failure remains a separate effect.', ids, allocation, this.uses(map), [write, deferred]);
    const snapshot = this.allocation(ready.init.arguments[0], 'Object.prototype', [], [], [ready.init]);
    this.add('cache transition', ready.init, ready.init.callee, 'Cache stores original options; factory receives a new shallow snapshot with own enumerable strings and Symbols copied through Gets and CreateDataProperty. Ordinary prototype remains. There is no placeholder before factory; getter, equality, iterator, spread or factory reentry can repeat creation and an outer set can overwrite an inner entry.', ids, snapshot, this.uses(selected.id), [write, deferred]);
    this.fail(ready.init, 'preserve-cache', 'A synchronous factory throw precedes the matched set; promise rejection occurs after storage without eviction.');
  }
  sourceAndCopy(): void {
    const { loader, initialization, wrapper } = this.context;
    const loaded = this.directCalls(loader), configured = this.directCalls(wrapper);
    if (loaded?.length !== 1 || configured?.length !== 1) { this.unknown(loader, 'source references', 'Loader or configuration helper has another caller, writer, alias or publication.'); return; }
    const attempt = body(loader)[0];
    if (attempt?.type !== 'TryStatement' || !attempt.handler) return;
    for (const [block, role, detail, route] of [
      [attempt.block, 'adjacent read', 'Adjacent read evaluates filesystem and readBytes Gets, constructs URL, calls with the filesystem receiver and awaits inside try. Any Get, construction, synchronous call or rejection selects fallback.', 'fallback'],
      [attempt.handler.body, 'fallback read', 'Fallback receiver is read again; failure propagates with no third route. Only adjacent success is eligible for the resource contract.', 'propagate'],
    ] as const) {
      const returned = block.body[0];
      const read = returned?.type === 'ReturnStatement' && returned.argument?.type === 'AwaitExpression' ? returned.argument.argument : null;
      if (!call(read) || !member(read.callee, 'readBytes')) continue;
      this.add(role, read, read.callee.type === 'MemberExpression' ? read.callee.object : read, detail, ['filesystem-read-interface', 'source-bytes', 'receiver-get-effects', 'then-assimilation'], null, this.uses(loader.params[0]!));
      this.fail(read, route, detail);
    }
    const operations = body(initialization).flatMap(statement => statement.type === 'ExpressionStatement' ? expressions(statement.expression) : []);
    const guard = operations[0], wait = operations[1];
    if (guard?.type !== 'LogicalExpression' || guard.right.type !== 'AssignmentExpression' || guard.left.type !== 'BinaryExpression' || wait?.type !== 'AwaitExpression') return;
    const memo = guard.left.left, binding = this.graph.bindings.get(memo), declaration = binding?.defs[0]?.node;
    const expected = new Set([memo, guard.right.left, wait.argument]);
    if (binding?.defs.length !== 1 || declaration?.type !== 'VariableDeclarator' || declaration.init || binding.references.some(reference => !expected.has(reference.identifier)) || binding.references.filter(reference => reference.isWrite()).length !== 1) {
      this.unknown(guard, 'memo references', 'Memo has an initializer, extra writer, reset, read, alias or publication.'); return;
    }
    this.add('memo assignment', guard.right, memo, 'Memo assignment occurs after then returns; synchronous reentry before assignment can repeat loading. After assignment a rejected promise remains cached; await completes configuration only, never module readiness.', ['then-get-call-effects', 'reentry', 'then-assimilation', 'cache-order', 'initialization-readiness'], null, this.uses(memo), [guard.right]);
    this.fail(guard.right, 'reject-memo', 'Before assignment a synchronous failure permits retry; after assignment later rejection persists without eviction.');
    const then = guard.right.right;
    const callback = call(then) ? then.arguments[0] : null;
    if (!fn(callback)) return;
    const copyStatement = body(callback)[0], configureStatement = body(callback)[1];
    const copy = copyStatement?.type === 'VariableDeclaration' ? copyStatement.declarations[0] : null;
    const actions = configureStatement?.type === 'ExpressionStatement' ? expressions(configureStatement.expression) : [];
    const configure = actions[1];
    if (!copy || copy.init?.type !== 'NewExpression' || !call(configure) || configure.arguments[0]?.type !== 'ObjectExpression') return;
    const options = configure.arguments[0], overrides = options.properties[0];
    if (overrides?.type !== 'Property' || overrides.value.type !== 'ObjectExpression') return;
    const inner = overrides.value, wasmBinary = inner.properties[0];
    const byteLength = copy.init.arguments[0], set = actions[0];
    if (!member(byteLength, 'byteLength') || !call(set) || wasmBinary?.type !== 'Property' || !member(wasmBinary.value, 'buffer')) return;
    const copyAllocation = this.allocation(copy.init, 'Uint8Array.prototype', [], [set], [wasmBinary.value]);
    const outer = this.allocation(options, 'Object.prototype', ['overrides'], [], [configure]);
    const innerAllocation = this.allocation(inner, 'Object.prototype', ['wasmBinary'], [], [overrides]);
    this.copy = record({ byteLength, view: copyAllocation, set, bufferGet: wasmBinary.value, wasmBinary, inner: innerAllocation, overrides, outer, configure, requirements: this.requirements(wasmBinary.value, copy.init, ['typed-array-effects', 'copy-options', 'standard-prototypes', 'intervening-effects']) });
    this.add('copy allocation', copy.init, copy.init, 'Fresh Uint8Array syntax reads byteLength, calls set and reads buffer in order. The outer overrides and inner wasmBinary records are separate allocations with ordinary inherited properties; inherited hooks, fireImmediately, equalityFn and then remain possible. Callback has no return or await of configuration.', ['filesystem-read-interface', 'copy-options', 'standard-prototypes', 'typed-array-effects', 'hooks-absent', 'inherited-fireImmediately', 'inherited-equalityFn', 'then-assimilation', 'intervening-effects'], copyAllocation, this.uses(copy.id));
  }
}
