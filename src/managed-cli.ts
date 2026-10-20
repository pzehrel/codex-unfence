import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { deriveCua } from './cua-analysis.js';
import { createManagedPatches } from './managed-patches.js';
import type { CheckResult, OperationResult } from './result.js';
import { guide } from './guide.js';

export async function managedCli(args: string[]): Promise<CheckResult | OperationResult | null> {
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
  if (positionals.length > 1 || positionals.length === 1 && !['check', 'install', 'uninstall', 'status', 'apply', 'restore', 'recover'].includes(positionals[0] ?? '')) throw new Error('Expected command: install, check or uninstall.');
  const command = positionals[0];
  const interactive = command !== 'check' && command !== 'status';
  if (interactive && (values.json || !process.stdin.isTTY || !process.stdout.isTTY)) throw new Error('Managed changes and the default guide require interactive stdin/stdout without --json.');
  if (values.app !== undefined && !isAbsolute(values.app)) throw new Error('--app requires an absolute installation path.');
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const executable = Object.keys(metadata.bin)[0];
  if (!executable) throw new Error('Packaged executable metadata is missing.');
  const managed = createManagedPatches({ derive: deriveCua, tool: { packageName: metadata.name, version: metadata.version, executable } });
  const selection = values.app === undefined ? {} : { appPath: values.app };
  if (interactive) { const result = await guide(managed, selection, command); if (result) process.exitCode = result.exitCode; return null; }
  const discovery = await managed.discover(selection);
  const candidate = discovery.selection === 'single' ? discovery.candidates[0] : undefined;
  if (command === 'status') {
    if (candidate) return managed.status(candidate);
    const multiple = discovery.selection === 'required';
    return { schemaVersion: 1, command, outcome: multiple ? 'usage-error' : 'runtime-error', exitCode: multiple ? 2 : 1, diagnostics: [...discovery.diagnostics, { code: multiple ? 'SELECTION_REQUIRED' : 'NO_INSTALLATIONS', severity: 'error', message: multiple ? 'Select one installation with --app.' : 'No CUA installation found; provide --app with its absolute path.' }], data: null };
  }
  const inspections = [];
  for (const installation of discovery.candidates) inspections.push(await managed.inspect(installation));
  const diagnostics = [...discovery.diagnostics, ...inspections.flatMap(inspection => inspection.diagnostics.map(entry => ({ ...entry, installation: inspection.candidate.appPath, path: entry.path ?? inspection.candidate.targetPath })))];
  if (!inspections.length) diagnostics.push({ code: 'NO_INSTALLATIONS', severity: 'error', message: 'No CUA installation found; provide --app with its absolute path.' });
  const discoveryErrors = discovery.diagnostics.filter(entry => entry.severity === 'error');
  const outcome = (!inspections.length && !discoveryErrors.length) || discoveryErrors.some(entry => entry.outcome !== 'conflict') || inspections.some(inspection => inspection.operation?.outcome === 'runtime-error' || inspection.diagnostics.some(entry => entry.outcome === 'runtime-error')) ? 'runtime-error'
    : discoveryErrors.length > 0 || inspections.some(inspection => inspection.state === 'conflict' || inspection.operation?.outcome === 'conflict') ? 'conflict'
      : inspections.some(inspection => inspection.support !== 'supported') ? 'incompatible' : 'success';
  const exitCode = { success: 0, 'runtime-error': 1, incompatible: 3, conflict: 4 }[outcome];
  return { schemaVersion: 1, command: 'check', outcome, exitCode, diagnostics, data: { discovery, inspections, inspection: candidate ? inspections[0] ?? null : null, runtime: 'not-verified' } };
}
