import { parse } from 'acorn';
import { analyze } from 'eslint-scope';
import type { ScopeManager, Variable } from 'eslint-scope';
import type * as E from 'estree';

// Private analysis-local identity. Nodes and Variables are borrowed read-only
// facts, never caller-supplied proof inputs or mutable proof state.
class SourceContext {
  declare private sourceContextIdentity: void;
  readonly nodes: readonly E.Node[];
  readonly parents: ReadonlyMap<E.Node, E.Node>;
  readonly bindings: ReadonlyMap<E.Node, Variable>;
  readonly scopeManager: ScopeManager;

  constructor(readonly source: string, readonly program: E.Program) {
    this.scopeManager = analyze(program, { ecmaVersion: 2022, sourceType: 'module', optimistic: false, ignoreEval: false });
    const bindings = new Map<E.Node, Variable>();
    for (const scope of this.scopeManager.scopes) for (const variable of scope.variables) {
      for (const identifier of variable.identifiers) bindings.set(identifier, variable);
      for (const reference of variable.references) bindings.set(reference.identifier, variable);
    }
    const nodes: E.Node[] = [], parents = new Map<E.Node, E.Node>();
    const walk = (node: E.Node, parent?: E.Node): void => {
      nodes.push(node);
      if (parent) parents.set(node, parent);
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) {
          for (const child of value) if (child && typeof child.type === 'string') walk(child as E.Node, node);
        } else if (value && typeof value === 'object' && 'type' in value && typeof value.type === 'string') walk(value as E.Node, node);
      }
    };
    walk(program);
    this.nodes = Object.freeze(nodes);
    this.parents = parents;
    this.bindings = bindings;
    Object.freeze(this);
  }
}

export type { SourceContext };
export type ParsedSource = Readonly<{ source: string; context: SourceContext; parseError: null } | { source: string; context: null; parseError: string }>;

/** Parse and bind once per invocation; retain parse failure for each diagnostic path. */
export function parseSourceContext(source: string): ParsedSource {
  let program: E.Program;
  try { program = parse(source, { ecmaVersion: 2022, sourceType: 'module', ranges: true }) as unknown as E.Program; }
  catch (error) { return Object.freeze({ source, context: null, parseError: error instanceof Error ? error.message : 'Invalid JavaScript.' }); }
  return Object.freeze({ source, context: new SourceContext(source, program), parseError: null });
}
