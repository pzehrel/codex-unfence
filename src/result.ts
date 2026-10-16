export const EXIT_CODES = {
  success: 0,
  runtimeError: 1,
  usageError: 2,
} as const;

export interface Diagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  path?: string;
  systemCode?: string;
}

export interface Artifact {
  plugin: 'browser' | 'chrome';
  version: string;
  path: string;
  realPath: string | null;
  availability: 'readable' | 'unavailable';
  compatibility: 'not-analyzed';
}

export interface Detection {
  pluginRoot: string;
  artifacts: Artifact[];
  runtime: 'not-verified';
}

export interface CommandResult {
  schemaVersion: 1;
  command: 'detect' | null;
  outcome: 'success' | 'usage-error' | 'runtime-error';
  exitCode: number;
  data: Detection | null;
  diagnostics: Diagnostic[];
}

export function renderHuman(result: CommandResult): string {
  const lines = [`${result.command ?? 'CLI'}: ${result.outcome}`];
  if (result.data) {
    lines.push(`Plugin root: ${result.data.pluginRoot}`);
    for (const artifact of result.data.artifacts) {
      lines.push(
        `${artifact.plugin} ${artifact.version}: ${artifact.realPath ?? artifact.path}`,
        `  Availability: ${artifact.availability}; structural compatibility: ${artifact.compatibility}`,
      );
    }
    lines.push('Runtime: not-verified. Versions do not identify the running installation.');
  }
  for (const diagnostic of result.diagnostics) {
    lines.push(`[${diagnostic.code}] ${diagnostic.message}${diagnostic.systemCode ? ` ${diagnostic.systemCode}` : ''}${diagnostic.path ? ` (${diagnostic.path})` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}
