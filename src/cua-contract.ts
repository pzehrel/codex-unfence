export const CUA_SCHEME = 'cua-site-status-transport-v1' as const;

export type Range = Readonly<{ start: number; end: number; unit: 'utf16' }>;

export type Evidence = Readonly<{
  kind: 'source' | 'transport' | 'response' | 'predicate' | 'consumption' | 'receiver';
  range: Range;
  description: string;
}>;

export type Diagnostic = Readonly<{
  code: string;
  severity: 'error';
  message: string;
  range?: Range;
}>;

export type CuaDerivation = Readonly<{
  scheme: typeof CUA_SCHEME;
  recipeVersion: 1 | 2;
  support: 'supported' | 'unsupported';
  runtime: 'not-verified';
  assumptions: readonly string[];
  evidence: readonly Evidence[];
  diagnostics: readonly Diagnostic[];
  change: null | Readonly<{
    range: Range;
    before: string;
    after: string;
    patchedSource: string;
    localDiff: string;
  }>;
}>;

export type DeriveCua = (source: string) => CuaDerivation;
