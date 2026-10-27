import type { Range } from './cua-contract.js';
import type { DiscoveryReport, Inspection } from './managed-patches.js';
import { assumptionDescription, diagnosticMessage, evidenceDescription } from './cli-text.js';

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

const stateLabels: Record<TargetState, string> = {
  original: '原始文件', 'tool-applied': '已安装补丁', incompatible: '不兼容', conflict: '冲突', incomplete: '操作未完成',
};
const outcomeLabels: Record<CommandResult['outcome'], string> = {
  success: '成功', 'usage-error': '参数错误', 'runtime-error': '运行失败', incompatible: '不兼容', conflict: '冲突',
};
const actionLabels: Record<NonNullable<OperationTarget['action']>, string> = {
  applied: '安装完成', 'already-applied': '补丁已安装', restored: '卸载完成', 'already-original': '已是原始文件', 'rolled-back': '已回滚',
};
const pendingLabels = { before: '操作前', after: '操作后', 'before-and-after': '操作前后相同', unknown: '未知' };

export function renderInspection(inspection: Inspection): string[] {
  return [
    `应用：${inspection.candidate.appPath}`,
    `  目标文件：${inspection.candidate.targetPath}`,
    `  结构兼容：${inspection.support === 'supported' ? '支持' : '不支持'}`,
    `  文件状态：${stateLabels[inspection.state]}`,
    ...(inspection.sourcePatch?.status === 'detected' ? [`  源码补丁：已安装`, `  自动卸载：${inspection.recovery && inspection.allowedActions.includes('restore') ? '可用' : '不可用'}`] : []),
    `  写入条件：${{ ready: '满足', blocked: '不满足', unknown: '未知' }[inspection.writeReadiness]}`,
    `  可以安装：${inspection.allowedActions.includes('apply') ? '是' : '否'}`,
    `  可用操作：${inspection.allowedActions.map(publicActionName).join('、') || '无'}`,
  ];
}

export function renderDiagnostic(diagnostic: Diagnostic): string[] {
  const severity = { info: '提示', warning: '警告', error: '错误' }[diagnostic.severity];
  const lines = [`  ${severity} [${diagnostic.code}] ${diagnosticMessage(diagnostic)}${diagnostic.systemCode ? ` (${diagnostic.systemCode})` : ''}`];
  if (diagnostic.path) lines.push(`    路径：${diagnostic.path}`);
  if (diagnostic.installation) lines.push(`    所属应用：${diagnostic.installation}`);
  if (diagnostic.range) lines.push(`    位置：${diagnostic.range.start}..${diagnostic.range.end}（${diagnostic.range.unit === 'utf16' ? 'UTF-16' : diagnostic.range.unit}）`);
  return lines;
}

export function renderHuman(result: CommandResult): string {
  const lines = [`${result.command ? publicActionName(result.command) : 'codex-unfence'}：${outcomeLabels[result.outcome]}`];
  if (result.data) {
    if (result.command === 'check') {
      for (const inspection of result.data.inspections) {
        lines.push('', ...renderInspection(inspection));
        const evidence = inspection.derivation?.evidence ?? [];
        const assumptions = inspection.derivation?.assumptions ?? [];
        if (evidence.length || assumptions.length) lines.push('', '  兼容性详情：');
        for (const entry of evidence) lines.push(`    依据：${evidenceDescription(entry)}`);
        for (const assumption of assumptions) lines.push(`    前提：${assumptionDescription(assumption)}`);
        if (inspection.blockers.length) lines.push('', '  无法写入的原因：', ...inspection.blockers.flatMap(renderDiagnostic));
      }
    }
    if ('store' in result.data) {
      if (result.data.store) lines.push('', `恢复数据：${result.data.store}`);
      for (const target of result.data.targets) {
        lines.push('', `目标文件：${target.path}`, `  文件状态：${stateLabels[target.state]}${target.action ? `（${actionLabels[target.action]}）` : ''}`);
        if (target.pending) lines.push(`  未完成操作：${target.pending.transaction}`, `  当前内容：${pendingLabels[target.pending.current]}`, `  操作前状态：${stateLabels[target.pending.before]}`);
      }
      if (result.data.pendingTransactions?.length) {
        lines.push('', '中断的操作：', '  恢复会回滚到操作前的文件状态，不会继续完成中断的操作。');
        for (const pending of result.data.pendingTransactions) lines.push(`  ${pending.transaction}：${publicActionName(pending.operation)}，${stateLabels[pending.state]}，${pending.targets.length} 个文件`);
        lines.push('  下一步：重新运行 install 或 uninstall，按提示恢复。');
      }
    }
    lines.push('', '运行效果：未验证。应用版本号不能确认当前运行的是哪个安装。');
  }
  if (result.diagnostics.length) lines.push('', '诊断：', ...result.diagnostics.flatMap(renderDiagnostic));
  if (result.outcome === 'usage-error') lines.push('', `使用 codex-unfence${result.command ? ` ${result.command}` : ''} --help 查看用法。`);
  return `${lines.join('\n')}\n`;
}
