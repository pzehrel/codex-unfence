import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { canonical } from './integrity.js';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export class TransactionError extends Error {
  constructor(readonly code: string, message: string, readonly kind: 'conflict' | 'runtime-error' | 'usage-error' = 'conflict', readonly path?: string) { super(message); }
}

export function check(condition: unknown, code: string, message: string, path?: string): asserts condition {
  if (!condition) throw new TransactionError(code, message, 'conflict', path);
}

export async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

export async function canonicalDirectory(path: string, privateDirectory = false): Promise<void> {
  const metadata = await lstat(path);
  check(resolve(path) === path && await realpath(path) === path && metadata.isDirectory() && !metadata.isSymbolicLink(), 'PATH_ALIAS', 'Directory must be a canonical path without symlink aliases.', path);
  if (privateDirectory) check(metadata.uid === process.getuid?.() && (metadata.mode & 0o077) === 0, 'UNTRUSTED_STORE', 'Operation directories must be owned by this user with mode 0700.', path);
}

export async function privateDirectory(path: string): Promise<void> {
  await canonicalDirectory(dirname(path));
  try { await mkdir(path, { mode: 0o700 }); } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  await canonicalDirectory(path, true);
}

async function publicationLinks(path: string, identity: { dev: bigint; ino: bigint }): Promise<boolean> {
  // link publishes a fully synced immutable record before its staging name is removed.
  // A killed publisher can leave exactly this second name. Recognize, never delete it:
  // readers may race a live publisher and must not change its ownership evidence.
  let peers = 0;
  for (const name of await readdir(dirname(path))) {
    if (!/^\.publish-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(name)) continue;
    try {
      const peer = await lstat(join(dirname(path), name), { bigint: true });
      if (peer.dev === identity.dev && peer.ino === identity.ino && peer.isFile() && !peer.isSymbolicLink() && peer.uid === BigInt(process.getuid?.() ?? -1) && (peer.mode & 0o077n) === 0n) peers++;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  const current = await lstat(path, { bigint: true });
  return current.dev === identity.dev && current.ino === identity.ino && (current.nlink === 1n || current.nlink === 2n && peers === 1);
}

export async function regularBytes(path: string, privateFile = false): Promise<Buffer> {
  return readBytes(path, privateFile, false);
}

async function readBytes(path: string, privateFile: boolean, publication: boolean): Promise<Buffer> {
  const before = await lstat(path, { bigint: true });
  check(before.isFile() && !before.isSymbolicLink() && (before.nlink === 1n || publication && before.nlink === 2n && await publicationLinks(path, before)) && await realpath(path) === path, 'PATH_ALIAS', 'Expected an unaliased regular file or a proven immutable publication.', path);
  if (privateFile) check(before.uid === BigInt(process.getuid?.() ?? -1) && (before.mode & 0o077n) === 0n, 'UNTRUSTED_STORE', 'Operation files must be private and owned by this user.', path);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    check(opened.dev === before.dev && opened.ino === before.ino, 'IDENTITY_CHANGED', 'File changed while opening.', path);
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const current = await lstat(path, { bigint: true });
    const unlinkedStaging = publication && opened.nlink === 2n && after.nlink === 1n;
    check(opened.dev === after.dev && opened.ino === after.ino && opened.size === after.size && opened.mtimeNs === after.mtimeNs && (opened.ctimeNs === after.ctimeNs || unlinkedStaging) && current.dev === opened.dev && current.ino === opened.ino, 'IDENTITY_CHANGED', 'File changed while reading.', path);
    if (publication) check(await publicationLinks(path, after), 'PATH_ALIAS', 'Publication has an unexplained hardlink alias.', path);
    return bytes;
  } finally { await handle.close(); }
}

export async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function writeExclusive(path: string, bytes: Buffer | string, mode = 0o600): Promise<void> {
  const handle = await open(path, 'wx', mode);
  try { await handle.writeFile(bytes); await handle.chmod(mode); await handle.sync(); } finally { await handle.close(); }
}

/** Atomic publication with no replacement and no partially initialized owner record. */
export async function publish(path: string, value: unknown): Promise<void> {
  const staging = join(dirname(path), `.publish-${randomUUID()}`);
  try {
    await writeExclusive(staging, JSON.stringify(value) + '\n');
    await link(staging, path);
    await rm(staging);
  } finally { await rm(staging, { force: true }); }
  await syncDirectory(dirname(path));
}

export async function atomicJSON(path: string, value: unknown): Promise<void> {
  const staging = join(dirname(path), `.journal-${randomUUID()}`);
  try {
    await writeExclusive(staging, JSON.stringify(value) + '\n');
    await rename(staging, path);
    await syncDirectory(dirname(path));
  } finally { await rm(staging, { force: true }); }
}

export async function readJSON(path: string, publication = false): Promise<unknown> {
  const bytes = await readBytes(path, true, publication);
  const text = bytes.toString('utf8');
  check(Buffer.from(text).equals(bytes), 'INVALID_RECORD', 'Record is not lossless UTF-8.', path);
  try { return JSON.parse(text) as unknown; } catch { throw new TransactionError('INVALID_RECORD', 'Invalid JSON record.', 'conflict', path); }
}

export function sign(value: unknown, key: Buffer): { record: unknown; mac: string } {
  return { record: value, mac: createHmac('sha256', key).update(canonical(value)).digest('hex') };
}

export function verify(value: unknown, key: Buffer): unknown {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'UNTRUSTED_RECORD', 'Missing authenticated transaction record.');
  const envelope = value as Record<string, unknown>;
  check(Object.keys(envelope).sort().join(',') === 'mac,record' && typeof envelope.mac === 'string' && /^[a-f0-9]{64}$/.test(envelope.mac), 'UNTRUSTED_RECORD', 'Invalid authenticated transaction envelope.');
  const expected = Buffer.from(sign(envelope.record, key).mac, 'hex');
  check(timingSafeEqual(expected, Buffer.from(envelope.mac, 'hex')), 'UNTRUSTED_RECORD', 'Transaction authentication failed.');
  return envelope.record;
}
