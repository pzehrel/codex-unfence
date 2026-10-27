import { randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir, realpath } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { CUA_SCHEME } from './cua-contract.js';
import type { CuaDerivation, DeriveCua } from './cua-contract.js';
import { canonical, digest } from './integrity.js';
import { installationAt } from './installations.js';
import type { Candidate } from './installations.js';
import type { TransactionIdentity, ValidatedTransactionPlan } from './transaction-engine.js';
import { checkCoordinationPaths } from './transaction-locks.js';
import { canonicalDirectory, check, exists, privateDirectory, publish, readJSON, regularBytes, sign, syncDirectory, TransactionError, verify, writeExclusive } from './transaction-storage.js';

export interface ToolIdentity { packageName: string; version: string; executable: string }
interface Manifest {
  formatVersion: 1 | 2;
  scheme: typeof CUA_SCHEME;
  recipeVersion: 1 | 2;
  tool: ToolIdentity;
  candidate: Candidate;
  identity: TransactionIdentity;
  original: { sha256: string; size: number };
  patched: { sha256: string; size: number };
  change?: Pick<NonNullable<CuaDerivation['change']>, 'range' | 'before' | 'after'>;
  basis?: Omit<CuaDerivation, 'change'> & { change: Omit<NonNullable<CuaDerivation['change']>, 'patchedSource' | 'localDiff'> };
}
export interface ManagedPlan extends ValidatedTransactionPlan { manifest: Manifest & { contentHash: string }; derivation: CuaDerivation }
export interface Locator {
  formatVersion: 1;
  scheme: typeof CUA_SCHEME;
  recipeVersion: 1 | 2;
  id: string;
  target: string;
  preparation: string;
  store: string;
  contentHash: string;
  tool: ToolIdentity;
  recovery: string;
}
const files = ['manifest.json', 'source.original.mjs', 'source.patched.mjs', 'local-diff.txt'];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const recordObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function absolute(path: unknown): asserts path is string {
  check(typeof path === 'string' && isAbsolute(path) && resolve(path) === path, 'PATH_ALIAS', 'Managed paths must be normalized absolute paths.');
}
function validTool(tool: unknown): asserts tool is ToolIdentity {
  check(recordObject(tool) && Object.keys(tool).sort().join(',') === 'executable,packageName,version' && typeof tool.packageName === 'string' && /^[a-z0-9][a-z0-9._-]*$/.test(tool.packageName) && typeof tool.version === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.+-]+)?$/.test(tool.version) && typeof tool.executable === 'string' && /^[a-zA-Z0-9._-]+$/.test(tool.executable), 'INVALID_TOOL_IDENTITY', 'Expected the packaged tool name, version and executable.');
}
export function managedPaths(target: string) {
  absolute(target);
  const home = userInfo().homedir;
  const root = join(home, 'Library/Application Support/codex-unfence');
  const key = digest(target);
  checkCoordinationPaths([root, target]);
  check(!target.startsWith(root + sep) && !root.startsWith(target + sep), 'PATH_ALIAS', 'Managed state and installation must be separate.');
  return { home, root, locator: join(root, 'targets', key + '.json'), absentStore: join(root, 'stores', key) };
}
async function stateDirectory(path: string): Promise<void> {
  await canonicalDirectory(path, true);
  check(((await lstat(path)).mode & 0o777) === 0o700, 'UNTRUSTED_STORE', 'Managed directories require mode 0700.', path);
}
async function stateBytes(path: string): Promise<Buffer> {
  const bytes = await regularBytes(path, true);
  check(((await lstat(path)).mode & 0o777) === 0o600, 'UNTRUSTED_STORE', 'Managed files require mode 0600.', path);
  return bytes;
}
async function stateRoot(target: string, create: boolean): Promise<ReturnType<typeof managedPaths> | null> {
  const paths = managedPaths(target);
  await canonicalDirectory(paths.home);
  for (const parent of [join(paths.home, 'Library'), join(paths.home, 'Library/Application Support')]) {
    if (create && !await exists(parent)) await privateDirectory(parent);
    if (await exists(parent)) await canonicalDirectory(parent);
    else return null;
  }
  if (!await exists(paths.root)) {
    if (!create) return null;
    await privateDirectory(paths.root);
    await syncDirectory(dirname(paths.root));
  }
  await stateDirectory(paths.root);
  for (const name of ['preparations', 'stores', 'targets']) {
    const path = join(paths.root, name);
    if (create) await privateDirectory(path);
    if (await exists(path)) await stateDirectory(path);
    else {
      check(!await exists(paths.locator), 'RECOVERY_MATERIAL_MISSING', 'A managed target record exists but its recovery directories are missing.', path);
      return null;
    }
  }
  const keyPath = join(paths.root, 'key');
  if (create && !await exists(keyPath)) {
    try { await writeExclusive(keyPath, randomBytes(32)); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error; }
    await syncDirectory(paths.root);
  }
  return paths;
}
function manifestFor(original: Buffer, derivation: CuaDerivation, identity: TransactionIdentity, candidate: Candidate, tool: ToolIdentity): Manifest {
  validTool(tool);
  check(derivation.scheme === CUA_SCHEME && (derivation.recipeVersion === 1 || derivation.recipeVersion === 2) && derivation.support === 'supported' && derivation.change, 'UNSUPPORTED_SOURCE', 'Source is not supported by the CUA structural recipe.');
  const { patchedSource, range, before, after } = derivation.change;
  return { formatVersion: 2, scheme: CUA_SCHEME, recipeVersion: derivation.recipeVersion, tool, candidate, identity, original: { sha256: digest(original), size: original.length }, patched: { sha256: digest(patchedSource), size: Buffer.byteLength(patchedSource) }, change: { range, before, after } };
}
function identityAt(value: unknown): asserts value is TransactionIdentity {
  check(recordObject(value) && Object.keys(value).sort().join(',') === 'device,inode,mode,path,realPath', 'INVALID_PREPARATION', 'Invalid managed target identity.');
  absolute(value.path);
  check(value.realPath === value.path && typeof value.device === 'string' && /^(0|[1-9][0-9]*)$/.test(value.device) && typeof value.inode === 'string' && /^[1-9][0-9]*$/.test(value.inode) && Number.isSafeInteger(value.mode) && Number(value.mode) >= 0 && Number(value.mode) <= 0o7777, 'INVALID_PREPARATION', 'Invalid managed target identity.');
}

/** Reload original bytes and rederive all writable content; saved hashes alone never grant admission. */
export async function loadManagedPlan(directory: string, derive: DeriveCua): Promise<ManagedPlan> {
  check(await exists(directory), 'RECOVERY_MATERIAL_MISSING', 'Recovery files are missing. Preserve the current application; automatic restoration is unavailable.', directory);
  await stateDirectory(directory);
  const names = (await readdir(directory)).sort();
  if (canonical(names) === canonical(['reference.json'])) {
    const reference = await readJSON(join(directory, 'reference.json'));
    check(recordObject(reference) && typeof reference.preparation === 'string' && typeof reference.contentHash === 'string', 'INVALID_PREPARATION', 'Invalid recovery reference.');
    absolute(reference.preparation);
    const root = join(userInfo().homedir, 'Library/Application Support/codex-unfence/preparations');
    check(dirname(reference.preparation) === root && uuid.test(reference.preparation.slice(root.length + 1)), 'INVALID_PREPARATION', 'Recovery reference must select a local preparation.');
    const plan = await loadPreparation(reference.preparation, derive);
    check(plan.manifest.contentHash === reference.contentHash, 'INVALID_PREPARATION', 'Recovery reference does not match its preparation.');
    return plan;
  }
  return loadPreparation(directory, derive);
}

async function loadPreparation(directory: string, derive: DeriveCua): Promise<ManagedPlan> {
  await stateDirectory(directory);
  for (const name of ['manifest.json', 'source.original.mjs']) check(await exists(join(directory, name)), 'RECOVERY_MATERIAL_MISSING', 'Recovery files are missing. Preserve the current application; automatic restoration is unavailable.', join(directory, name));
  const saved = await readJSON(join(directory, 'manifest.json'));
  check(recordObject(saved) && saved.scheme === CUA_SCHEME && (saved.recipeVersion === 1 || saved.recipeVersion === 2) && (saved.formatVersion === 1 || saved.formatVersion === 2), 'SCHEME_MISMATCH', 'Preparation uses an unsupported format or patch recipe.');
  const expected = saved.formatVersion === 1 ? files : ['manifest.json', 'source.original.mjs'];
  check(canonical((await readdir(directory)).sort()) === canonical([...expected].sort()), 'INVALID_PREPARATION', 'Unexpected or missing managed preparation files.', directory);
  const original = await stateBytes(join(directory, 'source.original.mjs'));
  identityAt(saved.identity);
  check(recordObject(saved.candidate) && saved.candidate.targetPath === saved.identity.path && typeof saved.candidate.appPath === 'string' && join(saved.candidate.appPath, 'Contents/Resources/cua_node/lib/node_modules/@oai/browser-desktop/scripts/browser-service.mjs') === saved.identity.path, 'INVALID_PREPARATION', 'Preparation target and installation differ.');
  absolute(saved.candidate.appPath);
  validTool(saved.tool);
  const source = original.toString('utf8');
  check(Buffer.from(source).equals(original), 'INVALID_PREPARATION', 'Prepared original must be lossless UTF-8.');
  // Historical preparations bind the complete legacy evidence, not just patched bytes.
  // Keep that evidence authenticated for restoration; new admissions use the local analyzer.
  // Restoration validates the saved replacement without reproducing analyzer wording.
  const basis = recordObject(saved.basis) ? saved.basis : null;
  const change = saved.formatVersion === 1 ? basis?.change : saved.change;
  check(recordObject(change) && recordObject(change.range) && change.range.unit === 'utf16' && Number.isSafeInteger(change.range.start) && Number.isSafeInteger(change.range.end) && typeof change.before === 'string' && typeof change.after === 'string', 'INVALID_PREPARATION', 'Missing or invalid saved replacement.');
  const start = Number(change.range.start), end = Number(change.range.end);
  check(start >= 0 && end > start && end <= source.length && source.slice(start, end) === change.before, 'INVALID_PREPARATION', 'Saved replacement does not match the supported patch recipe.');
  const patched = Buffer.from(source.slice(0, start) + change.after + source.slice(end));
  check(recordObject(saved.original) && saved.original.sha256 === digest(original) && saved.original.size === original.length && recordObject(saved.patched) && saved.patched.sha256 === digest(patched) && saved.patched.size === patched.length, 'INVALID_PREPARATION', 'Recovery bytes do not match their recorded hashes.');
  if (saved.formatVersion === 1) {
    check(patched.equals(await stateBytes(join(directory, 'source.patched.mjs'))), 'INVALID_PREPARATION', 'Saved patched file differs from its replacement.');
    await stateBytes(join(directory, 'local-diff.txt'));
  }
  const manifest = saved as unknown as Manifest;
  const derivation = derive(source);
  return { directory, manifest: { ...manifest, contentHash: digest(canonical(saved)) }, targets: [{ target: { identity: manifest.identity, original: manifest.original, patched: manifest.patched }, original, patched }], derivation };
}

export async function managedRecord(target: string, derive: DeriveCua): Promise<{ locator: Locator; plan: ManagedPlan } | null> {
  const paths = await stateRoot(target, false);
  if (!paths || !await exists(paths.locator)) return null;
  const key = await stateBytes(join(paths.root, 'key'));
  check(key.length === 32, 'UNTRUSTED_STORE', 'Invalid managed state key.');
  let path = paths.locator;
  let predecessor: string | null = null;
  const visited = new Set<string>();
  for (let count = 0; count < 100_000; count++) {
    let value = verify(await readJSON(path, true), key);
    check(((await lstat(path)).mode & 0o777) === 0o600, 'UNTRUSTED_STORE', 'Managed files require mode 0600.', path);
    if (predecessor !== null) {
      check(recordObject(value) && Object.keys(value).sort().join(',') === 'locator,predecessor' && value.predecessor === predecessor, 'UNTRUSTED_RECORD', 'Managed successor does not bind its predecessor.', path);
      value = value.locator;
    }
    check(recordObject(value) && value.scheme === CUA_SCHEME && value.formatVersion === 1 && (value.recipeVersion === 1 || value.recipeVersion === 2), 'UNSUPPORTED_MANAGED_RECORD', 'Unknown managed source. Restore with its original tool version and entrypoint; no migration was performed.');
    check(typeof value.id === 'string' && uuid.test(value.id) && value.target === target && value.preparation === join(paths.root, 'preparations', value.id) && value.store === join(paths.root, 'stores', value.id) && typeof value.contentHash === 'string' && /^[a-f0-9]{64}$/.test(value.contentHash), 'UNTRUSTED_RECORD', 'Managed locator paths or target identity changed. Operation stores cannot be migrated.');
    validTool(value.tool);
    check(value.recovery === recoveryCommand(value.tool), 'UNTRUSTED_RECORD', 'Managed recovery entrypoint differs from its exact tool version.');
    const locator = value as unknown as Locator;
    check(Object.keys(locator).sort().join(',') === 'contentHash,formatVersion,id,preparation,recipeVersion,recovery,scheme,store,target,tool', 'UNTRUSTED_RECORD', 'Unknown or missing managed locator fields.');
    const plan = await loadManagedPlan(locator.preparation, derive);
    check(plan.manifest.contentHash === locator.contentHash && plan.manifest.identity.path === target && canonical(plan.manifest.tool) === canonical(locator.tool), 'UNTRUSTED_RECORD', 'Managed locator does not bind this preparation.');
    check(!visited.has(locator.id), 'UNTRUSTED_RECORD', 'Managed selection history contains a cycle.');
    visited.add(locator.id);
    const next = `${paths.locator}.${locator.id}.next`;
    if (!await exists(next)) return { locator, plan };
    predecessor = digest(canonical(locator));
    path = next;
  }
  throw new TransactionError('UNTRUSTED_RECORD', 'Managed selection history exceeds supported length.', 'conflict', target);
}
export function recoveryCommand(tool: ToolIdentity): string {
  validTool(tool);
  return `npx --package ${tool.packageName}@${tool.version} ${tool.executable}`;
}

export interface PreparationExpectation { device: string; inode: string; mode: number; ctime: string; mtime: string; parentDevice: string; parentInode: string }
export async function prepareManaged(candidate: Candidate, original: Buffer, expected: PreparationExpectation, derive: DeriveCua, tool: ToolIdentity, previous: Locator | null = null): Promise<{ locator: Locator; plan: ManagedPlan }> {
  const target = candidate.targetPath;
  const existing = await managedRecord(target, derive);
  check(canonical(existing?.locator ?? null) === canonical(previous), 'INSPECTION_CHANGED', 'Managed selection changed after confirmation; inspect and confirm again.');
  check(await realpath(target) === target, 'PATH_ALIAS', 'Target must be canonical.');
  const metadata = await lstat(target, { bigint: true });
  check(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1n, 'PATH_ALIAS', 'Target must be an unaliased regular file.');
  check(String(metadata.dev) === expected.device && String(metadata.ino) === expected.inode && Number(metadata.mode & 0o7777n) === expected.mode && String(metadata.ctimeNs) === expected.ctime && String(metadata.mtimeNs) === expected.mtime, 'TARGET_CHANGED', 'Target identity changed after confirmation.');
  check((await regularBytes(target)).equals(original), 'TARGET_CHANGED', 'Target changed before preparation.');
  const identity: TransactionIdentity = { path: target, realPath: target, device: String(metadata.dev), inode: String(metadata.ino), mode: Number(metadata.mode & 0o7777n) };
  const text = original.toString('utf8');
  check(Buffer.from(text).equals(original), 'INVALID_SOURCE', 'Target must be lossless UTF-8.');
  const derivation = derive(text);
  const manifest = manifestFor(original, derivation, identity, candidate, tool);
  const paths = await stateRoot(target, true);
  check(paths, 'UNTRUSTED_STORE', 'Cannot initialize managed state.');
  const id = randomUUID();
  const directory = join(paths.root, 'preparations', id);
  await mkdir(directory, { mode: 0o700 });
  await writeExclusive(join(directory, 'source.original.mjs'), original);
  await writeExclusive(join(directory, 'manifest.json'), JSON.stringify(manifest) + '\n');
  await syncDirectory(directory);
  await syncDirectory(dirname(directory));
  const plan = await loadManagedPlan(directory, derive);
  const locator: Locator = { formatVersion: 1, scheme: CUA_SCHEME, recipeVersion: manifest.recipeVersion, id, target, preparation: directory, store: join(paths.root, 'stores', id), contentHash: plan.manifest.contentHash, tool, recovery: recoveryCommand(tool) };
  const key = await stateBytes(join(paths.root, 'key'));
  check(key.length === 32, 'UNTRUSTED_STORE', 'Invalid managed state key.');
  // Immutable discovery locator is durable before the engine can publish an intent or write a target.
  const current = await managedRecord(target, derive);
  check(canonical(current?.locator ?? null) === canonical(previous), 'INSPECTION_CHANGED', 'Managed selection changed before publication.');
  check(canonical(await installationAt(candidate.appPath)) === canonical(candidate), 'INSPECTION_CHANGED', 'Installation information changed before publication.');
  const parent = await lstat(dirname(target), { bigint: true });
  check(String(parent.dev) === expected.parentDevice && String(parent.ino) === expected.parentInode, 'TARGET_CHANGED', 'Target parent changed before preparation publication.');
  const latest = await lstat(target, { bigint: true });
  check(String(latest.dev) === expected.device && String(latest.ino) === expected.inode && Number(latest.mode & 0o7777n) === expected.mode && String(latest.ctimeNs) === expected.ctime && String(latest.mtimeNs) === expected.mtime && (await regularBytes(target)).equals(original), 'TARGET_CHANGED', 'Target changed before preparation publication.');
  const destination = previous ? `${paths.locator}.${previous.id}.next` : paths.locator;
  await publish(destination, sign(previous ? { predecessor: digest(canonical(previous)), locator } : locator, key));
  const loaded = await managedRecord(target, derive);
  check(loaded, 'UNTRUSTED_RECORD', 'Managed locator was not durably published.');
  return loaded;
}

export async function copyManagedPlan(plan: ValidatedTransactionPlan, destination: string, derive: DeriveCua): Promise<void> {
  const before = await loadManagedPlan(plan.directory, derive);
  check(before.manifest.contentHash === plan.manifest.contentHash, 'PLAN_CHANGED', 'Preparation changed before copying.');
  await mkdir(destination, { mode: 0o700 });
  if (before.manifest.formatVersion === 2) {
    await writeExclusive(join(destination, 'reference.json'), JSON.stringify({ preparation: before.directory, contentHash: before.manifest.contentHash }) + '\n');
  } else {
    for (const name of files) await writeExclusive(join(destination, name), await stateBytes(join(before.directory, name)));
  }
  await syncDirectory(destination);
  check((await loadManagedPlan(destination, derive)).manifest.contentHash === plan.manifest.contentHash, 'PLAN_CHANGED', 'Preparation changed while copying.');
}
