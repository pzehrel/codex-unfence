import { randomBytes, randomUUID } from 'node:crypto';
import { analyzeSource } from './analysis.js';
import { lstat, mkdir, readdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { loadPlan } from './plan.js';
import type { LoadedPlan, TargetIdentity } from './plan.js';
import { EXIT_CODES } from './result.js';
import type { Diagnostic, OperationResult, OperationTarget, PendingTransaction, TargetState, TransactionCommand } from './result.js';
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
type Operation = 'apply' | 'restore';
interface JournalTarget {
  path: string;
  before: Snapshot;
  afterHash: string;
  afterSize: number;
  final: Snapshot | null;
  previous: string | null;
}
interface Journal {
  formatVersion: 2;
  id: string;
  store: string;
  operation: Operation;
  sequence: number;
  planHash: string;
  phase: 'prepared' | 'writing' | 'verifying' | 'committed' | 'rolling-back' | 'rolled-back';
  targets: JournalTarget[];
}
type LegacyJournal = Omit<Journal, 'formatVersion' | 'targets'> & { formatVersion: 1; target: JournalTarget };
interface RecordEntry { directory: string; journal: Journal; plan: LoadedPlan; legacy: boolean }
type PlanItem = LoadedPlan['targets'][number];
interface Classified { state: TargetState; snapshot: Snapshot; previous: string | null }
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

function validSnapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== 'object') return false;
  const item = value as Snapshot;
  return [item.device, item.inode, item.parentDevice, item.parentInode].every((value) => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) && Number.isSafeInteger(item.mode) && item.mode >= 0 && item.mode <= 0o7777 && typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/.test(item.sha256) && Number.isSafeInteger(item.size) && item.size >= 0;
}

/** Authenticate the original representation before normalizing v1 in memory. */
function normalizeJournal(value: unknown, id: string, store: string): { journal: Journal; legacy: boolean } {
  check(value !== null && typeof value === 'object', 'INVALID_JOURNAL', 'Missing transaction intent.');
  const item = value as Journal | LegacyJournal;
  check((item.formatVersion === 1 || item.formatVersion === 2) && item.id === id && uuid.test(id) && item.store === store && (item.operation === 'apply' || item.operation === 'restore') && Number.isSafeInteger(item.sequence) && item.sequence >= 0 && /^[a-f0-9]{64}$/.test(item.planHash) && ['prepared', 'writing', 'verifying', 'committed', 'rolling-back', 'rolled-back'].includes(item.phase), 'INVALID_JOURNAL', 'Invalid transaction intent.');
  const targets = item.formatVersion === 1 ? [item.target] : item.targets;
  check(Array.isArray(targets) && targets.length > 0, 'INVALID_JOURNAL', 'Missing target transaction intents.');
  const paths = new Set<string>();
  for (const target of targets) {
    check(target && typeof target.path === 'string' && resolve(target.path) === target.path && !paths.has(target.path) && validSnapshot(target.before) && typeof target.afterHash === 'string' && /^[a-f0-9]{64}$/.test(target.afterHash) && Number.isSafeInteger(target.afterSize) && target.afterSize >= 0 && (target.previous === null || uuid.test(target.previous)) && (target.final === null || validSnapshot(target.final)), 'INVALID_JOURNAL', 'Invalid target transaction intent.');
    paths.add(target.path);
  }
  if (item.formatVersion === 2) return { journal: item, legacy: false };
  const { target, ...base } = item;
  return { journal: { ...base, formatVersion: 2, targets: [target] }, legacy: true };
}

function backupName(count: number, index: number): string {
  return count === 1 ? 'before.mjs' : `before.${String(index).padStart(4, '0')}.mjs`;
}

async function backupBytes(entry: Pick<RecordEntry, 'directory' | 'journal'>, index: number): Promise<Buffer> {
  const before = entry.journal.targets[index]!.before;
  const bytes = await regularBytes(join(entry.directory, backupName(entry.journal.targets.length, index)), true);
  check(digest(bytes) === before.sha256 && bytes.length === before.size, 'BACKUP_CHANGED', 'Operation backup does not match authenticated preoperation state.');
  return bytes;
}

async function recordAt(store: Store, id: string): Promise<RecordEntry> {
  check(uuid.test(id), 'INVALID_JOURNAL', 'Invalid transaction directory.');
  const directory = join(store.path, 'transactions', id);
  await canonicalDirectory(directory, true);
  const normalized = normalizeJournal(verify(await readJSON(join(directory, 'journal.json')), store.key), id, store.path);
  const journal = normalized.journal;
  const plan = await loadPlan(join(directory, 'plan'));
  check(plan.manifest.contentHash === journal.planHash && plan.targets.length === journal.targets.length, 'INVALID_JOURNAL', 'Stored plan does not match authenticated transaction.');
  const entry = { directory, journal, plan, legacy: normalized.legacy };
  for (const [index, target] of plan.targets.entries()) {
    const intent = journal.targets[index]!;
    const desired = journal.operation === 'apply' ? target.target.patched : target.target.original;
    check(target.target.identity.path === intent.path && desired.sha256 === intent.afterHash && desired.size === intent.afterSize, 'INVALID_JOURNAL', 'Stored target identity and operation outcome do not match intent.');
    const before = await backupBytes(entry, index);
    check(before.equals(target.original) || before.equals(target.patched), 'BACKUP_CHANGED', 'Operation backup does not match a known plan state.');
    if (terminal(journal)) {
      const final = intent.final;
      const expectedHash = journal.phase === 'committed' ? intent.afterHash : intent.before.sha256;
      const expectedSize = journal.phase === 'committed' ? intent.afterSize : intent.before.size;
      check(final && final.sha256 === expectedHash && final.size === expectedSize && parentMatches(final, intent.before), 'INVALID_JOURNAL', 'Terminal transaction does not prove its final state.');
    }
  }
  return entry;
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
    for (const target of entry.journal.targets) {
      if (!target.previous) continue;
      const prior = byId.get(target.previous);
      check(prior && terminal(prior.journal) && prior.journal.targets.some((item) => item.path === target.path) && prior.journal.sequence < entry.journal.sequence, 'UNTRUSTED_RECORD', 'Transaction provenance chain is missing or invalid.');
    }
  }
  return entries.sort((a, b) => a.journal.sequence - b.journal.sequence);
}

async function persist(store: Store, entry: RecordEntry): Promise<void> {
  try {
    // Existing v1 transactions keep their signed wire representation, including on recovery.
    const { targets, ...base } = entry.journal;
    const wire = entry.legacy ? { ...base, formatVersion: 1, target: targets[0] } : entry.journal;
    await atomicJSON(join(entry.directory, 'journal.json'), sign(wire, store.key));
  } catch (error) {
    // The write may have renamed and then failed. Only the persisted journal defines terminal state.
    entry.journal.phase = 'verifying'; // Unreadable persistence must never release a possibly incomplete lease.
    const value = verify(await readJSON(join(entry.directory, 'journal.json')), store.key);
    const normalized = normalizeJournal(value, entry.journal.id, store.path);
    entry.journal = normalized.journal;
    entry.legacy = normalized.legacy;
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

async function createIntent(store: Store, id: string, operation: Operation, plan: LoadedPlan, states: Classified[], sequence: number): Promise<RecordEntry> {
  const parent = join(store.path, 'transactions');
  const staging = join(parent, `.staging-${id}`);
  const destination = join(parent, id);
  await mkdir(staging, { mode: 0o700 });
  try {
    await copyPlan(plan, join(staging, 'plan'));
    const targets: JournalTarget[] = [];
    for (const [index, item] of plan.targets.entries()) {
      const { snapshot: before, previous } = states[index]!;
      const bytes = await regularBytes(item.target.identity.path);
      check(digest(bytes) === before.sha256 && bytes.length === before.size && same(await snapshot(item.target.identity.path), before), 'TARGET_CHANGED', 'Target changed before intent publication.');
      await writeExclusive(join(staging, backupName(plan.targets.length, index)), bytes);
      const desired = operation === 'apply' ? item.target.patched : item.target.original;
      targets.push({ path: item.target.identity.path, before, afterHash: desired.sha256, afterSize: desired.size, final: null, previous });
    }
    const journal: Journal = { formatVersion: 2, id, store: store.path, operation, sequence, planHash: plan.manifest.contentHash, phase: 'prepared', targets };
    await writeExclusive(join(staging, 'journal.json'), JSON.stringify(sign(journal, store.key)) + '\n');
    await syncDirectory(staging);
    await rename(staging, destination);
    await syncDirectory(parent);
    return { directory: destination, journal, plan: await loadPlan(join(destination, 'plan')), legacy: false };
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
  check(entry.journal.targets.some((target) => targetLock(target.path) === targetLock(path)), 'INVALID_LOCK', 'Target lock references an unrelated transaction.', path);
  return terminal(entry.journal) ? null : entry;
}

async function classify(item: PlanItem, entries: RecordEntry[]): Promise<Classified> {
  const path = item.target.identity.path;
  check(path === item.target.identity.realPath, 'PATH_ALIAS', 'Selected target has a path alias.', path);
  const current = await snapshot(path);
  const history = entries.filter((entry) => entry.journal.targets.some((target) => target.path === path) && terminal(entry.journal));
  const latest = history.at(-1);
  const trusted = latest?.journal.targets.find((target) => target.path === path)?.final;
  const priorItem = latest?.plan.targets.find((target) => target.target.identity.path === path);
  const sameTransformation = priorItem?.original.equals(item.original) && priorItem.patched.equals(item.patched);
  if (current.sha256 === item.target.original.sha256 && current.size === item.original.length && (matchesPlan(current, item.target.identity) || trusted && same(current, trusted))) {
    return { state: 'original', snapshot: current, previous: latest?.journal.id ?? null };
  }
  if (current.sha256 === item.target.patched.sha256 && current.size === item.patched.length && trusted && same(current, trusted) && sameTransformation) {
    return { state: 'tool-applied', snapshot: current, previous: latest!.journal.id };
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

async function recoverySnapshot(target: JournalTarget): Promise<Snapshot> {
  const current = await snapshot(target.path);
  const before = target.before;
  check(parentMatches(current, before) && ((current.sha256 === before.sha256 && current.size === before.size) || (current.sha256 === target.afterHash && current.size === target.afterSize)), 'RECOVERY_CONFLICT', 'Unknown current contents or target identity; recovery preserves the target and journal.', target.path);
  return current;
}

async function rollback(store: Store, entry: RecordEntry): Promise<void> {
  const journal = entry.journal;
  // Preflight the entire group before changing either targets or journal.
  const currents: Snapshot[] = [];
  for (const [index, target] of journal.targets.entries()) {
    await backupBytes(entry, index);
    currents.push(await recoverySnapshot(target));
  }
  await processes();
  journal.phase = 'rolling-back';
  await persist(store, entry);
  await recordAt(store, journal.id);
  for (const [index, target] of journal.targets.entries()) check(same(await snapshot(target.path), currents[index]!), 'TARGET_CHANGED', 'Target changed before the first rollback replacement.', target.path);
  for (const [index, target] of journal.targets.entries()) {
    const current = currents[index]!;
    const before = target.before;
    // Revalidate immediately before each rollback, including after journal I/O.
    const bytes = await backupBytes(entry, index);
    let final = current;
    if (current.sha256 !== before.sha256 || current.size !== before.size) final = await replaceTarget(target.path, bytes, current);
    check(final.sha256 === before.sha256 && final.size === before.size, 'ROLLBACK_FAILED', 'Rollback did not restore preoperation content.');
    check(same(await snapshot(target.path), final), 'TARGET_CHANGED', 'Target changed before rollback commit.', target.path);
    target.final = final;
    await persist(store, entry);
  }
  for (const target of journal.targets) check(target.final && same(await snapshot(target.path), target.final), 'TARGET_CHANGED', 'Target changed before group rollback commit.', target.path);
  journal.phase = 'rolled-back';
  await persist(store, entry);
}

function result(command: TransactionCommand, outcome: OperationResult['outcome'], data: OperationResult['data'], diagnostics: Diagnostic[] = []): OperationResult {
  return { schemaVersion: 1, command, outcome, exitCode: outcome === 'success' ? EXIT_CODES.success : outcome === 'conflict' ? EXIT_CODES.conflict : outcome === 'usage-error' ? EXIT_CODES.usageError : outcome === 'incompatible' ? EXIT_CODES.incompatible : EXIT_CODES.runtimeError, data, diagnostics: [...diagnostics, { code: 'PROCESS_CHECK_LIMITATION', severity: 'info', message: PROCESS_LIMITATION }] };
}

function failure(command: TransactionCommand, error: unknown): OperationResult {
  const known = error instanceof TransactionError;
  const invalidPlan = error instanceof Error && 'code' in error && error.code === 'INVALID_PLAN';
  return result(command, known ? error.kind : invalidPlan ? 'conflict' : 'runtime-error', null, [{ code: known ? error.code : invalidPlan ? 'INVALID_PLAN' : 'OPERATION_FAILED', severity: 'error', message: error instanceof Error ? error.message : 'Operation failed.', ...(known && error.path ? { path: error.path } : {}), ...(error instanceof Error && 'code' in error && !known && !invalidPlan ? { systemCode: String(error.code) } : {}) }]);
}

export async function apply(options: Options): Promise<OperationResult> {
  try { return await changeTransaction('apply', options); } catch (error) { return failure('apply', error); }
}

export async function restore(options: Options): Promise<OperationResult> {
  try { return await changeTransaction('restore', options); } catch (error) { return failure('restore', error); }
}

async function changeTransaction(operation: Operation, options: Options): Promise<OperationResult> {
  let entry: RecordEntry | null = null;
  let store: Store | null = null;
  const leases: { root: string; lease: Awaited<ReturnType<typeof acquireLease>> }[] = [];
  let writing = false;
  try {
    if (process.platform !== 'darwin') throw new TransactionError('UNSUPPORTED_PLATFORM', `Only macOS is supported; received ${process.platform}.`, 'runtime-error');
    const plan = await loadPlan(options.plan ?? '');
    const paths = plan.targets.map((item) => item.target.identity.path);
    await processes();
    const existing = await storeAt(options.store, false);
    const history = await records(existing);
    check(!history.some((record) => !terminal(record.journal)), 'INCOMPLETE_TRANSACTION', 'Operation store contains an incomplete transaction; use recover.');
    for (const path of paths) check(!await pendingAtTarget(path), 'INCOMPLETE_TRANSACTION', 'Target has an incomplete transaction, possibly in another store; use recover with its store.');
    const classified: Classified[] = [];
    for (const item of plan.targets) classified.push(await classify(item, history));
    store = await storeAt(options.store, true);
    check(store, 'UNTRUSTED_STORE', 'Cannot create operation store.');
    const transaction = randomUUID();
    const table = await processes();
    for (const root of [join(store.path, 'operation.lock'), ...new Set(paths.map(targetLock).sort())]) {
      const lease = await acquireLease(root, { store: store.path, transaction, table }, (previous) => previousTransaction(previous, null, false));
      leases.push({ root, lease });
    }
    const currentRecords = await records(store);
    check(!currentRecords.some((record) => !terminal(record.journal)), 'INCOMPLETE_TRANSACTION', 'Another transaction requires recovery.');
    const current: Classified[] = [];
    for (const [index, item] of plan.targets.entries()) {
      const state = await classify(item, currentRecords);
      check(same(state.snapshot, classified[index]!.snapshot), 'TARGET_CHANGED', 'Target changed while acquiring locks.');
      current.push(state);
    }
    const desiredState = operation === 'apply' ? 'tool-applied' : 'original';
    entry = await createIntent(store, transaction, operation, plan, current, Math.max(0, ...currentRecords.map((record) => record.journal.sequence)) + 1);
    await processes();
    // Intent publication and process enumeration can take time: recheck every target before the first write.
    for (const [index, path] of paths.entries()) check(same(await snapshot(path), current[index]!.snapshot), 'TARGET_CHANGED', 'Target changed before group write.', path);
    if (current.some((state) => state.state !== desiredState)) {
      entry.journal.phase = 'writing';
      await persist(store, entry);
      writing = true;
    }
    // Journal writes are also a race boundary. Validate every persisted backup and target again.
    await recordAt(store, transaction);
    for (const [index, path] of paths.entries()) check(same(await snapshot(path), current[index]!.snapshot), 'TARGET_CHANGED', 'Target changed before the first replacement.', path);
    const targets: NonNullable<OperationResult['data']>['targets'] = [];
    for (const [index, item] of entry.plan.targets.entries()) {
      const path = item.target.identity.path;
      const state = current[index]!;
      const noop = state.state === desiredState;
      const final = noop ? state.snapshot : await replaceTarget(path, operation === 'apply' ? item.patched : item.original, state.snapshot);
      check(same(await snapshot(path), final), 'POSTVERIFY_FAILED', 'Target changed before commit.', path);
      entry.journal.targets[index]!.final = final;
      if (writing) { entry.journal.phase = 'verifying'; await persist(store, entry); }
      targets.push({ path, state: desiredState, action: operation === 'apply' ? noop ? 'already-applied' : 'applied' : noop ? 'already-original' : 'restored' });
    }
    for (const target of entry.journal.targets) check(target.final && same(await snapshot(target.path), target.final), 'POSTVERIFY_FAILED', 'Target changed before group commit.', target.path);
    entry.journal.phase = 'committed';
    await persist(store, entry);
    writing = false;
    return result(operation, 'success', { store: store.path, transaction: entry.journal.id, operation: entry.journal.operation, targets, runtime: 'not-verified' });
  } catch (error) {
    if (entry && store && !terminal(entry.journal) && !(error instanceof TransactionError && error.code === 'JOURNAL_WRITE_FAILED')) {
      try {
        if (writing) await rollback(store, entry);
        else { entry.journal.phase = 'rolled-back'; for (const target of entry.journal.targets) target.final = target.before; await persist(store, entry); }
      } catch (rollbackError) {
        return result(operation, 'runtime-error', { store: store.path, transaction: entry.journal.id, operation: entry.journal.operation, targets: entry.journal.targets.map((target) => ({ path: target.path, state: 'incomplete' })), runtime: 'not-verified' }, [{ code: 'ROLLBACK_FAILED', severity: 'error', message: `${error instanceof Error ? error.message : `${operation} failed.`} Rollback failed: ${rollbackError instanceof Error ? rollbackError.message : 'unknown error'}. Explicit recover is required.` }]);
      }
    }
    return failure(operation, error);
  } finally {
    if (!entry || terminal(entry.journal)) for (const { root, lease } of leases.reverse()) await releaseLease(root, lease);
  }
}

async function pendingSummary(entry: RecordEntry): Promise<PendingTransaction> {
  const targets: OperationTarget[] = [];
  for (const [index, target] of entry.journal.targets.entries()) {
    let current: NonNullable<OperationTarget['pending']>['current'] = 'unknown';
    try {
      const actual = await recoverySnapshot(target);
      const before = actual.sha256 === target.before.sha256 && actual.size === target.before.size;
      const after = actual.sha256 === target.afterHash && actual.size === target.afterSize;
      current = before && after ? 'before-and-after' : before ? 'before' : 'after';
    } catch (error) {
      if (!(error instanceof TransactionError)) throw error;
    }
    targets.push({ path: target.path, state: current === 'unknown' ? 'conflict' : 'incomplete', pending: {
      store: entry.journal.store, transaction: entry.journal.id, operation: entry.journal.operation, current,
      before: entry.plan.targets[index]!.target.original.sha256 === target.before.sha256 ? 'original' : 'tool-applied',
      desired: entry.journal.operation === 'apply' ? 'tool-applied' : 'original',
    } });
  }
  return { store: entry.journal.store, transaction: entry.journal.id, operation: entry.journal.operation, state: targets.some((target) => target.state === 'conflict') ? 'conflict' : 'incomplete', targets };
}

export async function status(options: Options): Promise<OperationResult> {
  try {
    const store = await storeAt(options.store, false);
    const history = await records(store);
    const plan = options.plan ? await loadPlan(options.plan) : null;
    const paths = plan ? plan.targets.map((item) => item.target.identity.path) : options.targets ?? [];
    if (!paths.length) throw new TransactionError('SELECTION_REQUIRED', 'status requires --plan or --target.', 'usage-error');
    const pendingEntries = new Map(history.filter((entry) => !terminal(entry.journal)).map((entry) => [`${entry.journal.store}/${entry.journal.id}`, entry]));
    for (const path of paths) {
      const pending = await pendingAtTarget(path);
      if (pending) pendingEntries.set(`${pending.journal.store}/${pending.journal.id}`, pending);
    }
    const pendingTransactions: PendingTransaction[] = [];
    for (const entry of pendingEntries.values()) pendingTransactions.push(await pendingSummary(entry));
    pendingTransactions.sort((a, b) => a.store.localeCompare(b.store) || a.transaction.localeCompare(b.transaction));
    const targets: OperationTarget[] = [];
    const diagnostics: Diagnostic[] = [];
    for (const path of paths) {
      const pending = pendingTransactions.flatMap((entry) => entry.targets).find((target) => target.path === path);
      if (pending) { targets.push(pending); continue; }
      const trusted = history.filter((entry) => entry.journal.targets.some((target) => target.path === path)).at(-1);
      const item = plan?.targets.find((target) => target.target.identity.path === path) ?? trusted?.plan.targets.find((target) => target.target.identity.path === path);
      if (item) {
        try { targets.push({ path, state: (await classify(item, history)).state }); }
        catch (error) {
          if (!(error instanceof TransactionError)) throw error;
          targets.push({ path, state: 'conflict' });
          diagnostics.push({ code: error.code, severity: 'error', message: error.message, path });
        }
      } else {
        const current = await snapshot(path);
        const bytes = await regularBytes(path);
        check(digest(bytes) === current.sha256, 'TARGET_CHANGED', 'Target changed during status.', path);
        const analysis = analyzeSource(bytes.toString('utf8'));
        const untrusted = analysis.diagnostics.some((entry) => entry.code === 'UNTRUSTED_PATCHED_SHAPE');
        targets.push({ path, state: untrusted ? 'conflict' : analysis.compatibility === 'compatible' ? 'original' : 'incompatible' });
        diagnostics.push(...analysis.diagnostics.map((entry) => ({ ...entry, path })));
      }
    }
    const conflict = targets.some((target) => target.state === 'conflict') || pendingTransactions.some((entry) => entry.state === 'conflict');
    const incompatible = targets.some((target) => target.state === 'incompatible');
    const single = pendingTransactions.length === 1 ? pendingTransactions[0] : null;
    const groupState = conflict ? 'conflict' : pendingTransactions.length ? 'incomplete' : incompatible ? 'incompatible' : 'complete';
    return result('status', conflict ? 'conflict' : incompatible ? 'incompatible' : 'success', { store: options.store, transaction: single?.transaction ?? null, operation: single?.operation ?? null, groupState, pendingTransactions, targets, runtime: 'not-verified' }, diagnostics);
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
    if (!entry) return result('recover', 'success', { store: store.path, transaction: null, operation: null, targets: [], runtime: 'not-verified' }, [{ code: 'NO_INCOMPLETE_TRANSACTION', severity: 'info', message: 'No incomplete transaction; nothing to roll back.' }]);
    const table = await processes();
    for (const root of [join(store.path, 'operation.lock'), ...new Set(entry.journal.targets.map((target) => targetLock(target.path)).sort())]) {
      const lease = await acquireLease(root, { store: store.path, transaction: entry.journal.id, table }, (previous) => previousTransaction(previous, entry, true));
      leases.push({ root, lease });
    }
    // Another recovery can finish between our initial read and acquiring the store lock.
    const refreshed = await records(store);
    const current = refreshed.find((record) => record.journal.id === entry!.journal.id);
    check(current, 'UNTRUSTED_RECORD', 'Recovery transaction disappeared while acquiring locks.');
    entry = current;
    if (terminal(entry.journal)) return result('recover', 'success', { store: store.path, transaction: null, operation: null, targets: [], runtime: 'not-verified' }, [{ code: 'NO_INCOMPLETE_TRANSACTION', severity: 'info', message: 'Transaction already completed while acquiring locks; nothing to roll back.' }]);
    check(refreshed.filter((record) => !terminal(record.journal)).length === 1, 'AMBIGUOUS_TRANSACTION', 'Incomplete transactions changed while acquiring locks.');
    await rollback(store, entry);
    const targets: NonNullable<OperationResult['data']>['targets'] = entry.journal.targets.map((target, index) => ({ path: target.path, state: entry!.plan.targets[index]!.target.original.sha256 === target.before.sha256 ? 'original' : 'tool-applied', action: 'rolled-back' }));
    return result('recover', 'success', { store: store.path, transaction: entry.journal.id, operation: entry.journal.operation, targets, runtime: 'not-verified' });
  } catch (error) { return failure('recover', error); } finally {
    if (entry && terminal(entry.journal)) for (const { root, lease } of leases.reverse()) await releaseLease(root, lease);
  }
}
