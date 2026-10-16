import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { canonicalDirectory, check, exists, publish, readJSON, TransactionError } from './transaction-storage.js';
import type { ProcessIdentity } from './processes.js';

export interface LeaseRecord {
  version: 1;
  token: string;
  owner: { pid: number; start: string; executable: string };
  store: string;
  transaction: string;
  released: boolean;
}
interface Lease { path: string; record: LeaseRecord }
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function validate(value: unknown): asserts value is LeaseRecord {
  check(value !== null && typeof value === 'object', 'INVALID_LOCK', 'Cannot prove lock ownership.');
  const item = value as LeaseRecord;
  check(item.version === 1 && uuid.test(item.token) && uuid.test(item.transaction) && typeof item.store === 'string' && resolve(item.store) === item.store && typeof item.released === 'boolean' && item.owner && Number.isSafeInteger(item.owner.pid) && item.owner.pid > 0 && typeof item.owner.start === 'string' && item.owner.start.length > 0 && typeof item.owner.executable === 'string' && item.owner.executable.length > 0, 'INVALID_LOCK', 'Cannot prove lock ownership.');
}

/** Immutable successor links avoid deleting or stealing a successor's lock during stale-owner races. */
export async function inspectLease(path: string): Promise<Lease | null> {
  if (!await exists(path)) return null;
  let current = path;
  for (let count = 0; count < 100_000; count++) {
    const value = await readJSON(current, true);
    validate(value);
    const next = `${path}.${value.token}.next`;
    if (!await exists(next)) return { path: current, record: value };
    current = next;
  }
  throw new TransactionError('INVALID_LOCK', 'Lock history exceeds supported length.', 'conflict', path);
}

export function targetLock(path: string): string {
  return join(dirname(path), '.codex-browser-patch.lock');
}

export async function acquireLease(path: string, context: { store: string; transaction: string; table: ProcessIdentity[] }, checkPrevious: (record: LeaseRecord) => Promise<void>): Promise<Lease> {
  await canonicalDirectory(dirname(path));
  const self = context.table.find((entry) => entry.pid === process.pid);
  check(self, 'PROCESS_ENUMERATION_FAILED', 'Cannot prove this process identity.');
  for (let attempt = 0; attempt < 100; attempt++) {
    const previous = await inspectLease(path);
    if (previous) {
      const record = previous.record;
      const living = context.table.find((entry) => entry.pid === record.owner.pid);
      check(record.released || !living || living.start !== record.owner.start, 'LOCK_HELD', `Operation lock held by PID ${record.owner.pid} (${record.owner.executable}).`, path);
      if (!record.released && !living) {
        let dead = false;
        try { process.kill(record.owner.pid, 0); } catch (error) {
          dead = error instanceof Error && 'code' in error && error.code === 'ESRCH';
        }
        check(dead, 'OWNER_UNVERIFIED', 'Owner is absent from the process snapshot but death cannot be proven; retry.', path);
      }
      // A dead PID alone never permits bypassing that owner's transaction.
      await checkPrevious(record);
    }
    const destination = previous ? `${path}.${previous.record.token}.next` : path;
    const record: LeaseRecord = {
      version: 1, token: randomUUID(), owner: { pid: self.pid, start: self.start, executable: self.executable },
      store: context.store, transaction: context.transaction, released: false,
    };
    try { await publish(destination, record); return { path: destination, record }; } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
  }
  throw new TransactionError('LOCK_CONTENDED', 'Operation lock remains contended; retry.', 'conflict', path);
}

export async function releaseLease(root: string, lease: Lease): Promise<void> {
  await publish(`${root}.${lease.record.token}.next`, { ...lease.record, token: randomUUID(), released: true });
}
