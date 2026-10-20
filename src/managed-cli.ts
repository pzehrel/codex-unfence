import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { deriveCua } from './cua-analysis.js';
import { createManagedPatches } from './managed-patches.js';
import type { CheckResult, OperationResult } from './result.js';

export async function managedCli(args: string[]): Promise<CheckResult | OperationResult> {
  const { values, positionals, tokens } = parseArgs({
    args, options: { app: { type: 'string' }, json: { type: 'boolean' } },
    strict: true, allowPositionals: true, tokens: true,
  });
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name)) throw new Error(`Duplicate option: --${token.name}`);
    seen.add(token.name);
  }
  if (positionals.length !== 1 || !['check', 'status'].includes(positionals[0] ?? '')) throw new Error('Expected command: check or status.');
  if (values.app !== undefined && !isAbsolute(values.app)) throw new Error('--app requires an absolute installation path.');
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const executable = Object.keys(metadata.bin)[0];
  if (!executable) throw new Error('Packaged executable metadata is missing.');
  const managed = createManagedPatches({ derive: deriveCua, tool: { packageName: metadata.name, version: metadata.version, executable } });
  const discovery = await managed.discover(values.app === undefined ? {} : { appPath: values.app });
  const candidate = discovery.selection === 'single' ? discovery.candidates[0] : undefined;
  if (positionals[0] === 'status' && candidate) return managed.status(candidate);
  const inspection = candidate ? await managed.inspect(candidate) : null;
  const diagnostics = [...discovery.diagnostics, ...(inspection?.diagnostics ?? [])];
  if (!candidate) diagnostics.push({ code: discovery.selection === 'required' ? 'SELECTION_REQUIRED' : 'NO_INSTALLATIONS', severity: 'error', message: discovery.selection === 'required' ? 'Select one installation with --app.' : 'No CUA installation found; provide --app with its absolute path.' });
  const outcome = !candidate ? (discovery.selection === 'required' ? 'usage-error' : 'runtime-error')
    : inspection?.operation && inspection.operation.exitCode !== 0 ? inspection.operation.outcome
      : inspection?.support !== 'supported' ? 'incompatible' : 'success';
  const exitCode = { success: 0, 'runtime-error': 1, 'usage-error': 2, incompatible: 3, conflict: 4 }[outcome];
  return { schemaVersion: 1, command: 'check', outcome, exitCode, diagnostics, data: { discovery, inspection, runtime: 'not-verified' } };
}
