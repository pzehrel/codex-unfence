import type { SourceAnalysis, SourceRange } from './analysis.js';

export const EXIT_CODES = {
  success: 0,
  runtimeError: 1,
  usageError: 2,
  incompatible: 3,
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
  outcome: 'success' | 'usage-error' | 'runtime-error' | 'incompatible';
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

export type CommandResult = DetectionResult | PreparationResult | (ResultBase & { command: null; data: null });

export function renderHuman(result: CommandResult): string {
  const lines = [`${result.command ?? 'CLI'}: ${result.outcome}`];
  if (result.data) {
    lines.push(`Plugin root: ${result.data.pluginRoot}`);
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
