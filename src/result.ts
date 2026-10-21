import type { Range } from './cua-contract.js';
import type { DiscoveryReport, Inspection } from './managed-patches.js';

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
  outcome?: 'runtime-error' | 'conflict' | 'usage-error';
  message: string;
  path?: string;
  installation?: string;
  systemCode?: string;
  range?: Range;
}

interface ResultBase {
  schemaVersion: 1;
  outcome: 'success' | 'usage-error' | 'runtime-error' | 'incompatible' | 'conflict';
  exitCode: number;
  diagnostics: Diagnostic[];
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
  command: TransactionCommand | 'install' | 'uninstall';
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

export interface CheckResult extends ResultBase {
  command: 'check';
  data: { discovery: DiscoveryReport; inspections: Inspection[]; inspection: Inspection | null; runtime: 'not-verified' } | null;
}

export type CommandResult = OperationResult | CheckResult | (ResultBase & { command: null; data: null });

export function publicActionName(command: string): string {
  return command === 'apply' ? 'install' : command === 'restore' ? 'uninstall' : command;
}

export function renderHuman(result: CommandResult): string {
  const lines = [`${result.command ?? 'CLI'}: ${result.outcome}`];
  if (result.data) {
    if (result.command === 'check') {
      for (const inspection of result.data.inspections) {
        lines.push(`Installation: ${inspection.candidate.appPath}; target: ${inspection.candidate.targetPath}`);
        lines.push(`Structural support: ${inspection.support}; file state: ${inspection.state}; write readiness: ${inspection.writeReadiness}`);
        for (const evidence of inspection.derivation?.evidence ?? []) lines.push(`Support: ${evidence.description}`);
        for (const assumption of inspection.derivation?.assumptions ?? []) lines.push(`Assumption: ${assumption}`);
        lines.push(`Can install: ${inspection.allowedActions.includes('apply') ? 'yes' : 'no'}; available actions: ${inspection.allowedActions.map(publicActionName).join(', ') || 'none'}`);
        for (const blocker of inspection.blockers) lines.push(`[${blocker.code}] ${blocker.message}`);
      }
    }
    if ('store' in result.data) {
      lines.push(`Operation store: ${result.data.store}`, `Transaction: ${result.data.transaction ?? 'none'}`, `Operation: ${result.data.operation ?? 'none'}`);
      if (result.data.groupState) lines.push(`Group: ${result.data.groupState}`);
      if (result.data.targets.some((target) => target.state === 'incomplete') || result.data.pendingTransactions?.length) lines.push('Explicit recover rolls back to the preoperation state; it does not continue apply or restore.');
      for (const target of result.data.targets) lines.push(`${target.path}: ${target.state}${target.action ? ` (${target.action})` : ''}${target.pending ? ` [pending ${target.pending.transaction}; current ${target.pending.current}; before ${target.pending.before}]` : ''}`);
      for (const pending of result.data.pendingTransactions ?? []) lines.push(`Pending group: ${pending.transaction} (${pending.operation}, ${pending.state}, ${pending.targets.length} targets); rerun install or uninstall to recover`);
    }
    lines.push('Runtime: not-verified. Versions do not identify the running installation.');
  }
  for (const diagnostic of result.diagnostics) {
    lines.push(`[${diagnostic.code}] ${diagnostic.message}${diagnostic.systemCode ? ` ${diagnostic.systemCode}` : ''}${diagnostic.path ? ` (${diagnostic.path})` : ''}${diagnostic.installation ? ` (installation: ${diagnostic.installation})` : ''}${diagnostic.range ? ` [${diagnostic.range.start}..${diagnostic.range.end} ${diagnostic.range.unit}]` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}
