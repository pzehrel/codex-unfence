import type { SourceAnalysis, SourceRange } from './analysis.js';

export const EXIT_CODES = {
  success: 0,
  runtimeError: 1,
  usageError: 2,
  incompatible: 3,
  conflict: 4,
} as const;

export interface Diagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  path?: string;
  systemCode?: string;
  range?: SourceRange;
}

export interface Artifact {
  plugin: 'browser' | 'chrome';
  version: string;
  path: string;
  realPath: string | null;
  availability: 'readable' | 'unavailable';
  compatibility: 'not-analyzed' | 'compatible' | 'incompatible';
  analysis?: SourceAnalysis;
}

export interface Detection {
  pluginRoot: string;
  artifacts: Artifact[];
  runtime: 'not-verified';
}

export interface Preparation {
  pluginRoot: string;
  plan: { id: string; directory: string; manifestPath: string; targetCount: number };
  pluginFiles: 'unchanged';
  runtime: 'not-verified';
}

interface ResultBase {
  schemaVersion: 1;
  outcome: 'success' | 'usage-error' | 'runtime-error' | 'incompatible' | 'conflict';
  exitCode: number;
  diagnostics: Diagnostic[];
}

export interface DetectionResult extends ResultBase {
  command: 'detect';
  data: Detection | null;
}

export interface PreparationResult extends ResultBase {
  command: 'prepare';
  data: Preparation | null;
}

export type TransactionCommand = 'apply' | 'restore' | 'status' | 'recover';
export type TargetState = 'original' | 'tool-applied' | 'incompatible' | 'conflict' | 'incomplete';
export interface OperationTarget {
  path: string;
  state: TargetState;
  action?: 'applied' | 'already-applied' | 'restored' | 'already-original' | 'rolled-back';
  pending?: { store: string; transaction: string; operation: 'apply' | 'restore'; current: 'before' | 'after' | 'before-and-after' | 'unknown'; before: 'original' | 'tool-applied'; desired: 'original' | 'tool-applied' };
}
export interface PendingTransaction {
  store: string;
  transaction: string;
  operation: 'apply' | 'restore';
  state: 'incomplete' | 'conflict';
  targets: OperationTarget[];
}
export interface OperationResult extends ResultBase {
  command: TransactionCommand;
  data: {
    store: string;
    transaction: string | null;
    operation: 'apply' | 'restore' | null;
    targets: OperationTarget[];
    groupState?: 'complete' | 'incomplete' | 'conflict' | 'incompatible';
    pendingTransactions?: PendingTransaction[];
    runtime: 'not-verified';
  } | null;
}

export type CommandResult = DetectionResult | PreparationResult | OperationResult | (ResultBase & { command: null; data: null });

export function renderHuman(result: CommandResult): string {
  const lines = [`${result.command ?? 'CLI'}: ${result.outcome}`];
  if (result.data) {
    if ('pluginRoot' in result.data) lines.push(`Plugin root: ${result.data.pluginRoot}`);
    if ('store' in result.data) {
      lines.push(`Operation store: ${result.data.store}`, `Transaction: ${result.data.transaction ?? 'none'}`, `Operation: ${result.data.operation ?? 'none'}`);
      if (result.data.groupState) lines.push(`Group: ${result.data.groupState}`);
      if (result.data.targets.some((target) => target.state === 'incomplete') || result.data.pendingTransactions?.length) lines.push('Explicit recover rolls back to the preoperation state; it does not continue apply or restore.');
      for (const target of result.data.targets) lines.push(`${target.path}: ${target.state}${target.action ? ` (${target.action})` : ''}${target.pending ? ` [pending ${target.pending.transaction}; current ${target.pending.current}; before ${target.pending.before}]` : ''}`);
      for (const pending of result.data.pendingTransactions ?? []) lines.push(`Pending group: ${pending.transaction} (${pending.operation}, ${pending.state}, ${pending.targets.length} targets); recover --store ${pending.store}`);
    }
    for (const artifact of result.command === 'detect' ? result.data.artifacts : []) {
      lines.push(
        `${artifact.plugin} ${artifact.version}: ${artifact.realPath ?? artifact.path}`,
        `  Availability: ${artifact.availability}; structural compatibility: ${artifact.compatibility}`,
      );
      for (const evidence of artifact.analysis?.evidence ?? []) {
        lines.push(`  Evidence ${evidence.kind}: ${evidence.range.start}..${evidence.range.end} ${evidence.range.unit}. ${evidence.description}`);
      }
    }
    if (result.command === 'prepare') {
      lines.push(`Review plan: ${result.data.plan.directory}`, `Manifest: ${result.data.plan.manifestPath}`, `Targets: ${result.data.plan.targetCount}; plugin files unchanged.`);
    }
    lines.push('Runtime: not-verified. Versions do not identify the running installation.');
  }
  for (const diagnostic of result.diagnostics) {
    lines.push(`[${diagnostic.code}] ${diagnostic.message}${diagnostic.systemCode ? ` ${diagnostic.systemCode}` : ''}${diagnostic.path ? ` (${diagnostic.path})` : ''}${diagnostic.range ? ` [${diagnostic.range.start}..${diagnostic.range.end} ${diagnostic.range.unit}]` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}
