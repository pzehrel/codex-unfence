import { constants } from 'node:fs';
import { access, lstat, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { CuaDerivation, DeriveCua } from './cua-contract.js';
import { canonical, digest } from './integrity.js';
import { discoverInstallations, installationAt } from './installations.js';
import type { Candidate } from './installations.js';
import { processTable } from './processes.js';
import type { Diagnostic, OperationResult, TargetState, TransactionCommand } from './result.js';
import { EXIT_CODES } from './result.js';
import { check, exists, regularBytes, TransactionError } from './transaction-storage.js';
import { cuaBlockingProcesses, cuaExecutor } from './cua-admission.js';
import { managedPaths, managedRecord, prepareManaged } from './managed-state.js';
import type { PreparationExpectation, ToolIdentity } from './managed-state.js';
export type { Candidate, DiscoveryReport } from './installations.js';
export type { ToolIdentity } from './managed-state.js';
export interface Inspection {
  candidate: Candidate;
  support: CuaDerivation['support'];
  state: TargetState;
  derivation: CuaDerivation | null;
  source: { sha256: string; size: number } | null;
  writeReadiness: 'ready' | 'blocked' | 'unknown';
  blockers: Diagnostic[];
  allowedActions: ('apply' | 'restore' | 'recover')[];
  diagnostics: Diagnostic[];
  inspectionToken: string | null;
  runtime: 'not-verified';
  operation: OperationResult | null;
  recovery: { tool: ToolIdentity; command: string; store: string; preparation: string } | null;
}
export interface ConfirmedSelection { candidate: Candidate; inspectionToken: string; confirmed: true }

function diagnostic(error: unknown): Diagnostic {
  return { code: error instanceof TransactionError ? error.code : 'INSPECTION_FAILED', severity: 'error', message: error instanceof Error ? error.message : 'Cannot inspect target.' };
}

/** One public business boundary for discovery, read-only inspection and managed transactions. */
export function createManagedPatches({ derive, tool }: { derive: DeriveCua; tool: ToolIdentity }) {
  const executor = cuaExecutor(derive);
  const inspectedSources = new WeakMap<Inspection, { bytes: Buffer; identity: PreparationExpectation }>();
  const inspectedLocators = new WeakMap<Inspection, string | null>();
  async function status(candidate: Candidate): Promise<OperationResult> {
    try {
      const actual = await installationAt(candidate.appPath);
      check(actual.targetPath === candidate.targetPath, 'TARGET_CHANGED', 'Candidate target does not match its installation.');
      const record = await managedRecord(actual.targetPath, derive);
      return executor.status({ store: record?.locator.store ?? managedPaths(actual.targetPath).absentStore, targets: [actual.targetPath] });
    } catch (error) { return failed('status', error); }
  }
  async function inspect(candidate: Candidate): Promise<Inspection> {
    const diagnostics: Diagnostic[] = [];
    const blockers: Diagnostic[] = [];
    let derivation: CuaDerivation | null = null;
    let source: Inspection['source'] = null;
    let inspectionToken: string | null = null;
    let state: TargetState = 'incompatible';
    let operation: OperationResult | null = null;
    let recovery: Inspection['recovery'] = null;
    let snapshot: { bytes: Buffer; identity: PreparationExpectation } | null = null;
    let locatorContent: string | null = null;
    if (process.platform !== 'darwin') blockers.push({ code: 'UNSUPPORTED_PLATFORM', severity: 'error', message: `Only macOS is supported; received ${process.platform}.` });
    if (Number(process.versions.node.split('.')[0]) < 22 || Number(process.versions.node.split('.')[0]) === 22 && Number(process.versions.node.split('.')[1]) < 13) blockers.push({ code: 'UNSUPPORTED_RUNTIME', severity: 'error', message: 'Node.js >=22.13.0 is required.' });
    try {
      const actual = await installationAt(candidate.appPath);
      check(actual.targetPath === candidate.targetPath, 'TARGET_CHANGED', 'Candidate target does not match its installation.');
      const before = await lstat(actual.targetPath, { bigint: true });
      const bytes = await regularBytes(actual.targetPath);
      const after = await lstat(actual.targetPath, { bigint: true });
      check(before.dev === after.dev && before.ino === after.ino && before.ctimeNs === after.ctimeNs && before.mtimeNs === after.mtimeNs, 'TARGET_CHANGED', 'Target changed during inspection.');
      const text = bytes.toString('utf8');
      check(Buffer.from(text).equals(bytes), 'INVALID_SOURCE', 'Target must be lossless UTF-8.');
      source = { sha256: digest(bytes), size: bytes.length };
      snapshot = { bytes, identity: { device: String(before.dev), inode: String(before.ino), mode: Number(before.mode & 0o7777n), ctime: String(before.ctimeNs), mtime: String(before.mtimeNs) } };
      const record = await managedRecord(actual.targetPath, derive);
      locatorContent = record ? canonical(record.locator) : null;
      // An authenticated stored plan supplies the original when the actual target is patched.
      derivation = record?.plan.derivation ?? derive(text);
      diagnostics.push(...derivation.diagnostics);
      if (!record && derivation.support === 'unsupported') diagnostics.push({ code: 'UNVERIFIED_SOURCE', severity: 'warning', message: 'No trusted managed origin exists; original tool version is unknown. If this is a historical patch, use its original entrypoint, preparation and operation store to restore. Similar wrapper bytes never prove tool provenance.' });
      operation = await status(actual);
      diagnostics.push(...operation.diagnostics.filter((entry) => entry.code !== 'PROCESS_CHECK_LIMITATION'));
      state = operation.data?.targets[0]?.state ?? 'conflict';
      if (record) recovery = { tool: record.locator.tool, command: record.locator.recovery, store: record.locator.store, preparation: record.locator.preparation };
      inspectionToken = digest(canonical({ target: actual.targetPath, device: String(before.dev), inode: String(before.ino), mode: String(before.mode), ctime: String(before.ctimeNs), mtime: String(before.mtimeNs), source, derivation, tool, locator: record?.locator ?? null, state, pending: operation.data?.pendingTransactions ?? [] }));
      candidate = actual;
      try { await access(dirname(actual.targetPath), constants.W_OK | constants.X_OK); }
      catch { blockers.push({ code: 'TARGET_NOT_WRITABLE', severity: 'error', message: 'Target directory must permit atomic replacement without elevation.', path: dirname(actual.targetPath) }); }
      const paths = managedPaths(actual.targetPath);
      const writable: string[] = [];
      // Check each existing parent that must publish state; missing descendants use the nearest parent.
      for (const path of [paths.root, dirname(paths.root), dirname(dirname(paths.root)), paths.home, join(paths.root, 'preparations'), join(paths.root, 'targets'), join(paths.root, 'stores')]) {
        if (await exists(path)) writable.push(path);
      }
      if (record && await exists(record.locator.store)) {
        writable.push(record.locator.store);
        const transactions = join(record.locator.store, 'transactions');
        if (await exists(transactions)) {
          writable.push(transactions);
          for (const name of await readdir(transactions)) {
            if (!name.startsWith('.staging-')) writable.push(join(transactions, name));
          }
        }
      }
      for (const path of writable) {
        try { await access(path, constants.W_OK | constants.X_OK); }
        catch { blockers.push({ code: 'STORE_NOT_WRITABLE', severity: 'error', message: 'Managed recovery state must permit transaction publication without elevation.', path }); }
      }
    } catch (error) {
      const entry = diagnostic(error);
      diagnostics.push(entry);
      blockers.push(entry);
      state = 'conflict';
    }
    if (state === 'conflict' || state === 'incomplete') blockers.push({ code: state === 'incomplete' ? 'INCOMPLETE_TRANSACTION' : 'TARGET_CONFLICT', severity: 'error', message: state === 'incomplete' ? 'Recover the incomplete transaction before ordinary writes.' : 'Target or recovery state is not trusted for writing.' });
    try {
      const running = cuaBlockingProcesses(await processTable());
      if (running.length) blockers.push({ code: 'PROCESSES_RUNNING', severity: 'error', message: `Exit related processes before writing: ${running.map((entry) => `PID ${entry.pid} ${entry.executable}`).join('; ')}` });
    } catch (error) { blockers.push({ code: 'PROCESS_ENUMERATION_FAILED', severity: 'error', message: error instanceof Error ? error.message : 'Cannot safely enumerate processes.' }); }
    const actionBlocked = blockers.some((entry) => entry.code !== 'INCOMPLETE_TRANSACTION');
    const allowedActions: Inspection['allowedActions'] = actionBlocked || !inspectionToken ? [] : state === 'incomplete' && recovery ? ['recover'] : derivation?.support === 'supported' && state === 'original' ? ['apply', ...(recovery ? ['restore' as const] : [])] : state === 'tool-applied' && recovery ? ['apply', 'restore'] : [];
    const inspection: Inspection = { candidate, support: derivation?.support ?? 'unsupported', state, derivation, source, writeReadiness: blockers.some((entry) => entry.code === 'PROCESS_ENUMERATION_FAILED') ? 'unknown' : blockers.length ? 'blocked' : 'ready', blockers, allowedActions, diagnostics, inspectionToken, operation, recovery, runtime: 'not-verified' };
    if (snapshot) inspectedSources.set(inspection, snapshot);
    inspectedLocators.set(inspection, locatorContent);
    return inspection;
  }
  async function change(command: 'apply' | 'restore' | 'recover', selection: ConfirmedSelection): Promise<OperationResult> {
    try {
      if (selection.confirmed !== true) throw new TransactionError('CONFIRMATION_REQUIRED', 'Explicit confirmation of the inspected target is required.', 'usage-error');
      const current = await inspect(selection.candidate);
      check(typeof selection.inspectionToken === 'string' && current.inspectionToken === selection.inspectionToken, 'INSPECTION_CHANGED', 'Target, preparation or trusted state changed after inspection; inspect and confirm again.');
      const blocking = current.blockers.filter((entry) => !(command === 'recover' && current.allowedActions.includes('recover') && entry.code === 'INCOMPLETE_TRANSACTION'));
      if (blocking.length) {
        const blocker = blocking[0];
        throw new TransactionError(blocker?.code ?? 'WRITE_BLOCKED', blocker?.message ?? 'Writing is blocked.', current.writeReadiness === 'unknown' ? 'runtime-error' : 'conflict');
      }
      let record = await managedRecord(current.candidate.targetPath, derive);
      check(inspectedLocators.get(current) === (record ? canonical(record.locator) : null), 'INSPECTION_CHANGED', 'Managed selection changed after confirmation; inspect and confirm again.');
      if (command === 'recover') {
        check(record, 'RESTORE_SOURCE_REQUIRED', 'No managed recovery record. Use the original tool entrypoint and operation store for historical preparations.');
        return executor.recover({ store: record.locator.store });
      }
      check(current.state !== 'conflict' && current.state !== 'incomplete', current.state === 'incomplete' ? 'INCOMPLETE_TRANSACTION' : 'TARGET_CONFLICT', current.state === 'incomplete' ? 'An incomplete transaction requires recover; recovery rolls back rather than continuing.' : 'Current target is not a trusted original or tool-applied state.');
      if (!record) {
        check(command === 'apply' && current.support === 'supported', 'RESTORE_SOURCE_REQUIRED', 'No trusted managed preparation. Unknown or historical patches require their original tool version and entrypoint.');
        const snapshot = inspectedSources.get(current);
        check(snapshot, 'INSPECTION_CHANGED', 'Cannot establish the confirmed source snapshot.');
        record = await prepareManaged(current.candidate, snapshot.bytes, snapshot.identity, derive, tool);
      }
      return executor[command]({ plan: record.locator.preparation, store: record.locator.store });
    } catch (error) { return failed(command, error); }
  }
  return { discover: discoverInstallations, inspect, status, apply: (selection: ConfirmedSelection) => change('apply', selection), restore: (selection: ConfirmedSelection) => change('restore', selection), recover: (selection: ConfirmedSelection) => change('recover', selection) };
}

function failed(command: TransactionCommand, error: unknown): OperationResult {
  const outcome = error instanceof TransactionError ? error.kind : 'runtime-error';
  return { schemaVersion: 1, command, outcome, exitCode: outcome === 'conflict' ? EXIT_CODES.conflict : outcome === 'usage-error' ? EXIT_CODES.usageError : EXIT_CODES.runtimeError, data: null, diagnostics: [diagnostic(error)] };
}
