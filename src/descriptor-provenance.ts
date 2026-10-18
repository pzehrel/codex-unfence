import { parse } from 'acorn';
import { analyze } from 'eslint-scope';
import type { Variable } from 'eslint-scope';
import type * as E from 'estree';
import { resourceCallbacks } from './resource-provenance.js';
import type { ResourceCallbackFacts, ResourceRequirement, ResourceSummary, resourceProvenance } from './resource-provenance.js';
import type { SourceRange, StructuralEvidence } from './analysis.js';

type Graph = Parameters<typeof resourceProvenance>[0];
type Factory = Parameters<typeof resourceProvenance>[1];
type Resource = Parameters<typeof resourceProvenance>[2];
type Fn = Factory;
type Allocation = E.ObjectExpression | E.ArrayExpression | E.CallExpression | E.NewExpression;
const brand = Symbol('descriptor-summary');
class VerifierIdentity { declare private descriptorIdentity: void }
interface Requirement {
  readonly id: string;
  readonly operation: E.Node;
  readonly allocation: Allocation | null;
  readonly state: 'unsatisfied';
}
interface DescriptorRecord {
  readonly role: string;
  readonly operation: E.Node;
  readonly allocation: Allocation | null;
  readonly binding: Variable | null;
  readonly references: readonly E.Node[];
  readonly requirements: readonly (Requirement | ResourceRequirement)[];
  readonly status: 'conditional' | 'unknown';
  readonly detail: string;
  readonly callback: ResourceCallbackFacts | null;
}
/** Private borrowed identities, never public input or a capability waiver. */
export interface DescriptorSummary extends VerifierIdentity {
  readonly [brand]: true;
  readonly evidence: readonly Readonly<StructuralEvidence>[];
}
const contexts = new WeakMap<DescriptorSummary, { graph: Graph; factory: Factory; records: readonly DescriptorRecord[] }>();
export function descriptorRecords(summary: DescriptorSummary, graph: Graph, factory: Factory): readonly DescriptorRecord[] | null {
  const context = contexts.get(summary);
  return context?.graph === graph && context.factory === factory ? context.records : null;
}
const fn = (node: E.Node | null | undefined): node is Fn => !!node && ['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(node.type);
const call = (node: E.Node | null | undefined): node is E.CallExpression => node?.type === 'CallExpression' && !node.optional;
const range = (node: E.Node): SourceRange => { const located = node as E.Node & { start: number; end: number }; return { start: located.start, end: located.end, unit: 'utf16' }; };
const key = (node: E.Node): string | null => node.type === 'Identifier' ? node.name : node.type === 'Literal' && typeof node.value === 'string' ? node.value : null;
const member = (node: E.Node | null | undefined, name?: string): node is E.MemberExpression => node?.type === 'MemberExpression' && !node.optional && (name === undefined || key(node.property) === name && (!node.computed || node.property.type === 'Literal'));
const requirements = ['standard-prototypes','own-data-property','abi-key-category','error-and-name-effects','descriptor-publication','bound-reader-receiver','dynamic-strings-__proto__-hasOwnProperty-hooks-then','shared-array-reentry','callback-result-and-lifetime'];

// The three finite productions describe operations, not minifier identifiers.
// Local identifiers match resolved variables bijectively; free captures must be
// the same resolved binding throughout. No source range or hash is recognized.
const schedulerGrammar = `(outputs,dependencies,callback)=>{
 outputs.forEach(type=>edges[type]=dependencies);
 function complete(completed){var result=callback(completed);result.length!==outputs.length&&error('$text');for(var index=0;index<outputs.length;++index)register(outputs[index],result[index]);}
 var values=Array(dependencies.length),missing=[],count=0;
 {let vector=dependencies;for(let index=0;index<vector.length;++index){let type=vector[index];registered.hasOwnProperty(type)?values[index]=registered[type]:(missing.push(type),waiting.hasOwnProperty(type)||(waiting[type]=[]),waiting[type].push(()=>{values[index]=registered[type],++count,count===missing.length&&complete(values)}));}}
 missing.length===0&&complete(values);
}`;
const wrapperGrammar = `function register(type,descriptor){return commit(type,descriptor,arguments.length>2&&arguments[2]!==void 0?arguments[2]:{})}`;
const registrationGrammar = `function commit(type,descriptor){
 let config=arguments.length>2&&arguments[2]!==void 0?arguments[2]:{};
 var name=descriptor.name;
 if(type||error(name),registered.hasOwnProperty(type)){if(config.ignoreDuplicateRegistrations)return;error(name);}
 if(registered[type]=descriptor,delete edges[type],waiting.hasOwnProperty(type)){var pending=waiting[type];delete waiting[type],pending.forEach(wake=>wake());}
}`;
interface Match { captures: Map<string, E.Identifier>; nodes: Map<E.Node, E.Node> }
function shape(graph: Graph, actual: Fn, grammar: string): Match | null {
  const program = parse(`(${grammar})`, { ecmaVersion: 2022, sourceType: 'module', ranges: true }) as unknown as E.Program;
  const statement = program.body[0];
  if (statement?.type !== 'ExpressionStatement') return null;
  const expected = statement.expression;
  const scopes = analyze(program, { ecmaVersion: 2022, sourceType: 'module', optimistic: false, ignoreEval: false });
  const expectedBindings = new Map<E.Node, Variable>();
  for (const scope of scopes.scopes) for (const variable of scope.variables) {
    for (const id of variable.identifiers) expectedBindings.set(id, variable);
    for (const ref of variable.references) expectedBindings.set(ref.identifier, variable);
  }
  const local = new Map<Variable, Variable>(), reverse = new Map<Variable, Variable>();
  const captures = new Map<string, E.Identifier>(), nodes = new Map<E.Node, E.Node>();
  function compare(a: unknown, b: unknown, parent?: Record<string, unknown>, field?: string): boolean {
    if (b === null || typeof b !== 'object') return a === b;
    if (!a || typeof a !== 'object') return false;
    if (Array.isArray(b)) return Array.isArray(a) && a.length === b.length && b.every((value,index)=>compare(a[index],value));
    const actualNode = a as E.Node, expectedNode = b as E.Node;
    const av = a as Record<string, unknown>, bv = b as Record<string, unknown>;
    if (bv.type === 'Identifier' && bv.name === 'name' && av.type === 'TemplateLiteral') {
      const template=actualNode as E.TemplateLiteral;
      return template.expressions.length===1 && compare(template.expressions[0],expectedNode);
    }
    if (av.type !== bv.type && !(actualNode === actual && av.type === 'FunctionDeclaration' && bv.type === 'FunctionExpression')) return false;
    nodes.set(expectedNode, actualNode);
    if (bv.type === 'Identifier') {
      const aid = actualNode as E.Identifier, bid = expectedNode as E.Identifier;
      const property = field === 'property' && parent?.type === 'MemberExpression' && !parent.computed || field === 'key' && parent?.type === 'Property' && !parent.computed;
      if (property) return aid.name === bid.name;
      const binding = graph.bindings.get(aid), expectedBinding = expectedBindings.get(bid);
      if (bid.name === 'Array') return graph.standard(aid,'Array');
      if (bid.name === 'arguments') return aid.name === 'arguments' && !binding?.defs.length;
      if (!binding) return false;
      if (expectedBinding?.defs.length) {
        if (local.has(expectedBinding) && local.get(expectedBinding) !== binding || reverse.has(binding) && reverse.get(binding) !== expectedBinding) return false;
        local.set(expectedBinding,binding); reverse.set(binding,expectedBinding);
      } else {
        const previous = captures.get(bid.name);
        if (previous && !graph.same(previous,aid)) return false;
      }
      // Repeated local names in separate block scopes are kept distinct above.
      if (!captures.has(bid.name)) captures.set(bid.name,aid);
      return true;
    }
    if (bv.type === 'Literal' && bv.value === '$text') return typeof av.value === 'string';
    return Object.keys(bv).filter(name=>!['start','end','range','loc','raw'].includes(name) && !(name === 'type' && actualNode === actual)).every(name=>compare(av[name],bv[name],bv,name));
  }
  return compare(actual,expected) ? { captures,nodes } : null;
}

/** Finite, conditional registry facts; never closes central dependency gates. */
export function descriptorProvenance(graph: Graph, factory: Factory, resource: ResourceSummary, measured: Resource): DescriptorSummary {
  return new Descriptors(graph,factory,resource,measured).inspect();
}
class Descriptors {
  readonly records: DescriptorRecord[] = [];
  constructor(readonly graph: Graph, readonly factory: Factory, readonly resource: ResourceSummary, readonly measured: Resource) {}
  binding(node: E.Node | null | undefined): Variable | null { return node ? this.graph.bindings.get(node) ?? null : null; }
  id(node: Fn): E.Node | null { const parent=this.graph.parents.get(node); return node.type==='FunctionDeclaration' ? node.id : parent?.type==='VariableDeclarator' ? parent.id : null; }
  uses(node: E.Node): E.Node[] { return this.binding(node)?.references.filter(ref=>!ref.init).map(ref=>ref.identifier) ?? []; }
  immutable(node: E.Node): boolean { const binding=this.binding(node);return !!binding && binding.defs.length===1 && binding.references.every(ref=>!ref.isWrite()||ref.init); }
  value(node: E.Node): E.Expression | null { const binding=this.binding(node), def=binding?.defs[0]?.node;return binding?.defs.length===1 && def?.type==='VariableDeclarator' ? def.init : null; }
  local(node: E.Node): boolean { let owner=this.graph.owner(node);while(owner!==this.factory && owner.type!=='Program')owner=this.graph.owner(owner);return owner===this.factory; }
  calls(node: Fn): E.CallExpression[] | null {
    const id=this.id(node);if(!id||!this.immutable(id))return null;
    const operations:E.CallExpression[]=[];
    return this.uses(id).every(use=>{const parent=this.graph.parents.get(use);if(!call(parent)||parent.callee!==use)return false;operations.push(parent);return true;})?operations:null;
  }
  writes(access: E.Node): boolean {
    let target=access,parent=this.graph.parents.get(target);
    while(parent){
      if(parent.type==='AssignmentExpression')return parent.left===target;
      if(parent.type==='UpdateExpression'||parent.type==='UnaryExpression'&&parent.operator==='delete')return true;
      if(parent.type==='ForOfStatement'||parent.type==='ForInStatement')return parent.left===target;
      if(parent.type==='ArrayPattern'||parent.type==='ObjectPattern'||parent.type==='RestElement'||parent.type==='AssignmentPattern'&&parent.left===target||parent.type==='Property'&&parent.value===target){target=parent;parent=this.graph.parents.get(target);continue;}
      return false;
    }
    return false;
  }
  record(role: string, operation: E.Node, allocation: Allocation | null, binding: Variable | null, references: readonly E.Node[], detail: string, incoming: readonly ResourceRequirement[] = [], callback: ResourceCallbackFacts | null = null, status: DescriptorRecord['status']='conditional'): void {
    const pending=Object.freeze(requirements.map(id=>Object.freeze({id,operation,allocation,state:'unsatisfied' as const})));
    this.records.push(Object.freeze({role,operation,allocation,binding,references:Object.freeze([...references]),requirements:Object.freeze([...incoming,...pending]),status,detail,callback}));
  }
  summary(): DescriptorSummary {
    const records=Object.freeze([...this.records]);
    const evidence=Object.freeze(records.map(record=>Object.freeze({kind:'source' as const,range:Object.freeze(range(record.operation)),description:`Descriptor ${record.role}: ${record.status}; ${record.detail} ${record.references.length} resolved references inventoried. Remaining unsatisfied conditions: ${record.requirements.map(r=>r.id).join(', ')}. No host-effect authorization or cycle proof.`})));
    const summary=Object.assign(new VerifierIdentity(),{[brand]:true as const,evidence});
    Object.freeze(summary);
    contexts.set(summary,{graph:this.graph,factory:this.factory,records});return summary;
  }
  unknown(node: E.Node, detail: string): DescriptorSummary { this.record('scheduler structure',node,null,null,[],detail,[],null,'unknown');return this.summary(); }
  inspect(): DescriptorSummary {
    const callbacks=resourceCallbacks(this.resource,this.graph,this.factory);
    if(!callbacks?.length)return this.summary();
    const schedulers=[...new Set(callbacks.map(fact=>fact.scheduler.target.node))];
    if(schedulers.length!==1)return this.unknown(this.factory,'Resource fields do not share one scheduler binding.');
    const scheduler=schedulers[0]!, matched=shape(this.graph,scheduler,schedulerGrammar);
    if(!matched)return this.unknown(scheduler,'The activation-local scheduler production is unsupported.');
    const captures=matched.captures;
    const wrapper=this.graph.definition(captures.get('register')!), wrapperMatch=wrapper && shape(this.graph,wrapper,wrapperGrammar);
    const commit=wrapperMatch && this.graph.definition(wrapperMatch.captures.get('commit')!);
    const commitMatch=commit && shape(this.graph,commit,registrationGrammar);
    if(!wrapper||!wrapperMatch||!commit||!commitMatch)return this.unknown(scheduler,'Registration wrapper/transition production is unsupported.');
    for(const name of ['registered','waiting','edges'])if(!this.graph.same(captures.get(name),commitMatch.captures.get(name)))return this.unknown(commit,'Registry bindings differ across scheduler and registration.');
    const commitCalls=this.calls(commit);
    if(commitCalls?.length!==1||this.graph.owner(commitCalls[0]!)!==wrapper)return this.unknown(commit,'Registration transition has another writer/caller/publication.');
    const schedulerCalls=this.calls(scheduler);
    if(schedulerCalls?.length!==8||callbacks.some(fact=>!schedulerCalls.includes(fact.scheduler.call)))return this.unknown(scheduler,'Exactly eight direct scheduler callsites and all resource callback associations are required.');
    const tables: {id:E.Identifier;allocation:E.ObjectExpression;refs:E.Node[]}[]=[];
    for(const name of ['waiting','registered','edges']){
      const id=captures.get(name)!,allocation=this.value(id);
      if(!this.immutable(id)||allocation?.type!=='ObjectExpression'||allocation.properties.length||this.graph.owner(allocation)!==this.factory)return this.unknown(id,'Registry needs a distinct immutable empty-object allocation in this factory.');
      const refs=this.uses(id);
      // Outside the matched productions, computed reads are inventoried as
      // unresolved consumers, never silently treated as private own reads.
      if(refs.some(use=>{
        let owner=this.graph.owner(use);while(owner!==scheduler&&owner!==commit&&owner!==this.factory&&owner.type!=='Program')owner=this.graph.owner(owner);
        if(owner===scheduler||owner===commit)return false;
        const access=this.graph.parents.get(use);
        return !member(access)||access.object!==use||!access.computed||this.writes(access);
      }))return this.unknown(id,'A registry has a foreign writer, alias, reflection or publication outside the finite production.');
      tables.push({id,allocation,refs});
    }
    if(new Set(tables.map(table=>table.allocation)).size!==3)return this.unknown(scheduler,'Registry allocations must be distinct.');
    const associations: {call:E.CallExpression;callback:Fn;outputs:E.Node;dependencies:E.Node}[]=[];
    for(const operation of schedulerCalls){
      const [outputs,dependencies,callback]=operation.arguments;
      if(operation.arguments.length!==3||!outputs||!dependencies||!fn(callback)||callback.async||callback.generator||callback.params.length!==1||callback.params[0]?.type!=='Identifier'||!this.immutable(callback.params[0]))return this.unknown(operation,'Scheduled callback/formal/vector relationship is unsupported.');
      associations.push({call:operation,callback,outputs,dependencies});
    }
    for(const table of tables){
      this.record('registry allocation',table.allocation,table.allocation,this.binding(table.id),table.refs,'Fresh distinct registry allocation; each binding reference is linked to a matched operation or an unresolved computed-read consumer. Property writers/prototypes and publication remain conditions.');
      for(const reference of table.refs){
        const access=this.graph.parents.get(reference),operation=access&&this.graph.parents.get(access);
        if(operation?.type==='AssignmentExpression'&&operation.left===access || operation?.type==='UnaryExpression'&&operation.operator==='delete')this.record('registry writer',operation,table.allocation,this.binding(table.id),[reference],`Exact ${operation.type==='UnaryExpression'?'delete':'store'} operation on this registry allocation through its resolved binding. Key category, inherited setter/helper interference and effects remain conditions.`);
      }
    }
    for(const name of ['values','missing','count']){
      const id=captures.get(name)!,value=this.value(id);
      if(!value)continue;
      const allocation=value.type==='ArrayExpression'||value.type==='CallExpression'?value:null;
      this.record('activation allocation',value,allocation,this.binding(id),this.uses(id),name==='count'?'Activation-local counter initialized to zero; retained waiter increments then compares against current missing.length.':'Activation-local vector allocation; retained waiters share this activation only, with separate per-position captures. Array constructor/method/prototype behavior remains a condition.');
    }
    this.record('scheduler',scheduler,null,this.binding(this.id(scheduler)),this.uses(this.id(scheduler)!), 'Each activation allocates its own descriptor vector, missing-key array and completion counter; retained closures capture per-position block bindings. Duplicate dependencies retain separate waiters. Completion reads current missing.length; it does not assume queue exhaustion, successful registration, acyclicity or nonreentry.');
    this.record('registration transition',commit,null,this.binding(this.id(commit)),commitCalls,'Normal-path syntax is register-before-detach-before-wake: write registered slot, delete dependency edge, take waiting array, delete waiting slot, then synchronous forEach. Duplicate guard either returns or calls an unproved error helper; only a throwing error helper prevents overwrite. Callback throw leaves the completed prefix and may interrupt remaining wakeups/registrations; reentry sees committed slot and detached old queue under pending own/prototype/array conditions.');
    for(const association of associations){
      const outputKeys=this.vector(association.outputs,callbacks), dependencyKeys=this.vector(association.dependencies,callbacks);
      this.record('scheduled callback',association.call,null,this.binding(this.id(scheduler)),[association.callback,association.callback.params[0]!,association.outputs,association.dependencies],`Exact callback/formal association with its output and dependency vectors. Output keys: ${outputKeys}; dependency keys: ${dependencyKeys}. Signed i32 -1 and uint32 4294967295 are distinct keys and may wait indefinitely. Callback return arity/content, bound readers, arbitrary dynamic strings, shared arrays and reentry remain conditions.`);
    }
    for(const fact of callbacks)this.record('resource field',fact.operation,fact.allocation,fact.constructor.binding,fact.references,`The ${fact.field} store is linked to the same exact allocation, constructor, scheduler call and callback. ${fact.requirements.length} incoming requirements retained by identity; unsatisfied.`,fact.requirements,fact);
    const union=new Set<E.ObjectExpression>();
    for(const operation of this.calls(wrapper)??[])if(operation.arguments[1]?.type==='ObjectExpression')union.add(operation.arguments[1]);
    for(const association of associations)for(const node of this.graph.nodes){
      if(node.type!=='ArrayExpression'||this.graph.owner(node)!==association.callback)continue;
      const parent=this.graph.parents.get(node);
      if(!(parent?.type==='ReturnStatement'&&parent.argument===node||association.callback.body===node))continue;
      for(const element of node.elements)if(element?.type==='ObjectExpression')union.add(element);
    }
    const fields=['name','fromWireType','toWireType','readValueFromPointer','destructorFunction'];
    for(const allocation of union){
      const own:string[]=[];
      if(!allocation.properties.every(property=>{
        if(property.type!=='Property'||property.kind!=='init'||property.computed||key(property.key)===null||key(property.key)==='__proto__'||own.includes(key(property.key)!))return false;
        own.push(key(property.key)!);return true;
      })) { this.record('union member',allocation,allocation,null,[],'Computed, spread, accessor, duplicate or prototype-setting allocation has unknown own fields.',[],null,'unknown');continue; }
      this.record('union member',allocation,allocation,null,[],`Allocation-linked descriptor union; own: ${own.join(', ')}; missing-own: ${fields.filter(field=>!own.includes(field)).join(', ')||'none'}. Missing own fields do not prove undefined; inherited values remain unknown. Field evaluation, later writers, publication and receiver-sensitive reader invocation remain conditions.`);
    }
    return this.summary();
  }
  scalar(node:E.Node, callbacks:readonly ResourceCallbackFacts[]):string {
    if(node.type==='Literal'&&typeof node.value==='number'&&Number.isInteger(node.value)&&node.value>=-2147483648&&node.value<=2147483647)return 'signed-i32';
    const binding=this.binding(node);
    if(!binding||!this.immutable(node))return 'unknown';
    const table=callbacks[0]!.resource.importTable;
    for(const property of table.properties){
      if(property.type!=='Property')continue;
      const importer=this.graph.definition(property.value),signature=this.measured.imports.find(item=>item.name===key(property.key));
      if(importer&&signature){
        const id=this.id(importer);
        const importedOnly=!!id&&this.immutable(id)&&this.uses(id).every(use=>{const parent=this.graph.parents.get(use);return parent?.type==='Property'&&parent.value===use&&table.properties.includes(parent);});
        const index=importer.params.findIndex(param=>this.binding(param)===binding);
        const entries=table.properties.filter((entry):entry is E.Property=>entry.type==='Property'&&this.graph.definition(entry.value)===importer);
        if(importedOnly&&index>=0&&entries.every(entry=>this.measured.imports.find(item=>item.name===key(entry.key))?.parameters[index]==='i32'))return 'signed-i32 (closed measured import formal)';
      }
    }
    return 'unknown';
  }
  vector(node:E.Node,callbacks:readonly ResourceCallbackFacts[]):string {
    if(node.type==='ArrayExpression')return node.elements.length?node.elements.map(element=>element?this.scalar(element,callbacks):'undefined hole').join(' | '):'empty';
    if(node.type==='ConditionalExpression'&&node.alternate.type==='ArrayExpression'&&!node.alternate.elements.length)return this.vector(node.consequent,callbacks)+' | empty';
    return 'unknown (unsigned view loads are uint32 | undefined only after receiver/writer proof)';
  }
}
