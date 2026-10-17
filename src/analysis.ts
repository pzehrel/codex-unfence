import { parse } from 'acorn';
import { inspectDependency } from './dependency-analysis.js';
import type { DependencyEvidenceInput, DependencyProof } from './dependency-analysis.js';
export type { DependencyEvidenceInput, DependencyProof } from './dependency-analysis.js';
import { analyzeDeferredStage } from './deferred-analysis.js';
import { analyze } from 'eslint-scope';
import type { Variable } from 'eslint-scope';
import type * as E from 'estree';

export interface SourceRange {
  start: number;
  end: number;
  unit: 'utf16';
}

export interface AnalysisDiagnostic {
  code: string;
  severity: 'error';
  message: string;
  range?: SourceRange;
}

export interface StructuralEvidence {
  kind: 'source' | 'transport' | 'response' | 'predicate' | 'consumption' | 'initialization' | 'receiver' | 'cache';
  range: SourceRange;
  description: string;
}

export type PatternVersion = 'site-status-v1' | 'site-status-deferred-v1';

export interface SourceAnalysis {
  patternVersion: PatternVersion;
  compatibility: 'compatible' | 'incompatible';
  runtime: 'not-verified';
  evidence: StructuralEvidence[];
  diagnostics: AnalysisDiagnostic[];
  target: SourceRange | null;
  dependencyProof?: DependencyProof;
}

export interface SourceTransformation {
  range: SourceRange;
  before: string;
  after: string;
  patchedSource: string;
  localDiff: string;
}

export interface SourceTransformResult {
  analysis: SourceAnalysis;
  transformation: SourceTransformation | null;
}

/** Pure local transformation; only a proven simple response argument is copied. */
export function transformSource(source: string, dependencyEvidence?: DependencyEvidenceInput): SourceTransformResult {
  const analysis = analyzeSource(source, dependencyEvidence);
  if (!analysis.target) return { analysis, transformation: null };
  const target = analysis.target;
  const before = source.slice(target.start, target.end);
  const after = `({...${before},feature_status:{...${before}?.feature_status,agent:false}})`;
  const prefix = source.slice(0, target.start);
  const suffix = source.slice(target.end);
  const patchedSource = prefix + after + suffix;
  // Reparse instead of printing the AST: all surrounding source stays verbatim.
  parse(patchedSource, { ecmaVersion: 2022, sourceType: 'module' });
  const contextBefore = prefix.slice(Math.max(0, prefix.length - 80));
  const contextAfter = suffix.slice(0, 80);
  const localDiff = `Expression UTF-16 [${target.start}, ${target.end})\nContext before: ${JSON.stringify(contextBefore)}\n- ${before}\n+ ${after}\nContext after: ${JSON.stringify(contextAfter)}\n`;
  return { analysis, transformation: { range: target, before, after, patchedSource, localDiff } };
}

type FunctionNode = E.FunctionDeclaration | E.FunctionExpression;
type Method = E.MethodDefinition & { value: E.FunctionExpression };

class Unproven extends Error {
  constructor(readonly code: string, message: string, readonly node?: E.Node) {
    super(message);
  }
}

function need(condition: unknown, message: string, node?: E.Node, code = 'UNSUPPORTED_CHAIN'): asserts condition {
  if (!condition) throw new Unproven(code, message, node);
}

function range(node: E.Node): SourceRange {
  // Acorn offsets and JavaScript string slices use UTF-16 code units, not bytes.
  const positioned = node as E.Node & { start: number; end: number };
  return { start: positioned.start, end: positioned.end, unit: 'utf16' };
}

function walk(node: E.Node, visit: (node: E.Node) => void): void {
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) if (child && typeof child.type === 'string') walk(child as E.Node, visit);
    } else if (value && typeof value === 'object' && 'type' in value && typeof value.type === 'string') {
      walk(value as E.Node, visit);
    }
  }
}

function property(node: E.Node | null | undefined): string | null {
  if (node?.type === 'Identifier') return node.name;
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
  return null;
}

function member(node: E.Node | null | undefined, name: string): node is E.MemberExpression {
  return node?.type === 'MemberExpression' && !node.optional &&
    (node.computed ? node.property.type === 'Literal' && node.property.value === name : property(node.property) === name);
}

function literal(node: E.Node | null | undefined, value: string | boolean | null): boolean {
  if (node?.type === 'Literal') return node.value === value;
  return typeof value === 'boolean' && node?.type === 'UnaryExpression' && node.operator === '!' &&
    node.argument.type === 'Literal' && node.argument.value === (value ? 0 : 1);
}

function call(node: E.Node | null | undefined): node is E.CallExpression {
  return node?.type === 'CallExpression' && !node.optional;
}

function returned(statement: E.Node | undefined): E.Expression | null {
  return statement?.type === 'ReturnStatement' ? statement.argument ?? null : null;
}

function declaration(statement: E.Node | undefined): E.VariableDeclarator | null {
  return statement?.type === 'VariableDeclaration' && statement.declarations.length === 1 &&
    statement.declarations[0]?.id.type === 'Identifier' ? statement.declarations[0] : null;
}

function awaited(node: E.Node | null | undefined): E.Expression | null {
  return node?.type === 'AwaitExpression' ? node.argument : null;
}

function objectProperty(node: E.Node | null | undefined, name: string): E.Expression | null {
  if (node?.type !== 'ObjectExpression' || node.properties.length !== 1) return null;
  const item = node.properties[0];
  return item?.type === 'Property' && !item.computed && !item.method && item.kind === 'init' &&
    property(item.key) === name && item.value.type !== 'AssignmentPattern' ? item.value as E.Expression : null;
}

/** Pure, finite structural proof. Never evaluates source or reads an installation. */
export function analyzeSource(source: string, dependencyEvidence?: DependencyEvidenceInput): SourceAnalysis {
  const analysis = analyzeSourceOnly(source);
  if (dependencyEvidence === undefined) return analysis;
  const dependencyProof = inspectDependency(source, dependencyEvidence);
  // Until the complete operation graph is proved, evidence can only add a
  // rejection. It never suppresses the source-only capability/effect gates.
  return { ...analysis, compatibility: 'incompatible', target: null, dependencyProof, diagnostics: [...analysis.diagnostics, ...dependencyProof.diagnostics] };
}

function analyzeSourceOnly(source: string): SourceAnalysis {
  const result: SourceAnalysis = {
    patternVersion: 'site-status-v1', compatibility: 'incompatible', runtime: 'not-verified',
    evidence: [], diagnostics: [], target: null,
  };
  let program: E.Program;
  try {
    program = parse(source, { ecmaVersion: 2022, sourceType: 'module', ranges: true }) as unknown as E.Program;
  } catch (error) {
    result.diagnostics.push({ code: 'PARSE_ERROR', severity: 'error', message: error instanceof Error ? error.message : 'Invalid JavaScript.' });
    return result;
  }
  const deferredStage = analyzeDeferredStage(program);
  if (deferredStage) {
    if (deferredStage.compatibility === 'compatible') {
      // A deferred candidate must not hide another legacy or unknown blocking
      // class. The deferred receiver and actual policy ranges cover its own reads.
      const proven = deferredStage.evidence.filter(entry => entry.kind === 'receiver' || entry.kind === 'consumption');
      let other: E.Node | undefined;
      walk(program, node => {
        if (node.type !== 'ClassDeclaration' && node.type !== 'ClassExpression') return;
        walk(node.body, item => {
          if (member(item, 'blocked') && !proven.some(entry => range(item).start >= entry.range.start && range(item).end <= entry.range.end)) other ??= item;
        });
      });
      if (other) return { ...deferredStage, compatibility: 'incompatible', target: null, evidence: [], diagnostics: [{ code: 'AMBIGUOUS_PATTERN', severity: 'error', message: 'Another legacy or unknown blocking class lies outside the complete deferred proof; unique pattern selection is unproven.', range: range(other) }] };
    }
    return deferredStage;
  }
  try {
    const proof = new Proof(program);
    const candidates: { target: E.Node; evidence: StructuralEvidence[]; patched: boolean }[] = [];
    const failures: Unproven[] = [];
    const classes: (E.ClassDeclaration | E.ClassExpression)[] = [];
    walk(program, (node) => { if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') classes.push(node); });
    for (const node of classes) {
      for (const method of node.body.body) {
        if (method.type !== 'MethodDefinition') continue;
        let plausible = false;
        walk(method.value.body, (item) => { if (member(item, 'blocked')) plausible = true; });
        if (!plausible) continue;
        try {
          need(node.type === 'ClassDeclaration' && program.body.includes(node), 'Nested or expression classes are outside the supported pattern.', node);
          candidates.push(proof.chain(node, method as Method));
        } catch (error) {
          if (!(error instanceof Unproven)) throw error;
          failures.push(error);
        }
      }
    }
    if (candidates.length > 1) {
      throw new Unproven('AMBIGUOUS_TARGET', `Found ${candidates.length} complete consumption chains; exactly one is required.`);
    }
    const candidate = candidates[0];
    if (candidate && failures.length) throw new Unproven('UNPROVEN_CANDIDATE', 'Another plausible blocking consumption chain is unsupported; uniqueness cannot be proven.', failures[0]?.node);
    if (!candidate) throw failures[0] ?? new Unproven('NO_TARGET', 'No complete supported site-status consumption chain found.');
    proof.closedEffects();
    result.evidence = candidate.evidence;
    if (candidate.patched) throw new Unproven('UNTRUSTED_PATCHED_SHAPE', 'Response-copy shape found without trusted operation provenance; this is not proof of tool application.', candidate.target);
    result.compatibility = 'compatible';
    result.target = range(candidate.target);
  } catch (error) {
    if (!(error instanceof Unproven)) throw error;
    result.diagnostics.push({ code: error.code, severity: 'error', message: error.message, ...(error.node ? { range: range(error.node) } : {}) });
  }
  return result;
}

class Proof {
  private readonly bindings = new Map<E.Node, Variable>();
  private readonly nodes: E.Node[] = [];
  private readonly provenFunctions = new Set<FunctionNode>();
  private readonly provenCalls = new Set<E.Node>();
  private readonly provenConstructors = new Set<E.Node>();
  private readonly globals = new Set<E.Identifier>();

  constructor(private readonly program: E.Program) {
    const scopes = analyze(program, { ecmaVersion: 2022, sourceType: 'module', optimistic: false, ignoreEval: false });
    for (const scope of scopes.scopes) {
      for (const reference of scope.through) {
        if (!reference.resolved) this.globals.add(reference.identifier);
        need(!(reference.identifier.name === 'URL' && reference.isWrite()), 'Global URL constructor is reassigned.', reference.identifier, 'REASSIGNED_BINDING');
      }
      for (const variable of scope.variables) {
        for (const identifier of variable.identifiers) {
          const previous = this.bindings.get(identifier);
          need(!previous || [...previous.references, ...variable.references].every((reference) => !reference.isWrite() || reference.init), 'Class binding is reassigned.', identifier, 'REASSIGNED_BINDING');
          this.bindings.set(identifier, variable);
        }
        for (const reference of variable.references) this.bindings.set(reference.identifier, variable);
      }
    }
    walk(program, (node) => {
      this.nodes.push(node);
      need(!(call(node) && node.callee.type === 'Identifier' && node.callee.name === 'eval'), 'eval is unsupported.', node, 'UNSUPPORTED_SCOPE');
      const written = node.type === 'AssignmentExpression' ? node.left : node.type === 'UpdateExpression' ? node.argument :
        node.type === 'UnaryExpression' && node.operator === 'delete' ? node.argument : null;
      if (written) walk(written, (target) => need(target.type !== 'MemberExpression', 'Property writes are outside the finite proof; aliases may change the chain.', target, 'UNSUPPORTED_MUTATION'));
      if (node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
        walk(node.left, (target) => need(target.type !== 'MemberExpression', 'Loop property writes are outside the finite proof.', target, 'UNSUPPORTED_MUTATION'));
      }
      need(!(call(node) && ['defineProperty', 'defineProperties', 'setPrototypeOf', 'assign', 'set'].some((name) => member(node.callee, name)) &&
        !(member(node.callee, 'set') && member(node.callee.object, 'searchParams'))), 'Reflective mutation is outside the finite proof.', node, 'UNSUPPORTED_MUTATION');
    });
  }

  /** Close effects over the entire source, including aliases outside the matched bodies. */
  closedEffects(): void {
    for (const fn of this.provenFunctions) walk(fn.body, (node) => {
      if (node.type === 'ThrowStatement') need(node.argument.type === 'NewExpression' && node.argument.callee.type === 'Identifier' && node.argument.callee.name === 'Error' && !this.bindings.has(node.argument.callee) && node.argument.arguments.length === 1 && node.argument.arguments[0]?.type === 'Literal' && typeof node.argument.arguments[0].value === 'string', 'Throw effects must be a literal Error construction.', node, 'UNSUPPORTED_EFFECT');
      if (call(node)) this.provenCalls.add(node);
    });
    const allowedGlobals = new Set<E.Node>();
    for (const node of this.nodes) {
      if (node.type === 'NewExpression' && node.callee.type === 'Identifier' && node.callee.name === 'Error' &&
        !this.bindings.has(node.callee) && node.arguments.length === 1 && node.arguments[0]?.type === 'Literal' && typeof node.arguments[0].value === 'string') {
        this.provenConstructors.add(node);
      }
      if (node.type === 'NewExpression' && this.provenConstructors.has(node)) allowedGlobals.add(node.callee);
      need(node.type !== 'CallExpression' || this.provenCalls.has(node), 'Call effects are outside the closed structural proof.', node, 'UNSUPPORTED_EFFECT');
      need(node.type !== 'NewExpression' || this.provenConstructors.has(node), 'Constructor effects are outside the closed structural proof.', node, 'UNSUPPORTED_EFFECT');
      need(!['ImportDeclaration', 'ImportExpression', 'ExportAllDeclaration', 'ExportNamedDeclaration', 'ExportDefaultDeclaration', 'TaggedTemplateExpression'].includes(node.type), 'Module escapes and implicit calls are outside the closed structural proof.', node, 'UNSUPPORTED_EFFECT');
    }
    for (const reference of this.globals) need(allowedGlobals.has(reference), 'Ambient capabilities may escape or mutate the proven chain.', reference, 'UNSUPPORTED_EFFECT');
  }

  private stable(node: E.Node | null | undefined): Variable {
    need(node?.type === 'Identifier', 'Expected a simple bound identifier.', node ?? undefined, 'UNSUPPORTED_BINDING');
    const binding = this.bindings.get(node);
    need(binding && binding.defs.length === 1, 'Binding is missing, shadowed or ambiguous.', node, 'UNSUPPORTED_BINDING');
    need(binding.references.every((reference) => !reference.isWrite() || reference.init), 'Relevant binding is reassigned.', node, 'REASSIGNED_BINDING');
    return binding;
  }

  private same(a: E.Node | null | undefined, b: E.Node | null | undefined): boolean {
    return a?.type === 'Identifier' && b?.type === 'Identifier' && this.stable(a) === this.stable(b);
  }

  private fn(node: E.Node | null | undefined, count: number): E.FunctionDeclaration {
    const binding = this.stable(node);
    const definition = binding.defs[0];
    need(definition?.type === 'FunctionName' && definition.node.type === 'FunctionDeclaration' &&
      this.program.body.includes(definition.node), 'Only module-level function declarations are supported.', node ?? undefined, 'UNSUPPORTED_BINDING');
    need(binding.references.every((reference) => this.nodes.some((item) => call(item) && item.callee === reference.identifier)), 'Relevant function binding escapes direct calls.', node ?? undefined, 'ESCAPED_BINDING');
    const fn = definition.node as E.FunctionDeclaration;
    this.provenFunctions.add(fn);
    this.parameters(fn, count);
    return fn;
  }

  private parameters(fn: FunctionNode, count: number): void {
    need(!fn.generator && fn.params.length === count && fn.params.every((item) => item.type === 'Identifier'), 'Only simple, fixed parameters are supported.', fn);
    for (const parameter of fn.params) this.stable(parameter);
  }

  private constant(node: E.Node | null | undefined, expected: string): void {
    if (literal(node, expected)) return;
    need(node?.type === 'Identifier', 'Expected a literal or initialized constant.', node ?? undefined, 'UNSUPPORTED_INITIALIZATION');
    const binding = this.bindings.get(node);
    const definition = binding?.defs[0];
    need(definition?.type === 'Variable' && definition.node.type === 'VariableDeclarator' &&
      definition.parent?.type === 'VariableDeclaration' && definition.parent.kind === 'const' &&
      this.program.body.includes(definition.parent), 'Only direct module const initialization is proven; deferred initialization is unsupported.', node ?? undefined, 'UNSUPPORTED_INITIALIZATION');
    this.stable(node);
    need(literal(definition.node.init, expected), `Expected constant ${expected}.`, node ?? undefined, 'CHANGED_SEMANTICS');
    // Module constants must be initialized before any supported class declaration.
    need(range(definition.parent).end < Math.min(...this.program.body.filter((item) => item.type === 'ClassDeclaration').map((item) => range(item).start)), 'Constant initialization order is unsupported.', node ?? undefined, 'UNSUPPORTED_INITIALIZATION');
  }

  private guard(callee: E.Node, argument: E.Node): E.FunctionDeclaration {
    const fn = this.fn(callee, 1);
    need(!fn.async && fn.body.body.length === 1, 'Unsupported object guard.', fn, 'CHANGED_SEMANTICS');
    const expression = returned(fn.body.body[0]);
    need(expression?.type === 'LogicalExpression' && expression.operator === '&&', 'Expected object and non-null guard.', fn, 'CHANGED_SEMANTICS');
    const { left, right } = expression;
    need(left.type === 'BinaryExpression' && ['==', '==='].includes(left.operator) &&
      left.left.type === 'UnaryExpression' && left.left.operator === 'typeof' && this.same(left.left.argument, fn.params[0]) && literal(left.right, 'object') &&
      right.type === 'BinaryExpression' && ['!=', '!=='].includes(right.operator) && this.same(right.left, fn.params[0]) && literal(right.right, null), 'Object guard semantics changed.', fn, 'CHANGED_SEMANTICS');
    this.stable(argument);
    return fn;
  }

  private predicate(node: E.CallExpression, body: E.Node): E.FunctionDeclaration {
    need(node.arguments.length === 1, 'Expected agent-specific predicate call.', node);
    const wrapper = this.fn(node.callee, 1);
    need(!wrapper.async && wrapper.body.body.length === 1, 'Unsupported agent-specific wrapper.', wrapper);
    const inner = returned(wrapper.body.body[0]);
    need(call(inner) && inner.arguments.length === 2 && this.same(inner.arguments[0], wrapper.params[0]), 'Predicate wrapper must pass its own response unchanged.', wrapper);
    this.constant(inner.arguments[1], 'agent');
    const generic = this.fn(inner.callee, 2);
    need(!generic.async && generic.body.body.length === 3, 'Unsupported generic predicate.', generic);
    const [guard, flagsStatement, comparisonStatement] = generic.body.body;
    need(guard?.type === 'IfStatement' && guard.alternate === null && guard.test.type === 'UnaryExpression' && guard.test.operator === '!' &&
      call(guard.test.argument) && guard.test.argument.arguments.length === 1 && this.same(guard.test.argument.arguments[0], generic.params[0]) && literal(returned(guard.consequent), false), 'Expected false for non-object response.', generic, 'CHANGED_SEMANTICS');
    const objectGuard = this.guard(guard.test.argument.callee, generic.params[0]!);
    const flags = declaration(flagsStatement);
    need(flags && member(flags.init, 'feature_status') && this.same(flags.init.object, generic.params[0]), 'Predicate must read feature_status from its own response.', generic, 'CHANGED_SEMANTICS');
    const comparison = returned(comparisonStatement);
    need(comparison?.type === 'ConditionalExpression' && call(comparison.test) && comparison.test.arguments.length === 1 &&
      this.same(comparison.test.arguments[0], flags.id) && this.fn(comparison.test.callee, 1) === objectGuard && literal(comparison.alternate, false), 'Expected guarded feature_status comparison.', generic, 'CHANGED_SEMANTICS');
    const truth = comparison.consequent;
    need(truth.type === 'BinaryExpression' && truth.operator === '===' && literal(truth.right, true) && truth.left.type === 'MemberExpression' && truth.left.computed && !truth.left.optional &&
      this.same(truth.left.object, flags.id) && this.same(truth.left.property, generic.params[1]), 'Only agent strictly equal to true may block.', generic, 'CHANGED_SEMANTICS');
    this.stable(body);
    return wrapper;
  }

  private source(node: E.CallExpression, input: E.Node): E.FunctionDeclaration {
    need(node.arguments.length === 1 && this.same(node.arguments[0], input), 'Request builder must receive the checked site.', node, 'UNPROVEN_SOURCE');
    const fn = this.fn(node.callee, 1);
    need(!fn.async && fn.body.body.length === 3, 'Unsupported request builder.', fn, 'UNPROVEN_SOURCE');
    const address = declaration(fn.body.body[0]);
    need(address?.init?.type === 'NewExpression' && address.init.callee.type === 'Identifier' && address.init.callee.name === 'URL' &&
      !this.bindings.has(address.init.callee) && address.init.arguments.length === 1 && literal(address.init.arguments[0], 'https://chatgpt.com/backend-api/aura/site_status'), 'Expected the exact site-status URL constructed by the unshadowed URL global.', fn, 'UNPROVEN_SOURCE');
    this.provenConstructors.add(address.init);
    const set = fn.body.body[1];
    need(set?.type === 'ExpressionStatement' && call(set.expression) && member(set.expression.callee, 'set') &&
      member(set.expression.callee.object, 'searchParams') && this.same(set.expression.callee.object.object, address.id) &&
      set.expression.arguments.length === 2 && literal(set.expression.arguments[0], 'site_url') && this.same(set.expression.arguments[1], fn.params[0]), 'site_url must come from the checked site.', fn, 'UNPROVEN_SOURCE');
    const endpoint = objectProperty(returned(fn.body.body[2]), 'endpoint');
    need(call(endpoint) && member(endpoint.callee, 'toString') && this.same(endpoint.callee.object, address.id) && endpoint.arguments.length === 0, 'Request endpoint must come from the site-status URL.', fn, 'UNPROVEN_SOURCE');
    return fn;
  }

  /** Every class/instance reference must preserve the receiver of the proven entry method. */
  private receivers(owner: E.ClassDeclaration, check: Method, query: Method, load: Method): void {
    const methods = [check, query, load];
    need(owner.body.body.length === methods.length && new Set(methods).size === methods.length, 'Only the three proven instance methods are supported.', owner, 'UNSUPPORTED_RECEIVER');
    // A class declaration has both an enclosing and an inner class-name binding.
    const ownerBindings = [...new Set(this.bindings.values())].filter((binding) => binding.defs.some((definition) => definition.type === 'ClassName' && definition.node === owner));
    const entryName = property(check.key)!;
    const entryCall = (receiver: E.Node): boolean => {
      const access = this.nodes.find((node) => member(node, entryName) && node.object === receiver);
      const invocation = this.nodes.find((node) => call(node) && node.callee === access);
      if (!invocation || invocation.type !== 'CallExpression' || invocation.arguments.length !== 2 || invocation.arguments.some((argument) => argument.type === 'SpreadElement')) return false;
      this.provenCalls.add(invocation);
      return true;
    };
    for (const reference of ownerBindings.flatMap((binding) => binding.references)) {
      const instance = this.nodes.find((node) => node.type === 'NewExpression' && node.callee === reference.identifier);
      need(instance?.type === 'NewExpression' && instance.arguments.length === 0, 'Class binding escapes direct zero-argument construction; inheritance and borrowed dispatch are unsupported.', reference.identifier, 'UNSUPPORTED_RECEIVER');
      this.provenConstructors.add(instance);
      if (entryCall(instance)) continue;
      const declarator = this.nodes.find((node) => node.type === 'VariableDeclarator' && node.init === instance);
      need(declarator?.type === 'VariableDeclarator' && declarator.id.type === 'Identifier', 'Constructed receiver escapes a direct entry call or constant binding.', instance, 'UNSUPPORTED_RECEIVER');
      const binding = this.stable(declarator.id);
      const definition = binding.defs[0];
      need(definition?.type === 'Variable' && definition.parent?.type === 'VariableDeclaration' && definition.parent.kind === 'const', 'Receiver must use a constant binding.', declarator, 'UNSUPPORTED_RECEIVER');
      for (const use of binding.references) {
        if (use.init) continue;
        need(entryCall(use.identifier), 'Receiver escapes direct entry-method calls; extraction, aliases and borrowing are unsupported.', use.identifier, 'UNSUPPORTED_RECEIVER');
      }
    }
    for (const method of methods) walk(method.value.body, (node) => {
      if (node.type !== 'ThisExpression') return;
      need(this.nodes.some((item) => item.type === 'MemberExpression' && item.object === node && this.nodes.some((invocation) => call(invocation) && invocation.callee === item &&
        (method === check && member(item, property(query.key)!) || method === query && member(item, property(load.key)!)))), 'this escapes the proven dispatch chain.', node, 'UNSUPPORTED_RECEIVER');
    });
  }

  private method(owner: E.ClassDeclaration, callNode: E.CallExpression, params: E.Pattern[]): Method {
    need(callNode.callee.type === 'MemberExpression' && !callNode.callee.optional && callNode.callee.object.type === 'ThisExpression', 'Only same-class this method calls are proven.', callNode);
    const name = callNode.callee.computed ? (callNode.callee.property.type === 'Literal' ? property(callNode.callee.property) : null) : property(callNode.callee.property);
    need(name, 'Dynamic method name is unsupported.', callNode);
    const methods = owner.body.body.filter((item) => item.type === 'MethodDefinition' && !item.computed && property(item.key) === name);
    need(methods.length === 1, 'Method is missing, duplicated or shadowed.', callNode, 'UNSUPPORTED_BINDING');
    const method = methods[0] as Method;
    need(!method.static && method.kind === 'method' && method.value.async, 'Expected an async instance method.', method);
    this.parameters(method.value, params.length);
    need(callNode.arguments.length === params.length && params.every((parameter, index) => this.same(callNode.arguments[index], parameter)), 'Method must receive the same runtime and request bindings.', callNode, 'UNPROVEN_SOURCE');
    return method;
  }

  chain(owner: E.ClassDeclaration, check: Method): { target: E.Node; evidence: StructuralEvidence[]; patched: boolean } {
    this.stable(owner.id);
    need(!owner.superClass && owner.body.body.every((item) => item.type === 'MethodDefinition' && !item.computed && !item.static && item.kind === 'method'), 'Inheritance, constructors, fields or computed class members are unsupported.', owner);
    const names = owner.body.body.map((item) => item.type === 'MethodDefinition' ? property(item.key) : null);
    need(new Set(names).size === names.length, 'Duplicate class methods may override the consumption chain.', owner, 'UNSUPPORTED_BINDING');
    need(check.value.async && check.value.body.body.length === 3, 'Blocking consumption must be an async three-statement method.', check);
    this.parameters(check.value, 2);
    const [requestStatement, resultStatement, rejection] = check.value.body.body;
    const request = declaration(requestStatement);
    need(request && call(request.init), 'Expected a directly built request.', check, 'UNPROVEN_SOURCE');
    const source = this.source(request.init, check.value.params[1]!);
    const result = declaration(resultStatement);
    const queryCall = awaited(result?.init);
    need(result && call(queryCall), 'Expected awaited same-class query.', check);
    const query = this.method(owner, queryCall, [check.value.params[0]!, request.id]);
    need(rejection?.type === 'IfStatement' && member(rejection.test, 'blocked') && this.same(rejection.test.object, result.id) &&
      rejection.alternate === null && rejection.consequent.type === 'ThrowStatement', 'Consumption must throw when the query result is blocked.', check, 'CHANGED_SEMANTICS');
    need(query.value.body.body.length === 2, 'Unsupported query control flow.', query);
    const blocked = declaration(query.value.body.body[0]);
    const loadCall = awaited(blocked?.init);
    need(blocked && call(loadCall) && this.same(objectProperty(returned(query.value.body.body[1]), 'blocked'), blocked.id), 'Query must expose the awaited predicate result as blocked.', query);
    const load = this.method(owner, loadCall, query.value.params);
    need(load.value.body.body.length === 4, 'Unsupported response control flow.', load);
    const [responseStatement, httpGuard, bodyStatement, consumption] = load.value.body.body;
    const response = declaration(responseStatement);
    const transportCall = awaited(response?.init);
    need(response && call(transportCall) && transportCall.arguments.length === 3 &&
      this.same(transportCall.arguments[0], load.value.params[0]) && member(transportCall.arguments[1], 'endpoint') && this.same(transportCall.arguments[1].object, load.value.params[1]) &&
      literal(objectProperty(transportCall.arguments[2], 'method'), 'GET'), 'Expected GET of the same request endpoint.', load, 'UNPROVEN_SOURCE');
    const transport = this.fn(transportCall.callee, 3);
    need(transport.async && transport.body.body.length === 1, 'Unsupported transport wrapper.', transport);
    const fetch = awaited(returned(transport.body.body[0]));
    need(call(fetch) && member(fetch.callee, 'fetch') && this.same(fetch.callee.object, transport.params[0]) &&
      fetch.arguments.length === 2 && this.same(fetch.arguments[0], transport.params[1]) && this.same(fetch.arguments[1], transport.params[2]), 'Transport must fetch the same endpoint and options.', transport, 'UNPROVEN_SOURCE');
    need(httpGuard?.type === 'IfStatement' && httpGuard.alternate === null && httpGuard.test.type === 'UnaryExpression' && httpGuard.test.operator === '!' &&
      member(httpGuard.test.argument, 'ok') && this.same(httpGuard.test.argument.object, response.id) && httpGuard.consequent.type === 'ThrowStatement', 'Expected HTTP failure to throw before parsing.', load);
    const body = declaration(bodyStatement);
    const json = awaited(body?.init);
    need(body && call(json) && json.arguments.length === 0 && member(json.callee, 'json') && this.same(json.callee.object, response.id), 'JSON must be parsed from the fetched response.', load, 'UNPROVEN_RESPONSE');
    const predicate = returned(consumption);
    need(call(predicate) && predicate.arguments.length === 1, 'Expected a single local predicate consumption.', load);
    const target = predicate.arguments[0]!;
    const patched = this.patched(target, body.id);
    need(patched || this.same(target, body.id), 'Predicate must consume the parsed JSON binding unchanged.', target, 'UNPROVEN_RESPONSE');
    const wrapper = this.predicate(predicate, body.id);
    this.receivers(owner, check, query, load);
    for (const method of [check, query, load]) this.provenFunctions.add(method.value);
    const evidence: StructuralEvidence[] = [
      { kind: 'source', range: range(source), description: 'Site-status URL with site_url from the checked site; endpoint returned in request.' },
      { kind: 'transport', range: range(transport), description: 'Same runtime fetch receives the request endpoint and GET options.' },
      { kind: 'response', range: range(load), description: 'HTTP failure throws; JSON from the same response reaches the local predicate.' },
      { kind: 'predicate', range: range(wrapper), description: 'Bound agent key; object guards; only feature_status[agent] === true blocks.' },
      { kind: 'consumption', range: range(check), description: 'Same-class query exposes the awaited result; blocked result causes a throw.' },
    ];
    return { target, evidence, patched };
  }

  private patched(node: E.Node, body: E.Node): boolean {
    if (node.type !== 'ObjectExpression' || node.properties.length !== 2) return false;
    const [spread, flags] = node.properties;
    if (spread?.type !== 'SpreadElement' || !this.same(spread.argument, body) || flags?.type !== 'Property' || flags.computed || flags.kind !== 'init' || property(flags.key) !== 'feature_status' || flags.value.type !== 'ObjectExpression') return false;
    const [previous, override] = flags.value.properties;
    return flags.value.properties.length === 2 && previous?.type === 'SpreadElement' && previous.argument.type === 'ChainExpression' &&
      previous.argument.expression.type === 'MemberExpression' && previous.argument.expression.optional === true &&
      (previous.argument.expression.computed ? literal(previous.argument.expression.property, 'feature_status') : property(previous.argument.expression.property) === 'feature_status') &&
      this.same(previous.argument.expression.object, body) && override?.type === 'Property' && !override.computed && override.kind === 'init' && property(override.key) === 'agent' && literal(override.value, false);
  }
}
