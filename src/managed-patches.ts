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
import { detectCuaPatch } from './cua-patch-detection.js';
import type { DetectedCuaPatch } from './cua-patch-detection.js';
import { managedPaths, managedRecord, prepareManaged } from './managed-state.js';
import { externalTargetLock } from './transaction-locks.js';
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
  sourcePatch?: { status: 'detected' | 'not-detected'; recipeVersion: 2 | null; range: DetectedCuaPatch['range'] | null };
}
export interface ConfirmedSelection { candidate: Candidate; inspectionToken: string; confirmed: true }

function diagnostic(error: unknown): Diagnostic {
  return {
    code: error instanceof TransactionError ? error.code : 'INSPECTION_FAILED', severity: 'error',
    outcome: error instanceof TransactionError ? error.kind : 'runtime-error',
    message: error instanceof Error ? error.message : 'Cannot inspect target.',
    ...(error instanceof Error && 'path' in error && typeof error.path === 'string' ? { path: error.path } : {}),
    ...(error instanceof Error && 'code' in error && !(error instanceof TransactionError) ? { systemCode: String(error.code) } : {}),
  };
}

/** One public business boundary for discovery, read-only inspection and managed transactions. */
export function createManagedPatches({ derive, tool }: { derive: DeriveCua; tool: ToolIdentity }) {
  function operation() {
    let previousSource: string | undefined;
    let previousResult: CuaDerivation | undefined;
    const reuse: DeriveCua = source => {
      // Reuse only pure analysis of identical bytes within this operation.
      // State loaders still reread and authenticate every file on every call.
      if (source !== previousSource || !previousResult) {
        previousResult = derive(source);
        previousSource = source;
      }
      return structuredClone(previousResult);
    };
    return managedOperations({ derive: reuse, tool });
  }
  return {
    discover: discoverInstallations,
    inspect: (candidate: Candidate) => operation().inspect(candidate),
    status: (candidate: Candidate) => operation().status(candidate),
    apply: (selection: ConfirmedSelection) => operation().apply(selection),
    restore: (selection: ConfirmedSelection) => operation().restore(selection),
    recover: (selection: ConfirmedSelection) => operation().recover(selection),
  };
}

function managedOperations({ derive, tool }: { derive: DeriveCua; tool: ToolIdentity }) {
  const executor = cuaExecutor(derive);
  const inspectedSources = new WeakMap<Inspection, { bytes: Buffer; identity: PreparationExpectation }>();
  const inspectedLocators = new WeakMap<Inspection, string | null>();
  const updatedInstallations = new WeakSet<Inspection>();
  function updatedSource(candidate: Candidate, record: NonNullable<Awaited<ReturnType<typeof managedRecord>>>, operation: OperationResult, bytes: Buffer): CuaDerivation | null {
    const previous = record.plan.manifest.candidate;
    const changedVersion = (['version', 'build'] as const).some(key => previous[key] !== null && candidate[key] !== null && previous[key] !== candidate[key]);
    if (!changedVersion || !operation.diagnostics.some(entry => entry.code === 'TARGET_REPLACED') || bytes.equals(record.plan.targets[0]!.patched) || operation.outcome !== 'conflict' || operation.data?.pendingTransactions?.length !== 0 || operation.data.targets[0]?.state !== 'conflict' || !operation.diagnostics.some(entry => entry.code === 'TARGET_CONFLICT') || operation.diagnostics.some(entry => !['TARGET_CONFLICT', 'TARGET_REPLACED', 'PROCESS_CHECK_LIMITATION'].includes(entry.code))) return null;
    if (!Buffer.from(bytes.toString('utf8')).equals(bytes)) return null;
    return derive(bytes.toString('utf8'));
  }
  function updatedStatus(operation: OperationResult, candidate: Candidate, derivation: CuaDerivation): OperationResult {
    const state = derivation.support === 'supported' ? 'original' : 'incompatible';
    return { ...operation, outcome: state === 'original' ? 'success' : 'incompatible', exitCode: state === 'original' ? EXIT_CODES.success : EXIT_CODES.incompatible, data: { ...operation.data!, targets: [{ path: candidate.targetPath, state }], groupState: state === 'original' ? 'complete' : 'incompatible' }, diagnostics: [...derivation.diagnostics, { code: 'INSTALLATION_REPLACED', severity: 'info', message: 'Installation information and target identity changed. The current file was checked independently; previous backups will not be restored to it.', path: candidate.targetPath }] };
  }
  async function status(candidate: Candidate): Promise<OperationResult> {
    try {
      const actual = await installationAt(candidate.appPath);
      check(actual.targetPath === candidate.targetPath, 'TARGET_CHANGED', 'Candidate target does not match its installation.');
      const record = await managedRecord(actual.targetPath, derive);
      const operation = await executor.status({ ...(record ? { plan: record.locator.preparation } : {}), store: record?.locator.store ?? managedPaths(actual.targetPath).absentStore, targets: [actual.targetPath] });
      if (!record) return operation;
      const before = await lstat(actual.targetPath, { bigint: true });
      const parent = await lstat(dirname(actual.targetPath), { bigint: true });
      const bytes = await regularBytes(actual.targetPath);
      const after = await lstat(actual.targetPath, { bigint: true });
      check(before.dev === after.dev && before.ino === after.ino && before.ctimeNs === after.ctimeNs && before.mtimeNs === after.mtimeNs, 'TARGET_CHANGED', 'Target changed during inspection.');
      const currentParent = await lstat(dirname(actual.targetPath), { bigint: true });
      check(parent.dev === currentParent.dev && parent.ino === currentParent.ino, 'TARGET_CHANGED', 'Target parent changed during inspection.');
      const derivation = updatedSource(actual, record, operation, bytes);
      return derivation ? updatedStatus(operation, actual, derivation) : operation;
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
    let replaced = false;
    let sourcePatch: Inspection['sourcePatch'];
    if (process.platform !== 'darwin') blockers.push({ code: 'UNSUPPORTED_PLATFORM', severity: 'error', message: `Only macOS is supported; received ${process.platform}.` });
    if (Number(process.versions.node.split('.')[0]) < 22 || Number(process.versions.node.split('.')[0]) === 22 && Number(process.versions.node.split('.')[1]) < 13) blockers.push({ code: 'UNSUPPORTED_RUNTIME', severity: 'error', message: 'Node.js >=22.13.0 is required.' });
    try {
      const actual = await installationAt(candidate.appPath);
      check(actual.targetPath === candidate.targetPath, 'TARGET_CHANGED', 'Candidate target does not match its installation.');
      const before = await lstat(actual.targetPath, { bigint: true });
      const parent = await lstat(dirname(actual.targetPath), { bigint: true });
      const bytes = await regularBytes(actual.targetPath);
      const after = await lstat(actual.targetPath, { bigint: true });
      check(before.dev === after.dev && before.ino === after.ino && before.ctimeNs === after.ctimeNs && before.mtimeNs === after.mtimeNs, 'TARGET_CHANGED', 'Target changed during inspection.');
      const text = bytes.toString('utf8');
      check(Buffer.from(text).equals(bytes), 'INVALID_SOURCE', 'Target must be lossless UTF-8.');
      source = { sha256: digest(bytes), size: bytes.length };
      const detected = detectCuaPatch(text);
      sourcePatch = { status: detected ? 'detected' : 'not-detected', recipeVersion: detected?.recipeVersion ?? null, range: detected?.range ?? null };
      if (detected) diagnostics.push({ code: 'PATCH_DETECTED', severity: 'info', message: 'The complete known patch is present at the site-status JSON result. Recovery records are verified separately.', range: detected.range });
      snapshot = { bytes, identity: { device: String(before.dev), inode: String(before.ino), mode: Number(before.mode & 0o7777n), ctime: String(before.ctimeNs), mtime: String(before.mtimeNs), parentDevice: String(parent.dev), parentInode: String(parent.ino) } };
      let record: Awaited<ReturnType<typeof managedRecord>>;
      try { record = await managedRecord(actual.targetPath, derive); }
      catch (error) {
        derivation = detected?.derivation ?? derive(text);
        diagnostics.push(...derivation.diagnostics);
        throw error;
      }
      locatorContent = record ? canonical(record.locator) : null;
      // An authenticated stored plan supplies the original when the actual target is patched.
      derivation = record?.plan.derivation ?? detected?.derivation ?? derive(text);
      diagnostics.push(...derivation.diagnostics);
      if (!record && derivation.support === 'unsupported') diagnostics.push({ code: 'UNVERIFIED_SOURCE', severity: 'warning', message: 'No trusted managed origin exists. Unsupported or modified contents cannot be adopted or restored. Similar wrapper bytes never prove tool provenance.' });
      operation = await executor.status({ ...(record ? { plan: record.locator.preparation } : {}), store: record?.locator.store ?? managedPaths(actual.targetPath).absentStore, targets: [actual.targetPath] });
      const replacement = record ? updatedSource(actual, record, operation, bytes) : null;
      if (replacement) {
        derivation = replacement;
        diagnostics.length = 0;
        diagnostics.push(...derivation.diagnostics);
        operation = updatedStatus(operation, actual, derivation);
      }
      diagnostics.push(...operation.diagnostics.filter(entry => entry.code !== 'PROCESS_CHECK_LIMITATION' && !diagnostics.some(existing => existing.code === entry.code && existing.message === entry.message && canonical(existing.range ?? null) === canonical(entry.range ?? null))));
      state = operation.data?.targets[0]?.state ?? 'conflict';
      if (record && !replacement) recovery = { tool: record.locator.tool, command: record.locator.recovery, store: record.locator.store, preparation: record.locator.preparation };
      inspectionToken = digest(canonical({ candidate: actual, replacement: replacement !== null, parentDevice: String(parent.dev), parentInode: String(parent.ino), target: actual.targetPath, device: String(before.dev), inode: String(before.ino), mode: String(before.mode), ctime: String(before.ctimeNs), mtime: String(before.mtimeNs), source, derivation, tool, locator: record?.locator ?? null, state, pending: operation.data?.pendingTransactions ?? [] }));
      candidate = actual;
      replaced = replacement !== null;
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
      // Use the writer's account-scoped namespace, inspecting existing parents only.
      const leaseDirectory = dirname(await externalTargetLock(actual.targetPath));
      for (const path of [dirname(dirname(leaseDirectory)), dirname(leaseDirectory), leaseDirectory]) {
        if (!await exists(path)) break;
        try { await access(path, constants.W_OK | constants.X_OK); }
        catch {
          const entry: Diagnostic = { code: 'COORDINATION_NOT_WRITABLE', severity: 'error', message: 'Target coordination directory must permit lease and replacement publication without elevation.', path };
          blockers.push(entry);
          diagnostics.push(entry);
        }
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
      if (running.length) diagnostics.push({ code: 'PROCESSES_RUNNING', severity: 'warning', message: `Related processes are running: ${running.map((entry) => `PID ${entry.pid} ${entry.executable}`).join('; ')}` });
    } catch (error) {
      const entry: Diagnostic = { code: 'PROCESS_ENUMERATION_FAILED', severity: 'error', outcome: 'runtime-error', message: `Cannot safely enumerate processes; process identities are required for concurrency locks: ${error instanceof Error ? error.message : 'unknown error'}` };
      blockers.push(entry);
      diagnostics.push(entry);
    }
    const actionBlocked = blockers.some((entry) => entry.code !== 'INCOMPLETE_TRANSACTION');
    const allowedActions: Inspection['allowedActions'] = actionBlocked || !inspectionToken ? [] : state === 'incomplete' && recovery ? ['recover'] : state === 'original' || state === 'tool-applied' && recovery ? [...(derivation?.support === 'supported' ? ['apply' as const] : []), ...(recovery ? ['restore' as const] : [])] : [];
    const inspection: Inspection = { candidate, support: derivation?.support ?? 'unsupported', state, derivation, source, writeReadiness: blockers.some((entry) => entry.code === 'PROCESS_ENUMERATION_FAILED') ? 'unknown' : blockers.length ? 'blocked' : 'ready', blockers, allowedActions, diagnostics, inspectionToken, operation, recovery, ...(sourcePatch ? { sourcePatch } : {}), runtime: 'not-verified' };
    if (snapshot) inspectedSources.set(inspection, snapshot);
    inspectedLocators.set(inspection, locatorContent);
    if (replaced) updatedInstallations.add(inspection);
    return inspection;
  }
  async function change(command: 'apply' | 'restore' | 'recover', selection: ConfirmedSelection): Promise<OperationResult> {
    try {
      if (selection.confirmed !== true) throw new TransactionError('CONFIRMATION_REQUIRED', 'Explicit confirmation of the inspected target is required.', 'usage-error');
      const current = await inspect(selection.candidate);
      check(typeof selection.inspectionToken === 'string' && current.inspectionToken === selection.inspectionToken, 'INSPECTION_CHANGED', 'Target, preparation or trusted state changed after inspection; inspect and confirm again.');
      const blocking = current.blockers.filter((entry) => !(command === 'recover' && entry.code === 'INCOMPLETE_TRANSACTION'));
      if (blocking.length) {
        const blocker = blocking[0];
        throw new TransactionError(blocker?.code ?? 'WRITE_BLOCKED', blocker?.message ?? 'Writing is blocked.', current.writeReadiness === 'unknown' ? 'runtime-error' : 'conflict');
      }
      let record = await managedRecord(current.candidate.targetPath, derive);
      check(inspectedLocators.get(current) === (record ? canonical(record.locator) : null), 'INSPECTION_CHANGED', 'Managed selection changed after confirmation; inspect and confirm again.');
      if (command === 'recover') {
        check(record, 'RESTORE_SOURCE_REQUIRED', 'No trusted managed recovery record exists for this installation.');
        const result = await executor.recover({ store: record.locator.store });
        return { ...result, diagnostics: [...result.diagnostics, ...current.diagnostics.filter(entry => entry.code === 'PROCESSES_RUNNING' && !result.diagnostics.some(existing => existing.code === entry.code))] };
      }
      check(current.state !== 'conflict' && current.state !== 'incomplete', current.state === 'incomplete' ? 'INCOMPLETE_TRANSACTION' : 'TARGET_CONFLICT', current.state === 'incomplete' ? 'An incomplete transaction requires recover; recovery rolls back rather than continuing.' : 'Current target is not a trusted original or tool-applied state.');
      if (command === 'apply') check(current.support === 'supported', 'UNSUPPORTED_SOURCE', 'Source is not supported by the CUA structural recipe.');
      if (record && updatedInstallations.has(current)) {
        const previous = record;
        const replacement = await executor.select({ store: previous.locator.store, targets: [current.candidate.targetPath] }, async () => {
          const locked = await inspect(current.candidate);
          check(locked.inspectionToken === current.inspectionToken && updatedInstallations.has(locked), 'INSPECTION_CHANGED', 'Replacement installation changed while acquiring locks.');
          if (command === 'restore') return null;
          check(current.support === 'supported', 'UNSUPPORTED_SOURCE', 'Replacement source is not supported.');
          const snapshot = inspectedSources.get(current);
          check(snapshot, 'INSPECTION_CHANGED', 'Cannot establish the confirmed replacement snapshot.');
          return prepareManaged(current.candidate, snapshot.bytes, snapshot.identity, derive, tool, previous.locator);
        });
        if (!replacement) {
          check(current.state === 'original' && current.support === 'supported', 'RESTORE_SOURCE_REQUIRED', 'The replacement source is not supported.');
          return { schemaVersion: 1, command, outcome: 'success', exitCode: EXIT_CODES.success, diagnostics: current.diagnostics, data: { store: previous.locator.store, transaction: null, operation: null, targets: [{ path: current.candidate.targetPath, state: 'original', action: 'already-original' }], runtime: 'not-verified' } };
        }
        record = replacement;
      }
      if (!record) {
        check(command === 'apply' && current.support === 'supported', 'RESTORE_SOURCE_REQUIRED', 'No trusted managed preparation. Unknown modifications cannot be restored.');
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
