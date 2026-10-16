import { randomBytes, randomUUID } from 'node:crypto';
import { analyzeSource } from './analysis.js';
import { lstat, mkdir, readdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { loadPlan } from './plan.js';
import type { LoadedPlan, TargetIdentity } from './plan.js';
import { EXIT_CODES } from './result.js';
import type { Diagnostic, OperationResult, TargetState, TransactionCommand } from './result.js';
import { blockingProcesses, PROCESS_LIMITATION, processTable } from './processes.js';
import type { ProcessIdentity } from './processes.js';
import { acquireLease, inspectLease, releaseLease, targetLock } from './transaction-locks.js';
import type { LeaseRecord } from './transaction-locks.js';
import { atomicJSON, canonical, canonicalDirectory, check, digest, exists, privateDirectory, readJSON, regularBytes, sign, syncDirectory, TransactionError, verify, writeExclusive } from './transaction-storage.js';

interface Snapshot {
  device: string;
  inode: string;
  mode: number;
  sha256: string;
  size: number;
  parentDevice: string;
  parentInode: string;
}
interface Journal {
  formatVersion: 1;
  id: string;
  store: string;
  operation: 'apply';
  sequence: number;
  planHash: string;
  phase: 'prepared' | 'writing' | 'verifying' | 'committed' | 'rolling-back' | 'rolled-back';
  target: {
    path: string;
    before: Snapshot;
    afterHash: string;
    afterSize: number;
    final: Snapshot | null;
    previous: string | null;
  };
}
interface RecordEntry { directory: string; journal: Journal; plan: LoadedPlan }
interface Store { path: string; key: Buffer }
interface Options { plan?: string; store: string; targets?: string[] }
const terminal = (journal: Journal) => journal.phase === 'committed' || journal.phase === 'rolled-back';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

async function storeAt(path: string, create: boolean): Promise<Store | null> {
  check(resolve(path) === path, 'PATH_ALIAS', 'Operation store must be a normalized absolute path.', path);
  if (!await exists(path)) {
    if (!create) return null;
    await privateDirectory(path);
  }
  await canonicalDirectory(path, true);
  const keyPath = join(path, 'key');
  if (!await exists(keyPath) && create) {
    try { await writeExclusive(keyPath, randomBytes(32)); } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    await syncDirectory(path);
  }
  const key = await regularBytes(keyPath, true);
  check(key.length === 32, 'UNTRUSTED_STORE', 'Invalid operation store key.', keyPath);
  if (create) await privateDirectory(join(path, 'transactions'));
  return { path, key };
}

async function snapshot(path: string): Promise<Snapshot> {
  check(await realpath(path) === path, 'PATH_ALIAS', 'Target and every parent must use canonical paths.', path);
  const before = await lstat(path, { bigint: true });
  check(before.nlink === 1n && before.isFile() && !before.isSymbolicLink(), 'PATH_ALIAS', 'Hardlink and symlink target aliases are refused.', path);
  const parent = await lstat(dirname(path), { bigint: true });
  const bytes = await regularBytes(path);
  const after = await lstat(path, { bigint: true });
  check(before.dev === after.dev && before.ino === after.ino && before.ctimeNs === after.ctimeNs && before.mtimeNs === after.mtimeNs, 'IDENTITY_CHANGED', 'Target changed during preflight.', path);
  return { device: String(before.dev), inode: String(before.ino), mode: Number(before.mode & 0o7777n), sha256: digest(bytes), size: bytes.length, parentDevice: String(parent.dev), parentInode: String(parent.ino) };
}

function same(a: Snapshot, b: Snapshot): boolean { return canonical(a) === canonical(b); }
function parentMatches(a: Snapshot, b: Snapshot): boolean { return a.parentDevice === b.parentDevice && a.parentInode === b.parentInode && a.device === b.device && a.mode === b.mode; }
function matchesPlan(current: Snapshot, identity: TargetIdentity): boolean {
  return current.device === identity.device && current.inode === identity.inode && current.mode === identity.mode;
}

async function processes(): Promise<ProcessIdentity[]> {
  let table: ProcessIdentity[];
  try { table = await processTable(); } catch (error) {
    throw new TransactionError('PROCESS_ENUMERATION_FAILED', `Cannot safely enumerate processes: ${error instanceof Error ? error.message : 'unknown error'}`, 'runtime-error');
  }
  const blockers = blockingProcesses(table);
  if (blockers.length) throw new TransactionError('PROCESSES_RUNNING', `Exit related processes before writing: ${blockers.map((entry) => `PID ${entry.pid} ${entry.executable} ${entry.command}`).join('; ')}`);
  return table;
}

function validateJournal(value: unknown, id: string, store: string): asserts value is Journal {
  check(value !== null && typeof value === 'object', 'INVALID_JOURNAL', 'Missing transaction intent.');
  const item = value as Journal;
  check(item.formatVersion === 1 && item.id === id && uuid.test(id) && item.store === store && item.operation === 'apply' && Number.isSafeInteger(item.sequence) && item.sequence >= 0 && /^[a-f0-9]{64}$/.test(item.planHash) && ['prepared', 'writing', 'verifying', 'committed', 'rolling-back', 'rolled-back'].includes(item.phase), 'INVALID_JOURNAL', 'Invalid transaction intent.');
  check(item.target && typeof item.target.path === 'string' && item.target.before && /^[a-f0-9]{64}$/.test(item.target.afterHash) && Number.isSafeInteger(item.target.afterSize) && (item.target.previous === null || uuid.test(item.target.previous)), 'INVALID_JOURNAL', 'Invalid target transaction intent.');
}

async function recordAt(store: Store, id: string): Promise<RecordEntry> {
  check(uuid.test(id), 'INVALID_JOURNAL', 'Invalid transaction directory.');
  const directory = join(store.path, 'transactions', id);
  await canonicalDirectory(directory, true);
  const value = verify(await readJSON(join(directory, 'journal.json')), store.key);
  validateJournal(value, id, store.path);
  const plan = await loadPlan(join(directory, 'plan'));
  check(plan.manifest.contentHash === value.planHash && plan.targets.length === 1, 'INVALID_JOURNAL', 'Stored plan does not match authenticated transaction.');
  const target = plan.targets[0];
  check(target && target.target.identity.path === value.target.path && target.target.patched.sha256 === value.target.afterHash && target.target.patched.size === value.target.afterSize, 'INVALID_JOURNAL', 'Stored target identity does not match intent.');
  const before = await regularBytes(join(directory, 'before.mjs'), true);
  check(digest(before) === value.target.before.sha256 && before.length === value.target.before.size && (before.equals(target.original) || before.equals(target.patched)), 'BACKUP_CHANGED', 'Operation backup does not match authenticated known state.');
  if (terminal(value)) {
    const final = value.target.final;
    const expectedHash = value.phase === 'committed' ? value.target.afterHash : value.target.before.sha256;
    const expectedSize = value.phase === 'committed' ? value.target.afterSize : value.target.before.size;
    check(final && final.sha256 === expectedHash && final.size === expectedSize && parentMatches(final, value.target.before), 'INVALID_JOURNAL', 'Terminal transaction does not prove its final state.');
  }
  return { directory, journal: value, plan };
}

async function records(store: Store | null): Promise<RecordEntry[]> {
  if (!store || !await exists(join(store.path, 'transactions'))) return [];
  await canonicalDirectory(join(store.path, 'transactions'), true);
  const entries: RecordEntry[] = [];
  for (const id of (await readdir(join(store.path, 'transactions'))).sort()) {
    if (id.startsWith('.staging-')) continue; // Never published; cannot have written a target.
    entries.push(await recordAt(store, id));
  }
  const sequences = new Set<number>();
  const byId = new Map(entries.map((entry) => [entry.journal.id, entry]));
  for (const entry of entries) {
    check(!sequences.has(entry.journal.sequence), 'INVALID_JOURNAL', 'Duplicate transaction sequence.');
    sequences.add(entry.journal.sequence);
    const previous = entry.journal.target.previous;
    if (previous) {
      const prior = byId.get(previous);
      check(prior && terminal(prior.journal) && prior.journal.target.path === entry.journal.target.path && prior.journal.sequence < entry.journal.sequence, 'UNTRUSTED_RECORD', 'Transaction provenance chain is missing or invalid.');
    }
  }
  return entries.sort((a, b) => a.journal.sequence - b.journal.sequence);
}

async function persist(store: Store, entry: RecordEntry): Promise<void> {
  try {
    await atomicJSON(join(entry.directory, 'journal.json'), sign(entry.journal, store.key));
  } catch (error) {
    // The write may have renamed and then failed. Only the persisted journal defines terminal state.
    entry.journal.phase = 'verifying'; // Unreadable persistence must never release a possibly incomplete lease.
    const value = verify(await readJSON(join(entry.directory, 'journal.json')), store.key);
    validateJournal(value, entry.journal.id, store.path);
    entry.journal = value;
    throw new TransactionError('JOURNAL_WRITE_FAILED', `Journal persistence failed; explicit recover may be required: ${error instanceof Error ? error.message : 'unknown error'}`, 'runtime-error');
  }
}

async function copyPlan(plan: LoadedPlan, destination: string): Promise<void> {
  await mkdir(destination, { mode: 0o700 });
  await mkdir(join(destination, 'contents'), { mode: 0o700 });
  for (const file of await readdir(join(plan.directory, 'contents'))) {
    await writeExclusive(join(destination, 'contents', file), await regularBytes(join(plan.directory, 'contents', file)));
  }
  await writeExclusive(join(destination, 'complete.json'), await regularBytes(join(plan.directory, 'complete.json')));
  await syncDirectory(join(destination, 'contents'));
  await syncDirectory(destination);
  const copied = await loadPlan(destination);
  check(copied.manifest.contentHash === plan.manifest.contentHash, 'PLAN_CHANGED', 'Plan changed while copying.');
}

async function createIntent(store: Store, id: string, plan: LoadedPlan, before: Snapshot, previous: string | null, sequence: number): Promise<RecordEntry> {
  const parent = join(store.path, 'transactions');
  const staging = join(parent, `.staging-${id}`);
  const destination = join(parent, id);
  await mkdir(staging, { mode: 0o700 });
  try {
    await copyPlan(plan, join(staging, 'plan'));
    const item = plan.targets[0];
    check(item, 'INVALID_PLAN', 'Plan has no target.');
    const bytes = await regularBytes(item.target.identity.path);
    check(digest(bytes) === before.sha256, 'TARGET_CHANGED', 'Target changed before intent publication.');
    await writeExclusive(join(staging, 'before.mjs'), bytes);
    const journal: Journal = { formatVersion: 1, id, store: store.path, operation: 'apply', sequence, planHash: plan.manifest.contentHash, phase: 'prepared', target: { path: item.target.identity.path, before, afterHash: item.target.patched.sha256, afterSize: item.patched.length, final: null, previous } };
    await writeExclusive(join(staging, 'journal.json'), JSON.stringify(sign(journal, store.key)) + '\n');
    await syncDirectory(staging);
    await rename(staging, destination);
    await syncDirectory(parent);
    return { directory: destination, journal, plan: await loadPlan(join(destination, 'plan')) };
  } finally { await rm(staging, { force: true, recursive: true }); }
}

async function previousTransaction(record: LeaseRecord, own: RecordEntry | null, recovering: boolean): Promise<void> {
  const store = await storeAt(record.store, false);
  check(store, 'INVALID_LOCK', 'Lock references an unavailable operation store.');
  const directory = join(store.path, 'transactions', record.transaction);
  if (!await exists(directory)) {
    // No published intent can only precede all target writes. A stale lease is safe to supersede.
    return;
  }
  const entry = await recordAt(store, record.transaction);
  if (own && entry.journal.id === own.journal.id && recovering) return;
  check(terminal(entry.journal), 'INCOMPLETE_TRANSACTION', `Recover transaction ${entry.journal.id} using --store ${record.store} before ordinary writes.`);
}

async function pendingAtTarget(path: string): Promise<RecordEntry | null> {
  const lease = await inspectLease(targetLock(path));
  if (!lease) return null;
  const store = await storeAt(lease.record.store, false);
  check(store, 'INVALID_LOCK', 'Target lock references an unavailable store.');
  if (!await exists(join(store.path, 'transactions', lease.record.transaction))) return null;
  const entry = await recordAt(store, lease.record.transaction);
  return terminal(entry.journal) ? null : entry;
}

async function classify(plan: LoadedPlan, entries: RecordEntry[]): Promise<{ state: TargetState; snapshot: Snapshot; previous: string | null }> {
  const item = plan.targets[0];
  check(item, 'INVALID_PLAN', 'Plan has no target.');
  const path = item.target.identity.path;
  check(path === item.target.identity.realPath, 'PATH_ALIAS', 'Selected target has a path alias.', path);
  const current = await snapshot(path);
  const history = entries.filter((entry) => entry.journal.target.path === path && terminal(entry.journal));
  const latest = history.at(-1);
  const trusted = latest?.journal.phase === 'committed' ? latest.journal.target.final : latest?.journal.phase === 'rolled-back' ? latest.journal.target.final : null;
  if (current.sha256 === item.target.original.sha256 && current.size === item.original.length && (matchesPlan(current, item.target.identity) || trusted && same(current, trusted))) {
    return { state: 'original', snapshot: current, previous: latest?.journal.id ?? null };
  }
  if (current.sha256 === item.target.patched.sha256 && current.size === item.patched.length && trusted && same(current, trusted) && latest?.journal.planHash === plan.manifest.contentHash) {
    return { state: 'tool-applied', snapshot: current, previous: latest.journal.id };
  }
  throw new TransactionError('TARGET_CONFLICT', 'Target contents or filesystem identity are not a trusted original/tool-applied state.', 'conflict', path);
}

/** The intent is already durable. Check actual bytes after failures, including rename-then-error. */
async function replaceTarget(path: string, bytes: Buffer, expected: Snapshot): Promise<Snapshot> {
  check(same(await snapshot(path), expected), 'TARGET_CHANGED', 'Target changed immediately before replacement.', path);
  const temporary = join(dirname(path), `.codex-browser-patch-${randomUUID()}.tmp`);
  try {
    await writeExclusive(temporary, bytes, expected.mode);
    check(same(await snapshot(path), expected), 'TARGET_CHANGED', 'Target changed while staging replacement.', path);
    await rename(temporary, path);
    await syncDirectory(dirname(path));
    const current = await snapshot(path);
    check(parentMatches(current, expected) && current.sha256 === digest(bytes) && current.size === bytes.length, 'POSTVERIFY_FAILED', 'Target failed post-write verification.', path);
    return current;
  } finally { await rm(temporary, { force: true }); }
}

async function recoverySnapshot(entry: RecordEntry): Promise<Snapshot> {
  const journal = entry.journal;
  const current = await snapshot(journal.target.path);
  const before = journal.target.before;
  check(parentMatches(current, before) && ((current.sha256 === before.sha256 && current.size === before.size) || (current.sha256 === journal.target.afterHash && current.size === journal.target.afterSize)), 'RECOVERY_CONFLICT', 'Unknown current contents or target identity; recovery preserves the target and journal.', journal.target.path);
  return current;
}

async function rollback(store: Store, entry: RecordEntry): Promise<void> {
  const journal = entry.journal;
  const current = await recoverySnapshot(entry);
  const before = journal.target.before;
  journal.phase = 'rolling-back';
  await persist(store, entry);
  await processes();
  let final = current;
  if (current.sha256 !== before.sha256 || current.size !== before.size) final = await replaceTarget(journal.target.path, await regularBytes(join(entry.directory, 'before.mjs'), true), current);
  check(final.sha256 === before.sha256 && final.size === before.size, 'ROLLBACK_FAILED', 'Rollback did not restore preoperation content.');
  journal.target.final = final;
  journal.phase = 'rolled-back';
  await persist(store, entry);
}

function result(command: TransactionCommand, outcome: OperationResult['outcome'], data: OperationResult['data'], diagnostics: Diagnostic[] = []): OperationResult {
  return { schemaVersion: 1, command, outcome, exitCode: outcome === 'success' ? EXIT_CODES.success : outcome === 'conflict' ? EXIT_CODES.conflict : outcome === 'usage-error' ? EXIT_CODES.usageError : outcome === 'incompatible' ? EXIT_CODES.incompatible : EXIT_CODES.runtimeError, data, diagnostics: [...diagnostics, { code: 'PROCESS_CHECK_LIMITATION', severity: 'info', message: PROCESS_LIMITATION }] };
}

function failure(command: TransactionCommand, error: unknown): OperationResult {
  const known = error instanceof TransactionError;
  return result(command, known ? error.kind : 'runtime-error', null, [{ code: known ? error.code : 'OPERATION_FAILED', severity: 'error', message: error instanceof Error ? error.message : 'Operation failed.', ...(known && error.path ? { path: error.path } : {}), ...(error instanceof Error && 'code' in error && !known ? { systemCode: String(error.code) } : {}) }]);
}

export async function apply(options: Options): Promise<OperationResult> {
  try { return await applyTransaction(options); } catch (error) { return failure('apply', error); }
}

async function applyTransaction(options: Options): Promise<OperationResult> {
  let entry: RecordEntry | null = null;
  let store: Store | null = null;
  const leases: { root: string; lease: Awaited<ReturnType<typeof acquireLease>> }[] = [];
  let writing = false;
  try {
    if (process.platform !== 'darwin') throw new TransactionError('UNSUPPORTED_PLATFORM', `Only macOS is supported; received ${process.platform}.`, 'runtime-error');
    const plan = await loadPlan(options.plan ?? '');
    if (plan.targets.length !== 1) throw new TransactionError('MULTI_TARGET_UNSUPPORTED', 'Writing multi-target plans is unavailable until group transactions are supported.', 'usage-error');
    const path = plan.targets[0]?.target.identity.path ?? '';
    await processes();
    const existing = await storeAt(options.store, false);
    const history = await records(existing);
    check(!history.some((record) => !terminal(record.journal)), 'INCOMPLETE_TRANSACTION', 'Operation store contains an incomplete transaction; use recover.');
    check(!await pendingAtTarget(path), 'INCOMPLETE_TRANSACTION', 'Target has an incomplete transaction, possibly in another store; use recover with its store.');
    const classified = await classify(plan, history);
    store = await storeAt(options.store, true);
    check(store, 'UNTRUSTED_STORE', 'Cannot create operation store.');
    const transaction = randomUUID();
    const table = await processes();
    for (const root of [join(store.path, 'operation.lock'), targetLock(path)]) {
      const lease = await acquireLease(root, { store: store.path, transaction, table }, (previous) => previousTransaction(previous, null, false));
      leases.push({ root, lease });
    }
    const currentRecords = await records(store);
    check(!currentRecords.some((record) => !terminal(record.journal)), 'INCOMPLETE_TRANSACTION', 'Another transaction requires recovery.');
    const current = await classify(plan, currentRecords);
    check(same(current.snapshot, classified.snapshot), 'TARGET_CHANGED', 'Target changed while acquiring locks.');
    entry = await createIntent(store, transaction, plan, current.snapshot, current.previous, Math.max(0, ...currentRecords.map((record) => record.journal.sequence)) + 1);
    if (current.state === 'tool-applied') {
      entry.journal.target.final = current.snapshot;
      entry.journal.phase = 'committed';
      await persist(store, entry);
      return result('apply', 'success', { store: store.path, transaction: entry.journal.id, targets: [{ path, state: 'tool-applied', action: 'already-applied' }], runtime: 'not-verified' });
    }
    await processes();
    entry.journal.phase = 'writing';
    await persist(store, entry);
    writing = true;
    const final = await replaceTarget(path, plan.targets[0]!.patched, current.snapshot);
    entry.journal.phase = 'verifying';
    await persist(store, entry);
    check(same(await snapshot(path), final), 'POSTVERIFY_FAILED', 'Target changed before commit.');
    entry.journal.target.final = final;
    entry.journal.phase = 'committed';
    await persist(store, entry);
    writing = false;
    return result('apply', 'success', { store: store.path, transaction: entry.journal.id, targets: [{ path, state: 'tool-applied', action: 'applied' }], runtime: 'not-verified' });
  } catch (error) {
    if (entry && store && !terminal(entry.journal) && !(error instanceof TransactionError && error.code === 'JOURNAL_WRITE_FAILED')) {
      try {
        if (writing) await rollback(store, entry);
        else { entry.journal.phase = 'rolled-back'; entry.journal.target.final = entry.journal.target.before; await persist(store, entry); }
      } catch (rollbackError) {
        return result('apply', 'runtime-error', { store: store.path, transaction: entry.journal.id, targets: [{ path: entry.journal.target.path, state: 'incomplete' }], runtime: 'not-verified' }, [{ code: 'ROLLBACK_FAILED', severity: 'error', message: `${error instanceof Error ? error.message : 'Apply failed.'} Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : 'unknown error'}. Explicit recover is required.` }]);
      }
    }
    return failure('apply', error);
  } finally {
    if (!entry || terminal(entry.journal)) for (const { root, lease } of leases.reverse()) await releaseLease(root, lease);
  }
}

export async function status(options: Options): Promise<OperationResult> {
  try {
    const store = await storeAt(options.store, false);
    const history = await records(store);
    const incomplete = history.filter((entry) => !terminal(entry.journal));
    if (!options.plan) {
      const path = options.targets?.[0];
      if (!path) throw new TransactionError('SELECTION_REQUIRED', 'status requires --plan or --target.', 'usage-error');
      const trusted = history.filter((entry) => entry.journal.target.path === path).at(-1);
      if (trusted) return await status({ store: options.store, plan: join(trusted.directory, 'plan') });
      const current = await snapshot(path);
      const pending = await pendingAtTarget(path);
      if (pending) {
        try {
          await recoverySnapshot(pending);
          return result('status', 'success', { store: options.store, transaction: pending.journal.id, targets: [{ path, state: 'incomplete' }], runtime: 'not-verified' });
        } catch (error) {
          if (!(error instanceof TransactionError)) throw error;
          return result('status', 'conflict', { store: options.store, transaction: pending.journal.id, targets: [{ path, state: 'conflict' }], runtime: 'not-verified' });
        }
      }
      const bytes = await regularBytes(path);
      check(digest(bytes) === current.sha256, 'TARGET_CHANGED', 'Target changed during status.');
      const analysis = analyzeSource(bytes.toString('utf8'));
      const untrusted = analysis.diagnostics.some((entry) => entry.code === 'UNTRUSTED_PATCHED_SHAPE');
      const state = untrusted ? 'conflict' : analysis.compatibility === 'compatible' ? 'original' : 'incompatible';
      return result('status', untrusted ? 'conflict' : state === 'incompatible' ? 'incompatible' : 'success', { store: options.store, transaction: null, targets: [{ path, state }], runtime: 'not-verified' }, analysis.diagnostics.map((entry) => ({ ...entry, path })));
    }
    const plan = await loadPlan(options.plan);
    const targets: NonNullable<OperationResult['data']>['targets'] = [];
    for (const item of plan.targets) {
      const path = item.target.identity.path;
      const pending = incomplete.find((entry) => entry.journal.target.path === path) ?? await pendingAtTarget(path);
      if (pending) {
        try { await recoverySnapshot(pending); targets.push({ path, state: 'incomplete' }); }
        catch (error) { if (!(error instanceof TransactionError)) throw error; targets.push({ path, state: 'conflict' }); }
      } else {
        try { targets.push({ path, state: (await classify({ ...plan, targets: [item] }, history)).state }); } catch (error) {
          if (!(error instanceof TransactionError)) throw error;
          targets.push({ path, state: 'conflict' });
        }
      }
    }
    const conflict = targets.some((target) => target.state === 'conflict');
    return result('status', conflict ? 'conflict' : 'success', { store: options.store, transaction: incomplete[0]?.journal.id ?? null, targets, runtime: 'not-verified' });
  } catch (error) { return failure('status', error); }
}

export async function recover(options: Options): Promise<OperationResult> {
  try { return await recoverTransaction(options); } catch (error) { return failure('recover', error); }
}

async function recoverTransaction(options: Options): Promise<OperationResult> {
  const leases: { root: string; lease: Awaited<ReturnType<typeof acquireLease>> }[] = [];
  let entry: RecordEntry | null = null;
  try {
    if (process.platform !== 'darwin') throw new TransactionError('UNSUPPORTED_PLATFORM', `Only macOS is supported; received ${process.platform}.`, 'runtime-error');
    const store = await storeAt(options.store, false);
    check(store, 'STORE_NOT_FOUND', 'No operation store exists for recovery.');
    const history = await records(store);
    const pending = history.filter((record) => !terminal(record.journal));
    check(pending.length <= 1, 'AMBIGUOUS_TRANSACTION', 'Store contains multiple incomplete transactions; refusing to guess.');
    entry = pending[0] ?? null;
    if (!entry) return result('recover', 'success', { store: store.path, transaction: null, targets: [], runtime: 'not-verified' }, [{ code: 'NO_INCOMPLETE_TRANSACTION', severity: 'info', message: 'No incomplete transaction; nothing to roll back.' }]);
    const table = await processes();
    for (const root of [join(store.path, 'operation.lock'), targetLock(entry.journal.target.path)]) {
      const lease = await acquireLease(root, { store: store.path, transaction: entry.journal.id, table }, (previous) => previousTransaction(previous, entry, true));
      leases.push({ root, lease });
    }
    await rollback(store, entry);
    const original = entry.plan.targets[0]?.target.original.sha256 === entry.journal.target.before.sha256;
    return result('recover', 'success', { store: store.path, transaction: entry.journal.id, targets: [{ path: entry.journal.target.path, state: original ? 'original' : 'tool-applied', action: 'rolled-back' }], runtime: 'not-verified' });
  } catch (error) { return failure('recover', error); } finally {
    if (entry && terminal(entry.journal)) for (const { root, lease } of leases.reverse()) await releaseLease(root, lease);
  }
}
