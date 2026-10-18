import { resourceCallbacks } from './resource-provenance.js';
import type { ResourceCallbackFacts, ResourceRequirement, ResourceSummary } from './resource-provenance.js';
import type { Variable } from 'eslint-scope';
import type * as E from 'estree';
import type { SourceRange, StructuralEvidence } from './analysis.js';

type Graph = Parameters<typeof resourceCallbacks>[1];
type Fn = Parameters<typeof resourceCallbacks>[2];
type Allocation = E.NewExpression | E.ObjectExpression | E.ArrayExpression | E.CallExpression;
const summaryBrand = Symbol('handle-summary');
class VerifierIdentity { declare private verifierIdentity: void }
export interface HandleSummary extends VerifierIdentity {
  readonly [summaryBrand]: true;
  readonly evidence: readonly Readonly<StructuralEvidence>[];
}
const requirementDescriptions = {
  'receiver-identity': 'exact receiver and own writable $$ metadata identity at every access',
  'writer-closure': 'every alias, field writer, inherited descriptor field and unchanged prototype',
  'publication-closure': 'all constructor, descriptor, handle and method publication consumers',
  'queue-lifetime': 'queue-retained handle lifetime, array methods, exceptions and reentrancy',
  'helper-effects': 'all surrounding validation, converter, registration and helper effects',
  'descriptor-lineage': 'scheduler-supplied descriptors, ABI pointer origins and strictly older immutable class lineage',
  'retained-invocation': 'arbitrary later callback invocation, exceptions, reentrancy and count invariant preservation',
};
interface HandleRequirement {
  readonly id: keyof typeof requirementDescriptions;
  readonly operation: E.Node;
  readonly allocation: Allocation | null;
  readonly state: 'unsatisfied';
}
interface Operation {
  readonly role: string;
  readonly node: E.Node;
  readonly status: 'proved' | 'conditional' | 'pruned';
  readonly detail: string;
  readonly receiver: E.Node;
  readonly allocations: readonly Allocation[];
  readonly references: readonly E.Node[];
  readonly requirements: readonly (HandleRequirement | ResourceRequirement)[];
  readonly callbacks: readonly ResourceCallbackFacts[];
  readonly fields: readonly FieldLink[];
  readonly links: readonly E.Node[];
}
interface FieldLink {
  readonly store: E.AssignmentExpression;
  readonly formal: E.Pattern;
  readonly formalBinding: Variable;
  readonly argument: E.Node | null;
  readonly argumentBinding: Variable | null;
}
const contexts = new WeakMap<HandleSummary, { graph: Graph; factory: Fn; operations: readonly Operation[] }>();
/** Private graph-local consumer boundary; equal text or copied records are foreign. */
export function handleOperations(summary: HandleSummary, graph: Graph, factory: Fn): readonly Operation[] | null {
  const context = contexts.get(summary);
  return context?.graph === graph && context.factory === factory ? context.operations : null;
}
const fn = (node: E.Node | undefined | null): node is Fn => !!node && ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type);
const call = (node: E.Node | undefined | null): node is E.CallExpression => node?.type === 'CallExpression' && !node.optional;
const member = (node: E.Node | undefined | null, name: string): node is E.MemberExpression => node?.type === 'MemberExpression' && !node.optional && (node.computed ? node.property.type === 'Literal' && node.property.value === name : node.property.type === 'Identifier' && node.property.name === name);
const range = (node: E.Node): SourceRange => { const located = node as E.Node & { start: number; end: number }; return { start: located.start, end: located.end, unit: 'utf16' }; };
const boolean = (node: E.Node | undefined | null, value: boolean): boolean => node?.type === 'Literal' && node.value === value || node?.type === 'UnaryExpression' && node.operator === '!' && node.argument.type === 'Literal' && node.argument.value === (value ? 0 : 1);

/** Finite syntax facts and outstanding obligations only; never a host-effect waiver. */
export function handleProvenance(graph: Graph, factory: Fn, resources: ResourceSummary): HandleSummary {
  const operations: Operation[] = [];
  const callbacks = resourceCallbacks(resources, graph, factory);
  if (callbacks !== null) new Handles(graph, factory, operations, callbacks).inspect();
  const evidence = Object.freeze(operations.map(operation => Object.freeze({
    kind: 'source' as const, range: Object.freeze(range(operation.node)),
    description: `Handle ${operation.role}: ${operation.status}; ${operation.detail} Remaining conditions: ${operation.requirements.map(requirement => requirement.id in requirementDescriptions ? `${requirement.id} (${requirementDescriptions[requirement.id as keyof typeof requirementDescriptions]})` : requirement.id).join('; ') || 'none for this local fact'}. This record never authorizes a host effect or certifies a cycle.`,
  })));
  const summary: HandleSummary = Object.assign(new VerifierIdentity(), { [summaryBrand]: true as const, evidence });
  Object.freeze(summary);
  contexts.set(summary, { graph, factory, operations: Object.freeze(operations) });
  return summary;
}
class Handles {
  constructor(readonly graph: Graph, readonly factory: Fn, readonly operations: Operation[], readonly callbacks: readonly ResourceCallbackFacts[]) {}
  local(node: E.Node): boolean {
    let owner = this.graph.owner(node);
    while (owner !== this.factory && owner.type !== 'Program') owner = this.graph.owner(owner);
    return owner === this.factory;
  }
  uses(binding: Variable): E.Node[] { return binding.references.filter(reference => !reference.init).map(reference => reference.identifier); }
  record(role: string, node: E.Node, receiver: E.Node, allocations: readonly Allocation[], references: readonly E.Node[], detail: string, ids: readonly (keyof typeof requirementDescriptions)[], status: Operation['status'] = 'conditional', callbacks: readonly ResourceCallbackFacts[] = [], fields: readonly FieldLink[] = [], links: readonly E.Node[] = []): void {
    // Preserve the producer's exact requirement objects and allocation links.
    const requirements = Object.freeze([...callbacks.flatMap(callback => callback.requirements), ...ids.map(id => Object.freeze({ id, operation: node, allocation: allocations[0] ?? null, state: 'unsatisfied' as const }))]);
    this.operations.push(Object.freeze({ role, node, receiver, allocations: Object.freeze([...allocations]), references: Object.freeze([...references]), callbacks: Object.freeze([...callbacks]), fields: Object.freeze([...fields]), links: Object.freeze([...links]), detail, requirements, status }));
  }
  immutable(node: E.Node): boolean {
    const binding = this.graph.bindings.get(node);
    return !!binding && binding.defs.length === 1 && binding.references.every(reference => !reference.isWrite() || reference.init);
  }
  pointers(allocation: E.NewExpression, callbacks: readonly ResourceCallbackFacts[]): void {
    const declaration = this.graph.parents.get(allocation), owner = callbacks[0]!.scheduler.callback;
    if (declaration?.type !== 'VariableDeclarator' || declaration.init !== allocation || !this.immutable(declaration.id)) return;
    const candidates = this.graph.nodes.filter((node): node is E.NewExpression => node.type === 'NewExpression' && this.graph.owner(node) === owner && this.graph.same(node.arguments[1], declaration.id));
    const expectedFlags = [[true,false,false], [false,false,false], [false,true,false]];
    if (candidates.length !== 3 || !candidates.every((node, index) => node.arguments.length === 5 && expectedFlags[index]!.every((value, offset) => boolean(node.arguments[offset + 2], value)) && this.graph.same(node.callee, candidates[0]!.callee))) return;
    const constructor = this.graph.definition(candidates[0]!.callee);
    if (!constructor || constructor.async || constructor.generator || constructor.params.length !== 11 || constructor.params.some(parameter => parameter.type !== 'Identifier') || !this.immutable(candidates[0]!.callee) || constructor.body.type !== 'BlockStatement' || constructor.body.body.length !== 1 || constructor.body.body[0]?.type !== 'ExpressionStatement') return;
    const expression = constructor.body.body[0].expression;
    if (expression.type !== 'SequenceExpression' || expression.expressions.length !== 12) return;
    const names = ['name','registeredClass','isReference','isConst','isSmartPointer','pointeeType','sharingPolicy','rawGetPointee','rawConstructor','rawShare','rawDestructor'];
    const stores = expression.expressions.slice(0,11);
    if (!stores.every((store, index) => store.type === 'AssignmentExpression' && store.operator === '=' && member(store.left, names[index]!) && store.left.object.type === 'ThisExpression' && this.graph.same(store.right, constructor.params[index]))) return;
    const selector = expression.expressions[11];
    if (selector?.type !== 'ConditionalExpression' || selector.test.type !== 'LogicalExpression' || selector.test.operator !== '&&' || selector.test.left.type !== 'UnaryExpression' || selector.test.left.operator !== '!' || !this.graph.same(selector.test.left.argument, constructor.params[4]) || selector.test.right.type !== 'BinaryExpression' || selector.test.right.operator !== '===' || !member(selector.test.right.left, 'baseClass') || !this.graph.same(selector.test.right.left.object, constructor.params[1]) || selector.test.right.right.type !== 'UnaryExpression' || selector.test.right.right.operator !== 'void' || selector.test.right.right.argument.type !== 'Literal' || selector.test.right.right.argument.value !== 0 || selector.consequent.type !== 'ConditionalExpression' || !this.graph.same(selector.consequent.test, constructor.params[3])) return;
    const wire = (node: E.Node): boolean => node.type === 'AssignmentExpression' && node.operator === '=' && member(node.left, 'toWireType') && node.left.object.type === 'ThisExpression' && this.immutable(node.right) && !!this.graph.definition(node.right);
    const root = (node: E.Node): boolean => node.type === 'SequenceExpression' && node.expressions.length === 2 && wire(node.expressions[0]!) && node.expressions[1]?.type === 'AssignmentExpression' && node.expressions[1].operator === '=' && member(node.expressions[1].left, 'destructorFunction') && node.expressions[1].left.object.type === 'ThisExpression' && node.expressions[1].right.type === 'Literal' && node.expressions[1].right.value === null;
    if (!root(selector.consequent.consequent) || !root(selector.consequent.alternate) || !wire(selector.alternate)) return;
    const binding = this.graph.bindings.get(candidates[0]!.callee)!;
    if (!this.uses(binding).every(use => {
      const parent = this.graph.parents.get(use);
      return parent?.type === 'NewExpression' && candidates.includes(parent) && parent.callee === use || member(parent, 'prototype') && parent.object === use;
    })) return;
    for (const creation of candidates) {
      const fields = stores.map((store, index): FieldLink => Object.freeze({ store: store as E.AssignmentExpression, formal: constructor.params[index]!, formalBinding: this.graph.bindings.get(constructor.params[index]!)!, argument: creation.arguments[index] ?? null, argumentBinding: this.graph.bindings.get(creation.arguments[index]!) ?? null }));
      this.record('pointer allocation', creation, creation, [creation, allocation], this.uses(binding), 'The five positional arguments link this pointer descriptor to the same class allocation; 6 omitted formals are initially undefined, never a later-read or destructor waiver. Root/derived converter selection is syntax only.', ['receiver-identity','writer-closure','publication-closure'], 'conditional', callbacks, fields);
    }
  }
  object(node: E.Node | undefined | null, names: readonly string[]): E.Property[] | null {
    if (node?.type !== 'ObjectExpression' || node.properties.length !== names.length) return null;
    const properties = node.properties;
    return properties.every((property, index) => property.type === 'Property' && property.kind === 'init' && !property.computed && !property.method && (property.key.type === 'Identifier' ? property.key.name : property.key.type === 'Literal' ? property.key.value : null) === names[index]) ? properties as E.Property[] : null;
  }
  creations(): void {
    const pointers = this.operations.filter(operation => operation.role === 'pointer allocation');
    if (pointers.length !== 3) return;
    for (const allocation of this.graph.nodes) {
      if (!call(allocation) || !this.local(allocation) || !member(allocation.callee, 'create') || !this.graph.standard(allocation.callee.object, 'Object') || allocation.arguments.length !== 2) continue;
      const descriptor = this.object(allocation.arguments[1], ['$$']);
      const values = descriptor && this.object(descriptor[0]!.value, ['value','writable']);
      if (!values || !boolean(values[1]!.value, true)) continue;
      const helper = this.graph.owner(allocation);
      if (!fn(helper) || helper.params.length !== 2 || helper.async || helper.generator || !this.graph.same(allocation.arguments[0], helper.params[0]) || !this.graph.same(values[0]!.value, helper.params[1]) || !this.immutable(helper.params[0]!) || !this.immutable(helper.params[1]!)) continue;
      const bindingNode = helper.type === 'FunctionDeclaration' ? helper.id : this.graph.parents.get(helper)?.type === 'VariableDeclarator' ? (this.graph.parents.get(helper) as E.VariableDeclarator).id : null;
      const binding = bindingNode && this.graph.bindings.get(bindingNode);
      if (!binding || !this.immutable(bindingNode!)) continue;
      const uses = this.uses(binding), calls = uses.map(use => this.graph.parents.get(use));
      if (calls.length !== 4 || !calls.every((node, index): node is E.CallExpression => call(node) && node.callee === uses[index] && node.arguments.length === 2 && this.local(node))) continue;
      const stores = this.graph.nodes.filter((node): node is E.AssignmentExpression => node.type === 'AssignmentExpression' && node.operator === '=' && this.graph.owner(node) === helper && member(node.left, 'count') && this.graph.same(node.left.object, helper.params[1]) && !!this.object(node.right, ['value']) && (this.object(node.right, ['value'])![0]!.value.type === 'Literal' && (this.object(node.right, ['value'])![0]!.value as E.Literal).value === 1));
      if (stores.length !== 1) continue;
      const count = stores[0]!, countAllocation = count.right as E.ObjectExpression;
      const returnNode = this.graph.parents.get(allocation), sequence = returnNode && this.graph.parents.get(returnNode), returned = sequence && this.graph.parents.get(sequence);
      if (!call(returnNode) || returnNode.arguments.length !== 1 || returnNode.arguments[0] !== allocation || !this.graph.definition(returnNode.callee) || sequence?.type !== 'SequenceExpression' || sequence.expressions.length !== 2 || sequence.expressions[0] !== count || sequence.expressions[1] !== returnNode || returned?.type !== 'ReturnStatement') continue;
      // Associate the converter with an installation on this exact Mc binding.
      const constructor = this.graph.definition((pointers[0]!.node as E.NewExpression).callee);
      const converters = new Set(calls.map(node => {
        let owner = this.graph.owner(node!);
        if (fn(owner) && this.graph.owner(owner) !== this.factory) owner = this.graph.owner(owner);
        return owner;
      }));
      if (!constructor || converters.size !== 1) continue;
      const converter = [...converters][0]!;
      if (!fn(converter)) continue;
      const converterInstalled = this.graph.nodes.some(node => {
        if (node.type !== 'Property' || node.value.type !== 'Identifier' || this.graph.definition(node.value) !== converter) return false;
        const object = this.graph.parents.get(node), install = object && this.graph.parents.get(object);
        return call(install) && member(install.callee, 'assign') && this.graph.standard(install.callee.object, 'Object') && install.arguments[1] === object && member(install.arguments[0], 'prototype') && this.graph.definition(install.arguments[0].object) === constructor;
      });
      if (!converterInstalled) continue;
      const metadata = calls.map(node => this.object((node as E.CallExpression).arguments[1], (node as E.CallExpression).arguments[1]?.type === 'ObjectExpression' && ((node as E.CallExpression).arguments[1] as E.ObjectExpression).properties.length === 4 ? ['ptrType','ptr','smartPtrType','smartPtr'] : ['ptrType','ptr']));
      if (metadata.some(value => !value)) continue;
      for (let index = 0; index < calls.length; index++) {
        const creation = calls[index] as E.CallExpression, record = creation.arguments[1] as E.ObjectExpression;
        this.record('metadata allocation', creation, creation.arguments[0]!, [record,countAllocation,allocation,...pointers.flatMap(pointer => pointer.allocations)], uses, 'A fresh metadata literal reaches the exact helper count allocation; this is a shared helper count allocation site, with a fresh cell per invocation. Object.create installs writable $$ and returns through the registration helper. Descriptor receiver and pointer origins are still conditional.', ['receiver-identity','writer-closure','publication-closure','descriptor-lineage','helper-effects','retained-invocation'], 'conditional', pointers[0]!.callbacks, [], [helper, count, values[0]!, values[1]!, returnNode, converter, ...metadata[index]!]);
      }
    }
  }
  clones(): void {
    const metadata = this.operations.filter(operation => operation.role === 'metadata allocation');
    if (metadata.length !== 4) return;
    const registration = metadata[0]!.links.find((node): node is E.CallExpression => call(node));
    if (!registration) return;
    for (const creation of this.graph.nodes) {
      if (!call(creation) || !this.local(creation) || !member(creation.callee, 'create') || !this.graph.standard(creation.callee.object, 'Object') || creation.arguments.length !== 2) continue;
      const prototype = creation.arguments[0], outer = this.object(creation.arguments[1], ['$$']), descriptor = outer && this.object(outer[0]!.value, ['value']);
      const copy = descriptor?.[0]?.value;
      if (!call(prototype) || !member(prototype.callee, 'getPrototypeOf') || !this.graph.standard(prototype.callee.object, 'Object') || prototype.arguments.length !== 1 || prototype.arguments[0]?.type !== 'ThisExpression' || !call(copy) || copy.arguments.length !== 1 || !member(copy.arguments[0], '$$') || copy.arguments[0].object.type !== 'ThisExpression') continue;
      const copier = this.graph.definition(copy.callee), copyBinding = this.graph.bindings.get(copy.callee);
      if (!copier || copier.params.length !== 1 || copier.async || copier.generator || !copyBinding || !this.immutable(copy.callee) || this.uses(copyBinding).length !== 1 || !this.immutable(copier.params[0]!)) continue;
      const value = copier.body.type === 'ObjectExpression' ? copier.body : copier.body.type === 'BlockStatement' && copier.body.body.length === 1 && copier.body.body[0]?.type === 'ReturnStatement' ? copier.body.body[0].argument : null;
      const names = ['count','deleteScheduled','preservePointerOnDelete','ptr','ptrType','smartPtr','smartPtrType'];
      const properties = this.object(value, names);
      if (!properties || !properties.every((property, index) => member(property.value, names[index]!) && this.graph.same(property.value.object, copier.params[0]))) continue;
      const register = this.graph.parents.get(creation), declaration = register && this.graph.parents.get(register), method = this.graph.owner(creation);
      if (!call(register) || !this.graph.same(register.callee, registration.callee) || register.arguments.length !== 1 || register.arguments[0] !== creation || declaration?.type !== 'VariableDeclarator' || declaration.init !== register || !this.immutable(declaration.id) || !fn(method) || method.body.type !== 'BlockStatement') continue;
      const statements = method.body.body;
      if (statements.length !== 3 || statements[0]?.type !== 'IfStatement' || statements[0].alternate || statements[1] !== this.graph.parents.get(declaration) || statements[2]?.type !== 'ReturnStatement') continue;
      const count = (node: E.Node, receiver: E.Node): boolean => node.type === 'AssignmentExpression' && node.operator === '+=' && member(node.left, 'value') && member(node.left.object, 'count') && member(node.left.object.object, '$$') && (receiver.type === 'ThisExpression' ? node.left.object.object.object.type === 'ThisExpression' : this.graph.same(node.left.object.object.object, receiver)) && node.right.type === 'Literal' && node.right.value === 1;
      const early = statements[0].consequent, later = statements[2].argument;
      if (early.type !== 'ReturnStatement' || early.argument?.type !== 'SequenceExpression' || early.argument.expressions.length !== 2 || !count(early.argument.expressions[0]!, prototype.arguments[0]) || early.argument.expressions[1]?.type !== 'ThisExpression' || later?.type !== 'SequenceExpression' || later.expressions.length !== 3 || !count(later.expressions[0]!, declaration.id) || !this.graph.same(later.expressions[2], declaration.id)) continue;
      const reset = later.expressions[1];
      if (reset?.type !== 'AssignmentExpression' || reset.operator !== '=' || !member(reset.left, 'deleteScheduled') || !member(reset.left.object, '$$') || !this.graph.same(reset.left.object.object, declaration.id) || !boolean(reset.right, false)) continue;
      const test = statements[0].test;
      if (test.type !== 'SequenceExpression' || test.expressions.length !== 2 || !member(test.expressions[1], 'preservePointerOnDelete') || !member(test.expressions[1].object, '$$') || test.expressions[1].object.object.type !== 'ThisExpression') continue;
      this.record('clone count sharing', creation, prototype.arguments[0], [creation,value as E.ObjectExpression,...metadata[0]!.allocations], this.uses(copyBinding), 'The copied metadata preserves the same count cell; the clone $$ descriptor defaults to nonwritable, nonenumerable and nonconfigurable, subject to inherited descriptor fields. The same-handle branch increments that cell; registration precedes the new-handle increment and flag reset. No registration or finalizer effect is accepted.', ['receiver-identity','writer-closure','publication-closure','helper-effects','retained-invocation'], 'conditional', metadata[0]!.callbacks, [], [copier,copy,register,early.argument.expressions[0]!,later.expressions[0]!,reset,...properties]);
    }
  }
  queueEffects(): void {
    for (const push of this.graph.nodes) {
      if (!call(push) || !this.local(push) || !member(push.callee, 'push') || push.arguments.length !== 1 || push.arguments[0]?.type !== 'ThisExpression') continue;
      const queue = this.graph.bindings.get(push.callee.object), definition = queue?.defs[0]?.node, owner = this.graph.owner(push);
      if (!queue || queue.defs.length !== 1 || definition?.type !== 'VariableDeclarator' || definition.init?.type !== 'ArrayExpression' || definition.init.elements.length || !fn(owner)) continue;
      const flags = this.graph.nodes.filter((node): node is E.AssignmentExpression => node.type === 'AssignmentExpression' && node.operator === '=' && this.graph.owner(node) === owner && member(node.left, 'deleteScheduled') && member(node.left.object, '$$') && node.left.object.object.type === 'ThisExpression' && boolean(node.right, true));
      if (!flags.length) continue;
      const ids = ['receiver-identity','writer-closure','publication-closure','queue-lifetime'] as const;
      this.record('queue retention', push, push.arguments[0], [definition.init], this.uses(queue), 'Syntax only: enqueue would retain the receiver if reached with the expected array and method. Queue-retained lifetime effects stay conditional; this record proves no reachability or ordering.', ids);
      for (const flag of flags) this.record('scheduled flag', flag, flag.left, [definition.init], this.uses(queue), 'Syntax only: the scheduled flag assignment stays conditional on receiver and property semantics, control flow and ordering. Scheduler-call pruning does not discharge this write.', ids);
    }
  }
  inspect(): void {
    this.queueEffects();
    const allocations = new Set(this.callbacks.map(callback => callback.allocation));
    for (const allocation of allocations) {
      const callbacks = this.callbacks.filter(callback => callback.allocation === allocation);
      if (callbacks.length !== 4 || new Set(callbacks.map(callback => callback.field)).size !== 4 || callbacks.some(callback => callback.scheduler.callback !== callbacks[0]!.scheduler.callback || callback.constructor.node !== callbacks[0]!.constructor.node)) continue;
      this.record('class allocation', allocation, allocation, [allocation], callbacks.flatMap(callback => callback.references), 'Syntax connects 4 exact resource callback stores to this new class allocation and its scheduler callback; later invocation and descriptor lineage remain conditional.', ['receiver-identity', 'writer-closure', 'publication-closure'], 'conditional', callbacks);
      for (const callback of callbacks) this.record('callback store syntax', callback.operation, allocation, [allocation], callback.references, `Syntax only: the ${callback.field} assignment, positional formal, resource conversion and new receiver have exact graph identities; this proves no property effect or later call.`, [], 'proved', [callback]);
      this.pointers(allocation, callbacks);
    }
    this.creations();
    this.clones();
    // Reject even potential eval/with interference rather than resolving a dynamic
    // lookup as a closed lexical binding. This local fact needs no resource trust.
    if (this.graph.nodes.some(node => node.type === 'WithStatement' || node.type === 'Identifier' && node.name === 'eval')) return;
    for (const invocation of this.graph.nodes) {
      if (!call(invocation) || !this.local(invocation) || invocation.arguments.length !== 1 || invocation.callee.type !== 'Identifier') continue;
      const binding = this.graph.bindings.get(invocation.callee), definition = binding?.defs[0]?.node;
      const declaration = definition && this.graph.parents.get(definition);
      if (!binding || binding.defs.length !== 1 || definition?.type !== 'VariableDeclarator' || definition.init !== null || declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'var' || binding.scope.block !== this.factory || binding.references.some(reference => reference.isWrite())) continue;
      const guard = this.graph.parents.get(invocation);
      if (guard?.type !== 'LogicalExpression' || guard.operator !== '&&' || guard.right !== invocation) continue;
      const read = guard.left.type === 'LogicalExpression' && guard.left.operator === '&&' ? guard.left.right : guard.left;
      if (!this.graph.same(read, invocation.callee)) continue;
      const references = this.uses(binding);
      if (references.length !== 2 || references.some(reference => reference !== read && reference !== invocation.callee)) continue;
      const callback = this.graph.definition(invocation.arguments[0]!);
      const callbackBinding = this.graph.bindings.get(invocation.arguments[0]!);
      if (!callback || !callbackBinding || callbackBinding.defs.length !== 1 || callbackBinding.references.some(reference => reference.isWrite() && !reference.init) || this.uses(callbackBinding).some(reference => reference !== invocation.arguments[0])) continue;
      const owner = this.graph.owner(invocation);
      if (!fn(owner)) continue;
      const pushes = this.graph.nodes.filter((node): node is E.CallExpression => call(node) && this.graph.owner(node) === owner && member(node.callee, 'push') && node.arguments.length === 1 && node.arguments[0]?.type === 'ThisExpression');
      for (const push of pushes) {
        const queue = this.graph.bindings.get((push.callee as E.MemberExpression).object), queueDefinition = queue?.defs[0]?.node;
        if (!queue || queue.defs.length !== 1 || queueDefinition?.type !== 'VariableDeclarator' || queueDefinition.init?.type !== 'ArrayExpression' || queueDefinition.init.elements.length || queue.references.some(reference => reference.isWrite() && !reference.init)) continue;
        const uses = this.uses(queue);
        if (!uses.every(reference => {
          const access = this.graph.parents.get(reference), context = this.graph.owner(reference);
          return (context === callback || context === owner) && (member(access, 'length') || member(access, context === callback ? 'pop' : 'push'));
        })) continue;
        this.record('scheduler call', invocation, invocation.callee, [], references, 'A function-local var has no initializer or writes and exactly the guard/callee reads in eval-closed lexical scopes; it stays undefined. Only this guarded call is unreachable.', [], 'pruned');
        this.record('flush publication', invocation.arguments[0]!, callback, [queueDefinition.init], this.uses(callbackBinding), 'The flush binding has only this unreachable argument publication; its latent body is not accepted.', [], 'pruned');
      }
    }
  }
}
