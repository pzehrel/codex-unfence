import { parse } from 'acorn';
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
  kind: 'source' | 'transport' | 'response' | 'predicate' | 'consumption';
  range: SourceRange;
  description: string;
}

export interface SourceAnalysis {
  patternVersion: 'site-status-v1';
  compatibility: 'compatible' | 'incompatible';
  runtime: 'not-verified';
  evidence: StructuralEvidence[];
  diagnostics: AnalysisDiagnostic[];
  target: SourceRange | null;
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
export function analyzeSource(source: string): SourceAnalysis {
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

  constructor(private readonly program: E.Program) {
    const scopes = analyze(program, { ecmaVersion: 2022, sourceType: 'module', optimistic: false, ignoreEval: false });
    for (const scope of scopes.scopes) {
      for (const reference of scope.through) {
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
    const set = fn.body.body[1];
    need(set?.type === 'ExpressionStatement' && call(set.expression) && member(set.expression.callee, 'set') &&
      member(set.expression.callee.object, 'searchParams') && this.same(set.expression.callee.object.object, address.id) &&
      set.expression.arguments.length === 2 && literal(set.expression.arguments[0], 'site_url') && this.same(set.expression.arguments[1], fn.params[0]), 'site_url must come from the checked site.', fn, 'UNPROVEN_SOURCE');
    const endpoint = objectProperty(returned(fn.body.body[2]), 'endpoint');
    need(call(endpoint) && member(endpoint.callee, 'toString') && this.same(endpoint.callee.object, address.id) && endpoint.arguments.length === 0, 'Request endpoint must come from the site-status URL.', fn, 'UNPROVEN_SOURCE');
    return fn;
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
    for (const node of this.nodes) {
      const target = node.type === 'AssignmentExpression' ? node.left : node.type === 'UpdateExpression' ? node.argument :
        node.type === 'UnaryExpression' && node.operator === 'delete' ? node.argument : null;
      need(!target || !member(target, name), 'Relevant method property is written in source.', target ?? undefined, 'REASSIGNED_BINDING');
      need(!(call(node) && (member(node.callee, 'defineProperty') || member(node.callee, 'defineProperties') || member(node.callee, 'setPrototypeOf') || member(node.callee, 'assign'))), 'Dynamic object mutation is unsupported.', node, 'UNSUPPORTED_BINDING');
    }
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
