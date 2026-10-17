import { randomUUID } from 'node:crypto';
import { canonical, digest as hash } from './integrity.js';
import { constants } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parse } from 'acorn';
import type * as E from 'estree';
import { transformSource } from './analysis.js';
import type { PatternVersion, SourceRange, StructuralEvidence } from './analysis.js';
import { detect } from './discovery.js';
import { EXIT_CODES } from './result.js';
import type { Artifact, Diagnostic, PreparationResult } from './result.js';

export interface TargetIdentity {
  pluginRoot: string;
  plugin: 'browser' | 'chrome';
  version: string;
  path: string;
  realPath: string;
  device: string;
  inode: string;
  mode: number;
}

export interface PlanArtifact {
  file: string;
  size: number;
  sha256: string;
}

export interface PlanTarget {
  id: string;
  identity: TargetIdentity;
  original: PlanArtifact;
  patched: PlanArtifact;
  localDiff: PlanArtifact;
  evidence: StructuralEvidence[];
  expression: { range: SourceRange; before: string; after: string };
}

interface ManifestFields {
  id: string;
  pluginRoot: string;
  runtime: 'not-verified';
  pluginFiles: 'unchanged';
  contentHash: string;
}

/** Retain the exact historical v1 shape; v2 selections identify every target. */
export type PlanManifest = ManifestFields & (
  { formatVersion: 1; patternVersion: 'site-status-v1'; targets: PlanTarget[] } |
  { formatVersion: 2; patternVersion: 'site-status-selection-v1'; targets: (PlanTarget & { patternVersion: PatternVersion })[] }
);

export interface LoadedPlan {
  directory: string;
  manifest: PlanManifest;
  targets: { target: PlanTarget; original: Buffer; patched: Buffer }[];
}

class PlanError extends Error {
  constructor(readonly code: string, message: string, readonly outcome: PreparationResult['outcome'] = 'runtime-error', readonly path?: string) {
    super(message);
  }
}

function requirePlan(condition: unknown, message: string): asserts condition {
  if (!condition) throw new PlanError('INVALID_PLAN', message);
}

function descriptor(file: string, bytes: Buffer): PlanArtifact {
  return { file, size: bytes.length, sha256: hash(bytes) };
}

function names(index: number): { original: string; patched: string; localDiff: string } {
  const prefix = String(index).padStart(4, '0');
  return { original: `${prefix}.original.mjs`, patched: `${prefix}.patched.mjs`, localDiff: `${prefix}.diff.txt` };
}

function decode(bytes: Buffer): string {
  // Buffer.toString preserves BOM but replaces malformed UTF-8. Reject any lossy roundtrip.
  const source = bytes.toString('utf8');
  requirePlan(Buffer.from(source, 'utf8').equals(bytes), 'Source must be lossless UTF-8.');
  return source;
}

async function snapshot(path: string): Promise<{ realPath: string; bytes: Buffer; device: string; inode: string; mode: number }> {
  const canonicalPath = await realpath(path);
  const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    requirePlan(before.isFile(), 'Target must be a regular file.');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const current = await lstat(canonicalPath, { bigint: true });
    requirePlan(before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
      before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs &&
      current.dev === before.dev && current.ino === before.ino && !current.isSymbolicLink() &&
      await realpath(path) === canonicalPath, 'Target identity changed while reading.');
    return { realPath: canonicalPath, bytes, device: String(before.dev), inode: String(before.ino), mode: Number(before.mode & 0o7777n) };
  } finally {
    await handle.close();
  }
}

async function writeExclusive(path: string, bytes: string | Buffer): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

function failure(error: unknown): { outcome: PreparationResult['outcome']; diagnostic: Diagnostic } {
  if (error instanceof PlanError) {
    return { outcome: error.outcome, diagnostic: { code: error.code, severity: 'error', message: error.message, ...(error.path ? { path: error.path } : {}) } };
  }
  return { outcome: 'runtime-error', diagnostic: {
    code: 'PREPARE_FAILED', severity: 'error', message: error instanceof Error ? error.message : 'Preparation failed.',
    ...(error instanceof Error && 'code' in error ? { systemCode: String(error.code) } : {}),
  } };
}

export interface PrepareOptions {
  pluginRoot?: string;
  targets: string[];
  allCompatible: boolean;
  output: string;
}

/** Generates review artifacts only; never opens a plugin for writing. */
export async function prepare(options: PrepareOptions): Promise<PreparationResult> {
  const diagnostics: Diagnostic[] = [];
  try {
    const discovery = await detect(options.pluginRoot);
    if (!discovery.data || discovery.outcome === 'runtime-error') {
      return { ...discovery, command: 'prepare', data: null };
    }
    const { pluginRoot, artifacts } = discovery.data;
    let selected: Artifact[];
    if (options.allCompatible) {
      selected = artifacts.filter((entry) => entry.compatibility === 'compatible');
      diagnostics.push(...discovery.diagnostics.map((entry) => ({ ...entry, severity: entry.severity === 'error' ? 'warning' as const : entry.severity })));
    } else {
      selected = options.targets.map((path) => {
        const entry = artifacts.find((artifact) => artifact.path === path);
        if (!entry) throw new PlanError('TARGET_NOT_FOUND', 'Select an exact absolute artifact path reported by detect.', 'usage-error', path);
        return entry;
      });
    }
    if (!selected.length) throw new PlanError('NO_COMPATIBLE_TARGETS', 'No compatible targets were selected.', 'incompatible');
    const paths = new Set<string>();
    const files = new Set<string>();
    const snapshots: { target: PlanTarget; patternVersion: PatternVersion; original: Buffer; patched: Buffer; diff: Buffer }[] = [];
    for (const entry of selected) {
      if (entry.compatibility !== 'compatible') {
        diagnostics.push(...(entry.analysis?.diagnostics ?? []).map((item) => ({ ...item, path: entry.path })));
        throw new PlanError('TARGET_INCOMPATIBLE', 'An explicitly selected target is incompatible.', 'incompatible', entry.path);
      }
      const current = await snapshot(entry.path);
      const key = `${current.device}:${current.inode}`;
      if (paths.has(current.realPath) || files.has(key)) throw new PlanError('DUPLICATE_TARGET', 'Targets alias the same canonical file or filesystem identity.', 'usage-error', entry.path);
      paths.add(current.realPath);
      files.add(key);
      if (current.realPath !== entry.realPath) throw new PlanError('TARGET_CHANGED', 'Target changed since discovery.', 'runtime-error', entry.path);
      const transformed = transformSource(decode(current.bytes));
      if (!transformed.transformation) throw new PlanError('TARGET_CHANGED', 'Target is no longer structurally compatible.', 'incompatible', entry.path);
      const change = transformed.transformation;
      const identity: TargetIdentity = {
        pluginRoot, plugin: entry.plugin, version: entry.version, path: entry.path, realPath: current.realPath,
        device: current.device, inode: current.inode, mode: current.mode,
      };
      const original = current.bytes;
      const patched = Buffer.from(change.patchedSource, 'utf8');
      const diff = Buffer.from(change.localDiff, 'utf8');
      const fileNames = names(snapshots.length);
      snapshots.push({ target: {
        id: hash(canonical(identity)), identity,
        original: descriptor(fileNames.original, original), patched: descriptor(fileNames.patched, patched), localDiff: descriptor(fileNames.localDiff, diff),
        evidence: transformed.analysis.evidence,
        expression: { range: change.range, before: change.before, after: change.after },
      }, patternVersion: transformed.analysis.patternVersion, original, patched, diff });
    }
    const fields = { id: randomUUID(), pluginRoot, runtime: 'not-verified' as const, pluginFiles: 'unchanged' as const };
    // Legacy-only selections keep the historical representation byte-for-schema.
    // Any deferred target uses v2, including mixed selections, with explicit per-target identity.
    const manifestBase = snapshots.every(entry => entry.patternVersion === 'site-status-v1')
      ? { ...fields, formatVersion: 1 as const, patternVersion: 'site-status-v1' as const, targets: snapshots.map(entry => entry.target) }
      : { ...fields, formatVersion: 2 as const, patternVersion: 'site-status-selection-v1' as const, targets: snapshots.map(entry => ({ ...entry.target, patternVersion: entry.patternVersion })) };
    const manifest: PlanManifest = { ...manifestBase, contentHash: hash(canonical(manifestBase)) };
    validateManifest(manifest);
    const directory = resolve(options.output);
    const parent = await realpath(dirname(directory));
    if (parent !== dirname(directory)) throw new PlanError('OUTPUT_ALIAS', 'Output parent must be a canonical directory path.', 'usage-error', directory);
    const staging = await mkdtemp(join(parent, `.${basename(directory)}.staging-`));
    let reservation: { device: bigint; inode: bigint } | null = null;
    let complete = false;
    async function ownsReservation(): Promise<boolean> {
      if (!reservation) return false;
      try {
        const current = await lstat(directory, { bigint: true });
        return current.isDirectory() && !current.isSymbolicLink() && current.dev === reservation.device && current.ino === reservation.inode;
      } catch { return false; }
    }
    try {
      for (const entry of snapshots) {
        await writeExclusive(join(staging, entry.target.original.file), entry.original);
        await writeExclusive(join(staging, entry.target.patched.file), entry.patched);
        await writeExclusive(join(staging, entry.target.localDiff.file), entry.diff);
      }
      await writeExclusive(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      await syncDirectory(staging);
      for (const entry of snapshots) {
        const current = await snapshot(entry.target.identity.path);
        const expected = entry.target.identity;
        if (current.realPath !== expected.realPath || current.device !== expected.device || current.inode !== expected.inode || current.mode !== expected.mode || !current.bytes.equals(entry.original)) {
          throw new PlanError('TARGET_CHANGED', 'Target changed before plan publication.', 'runtime-error', expected.path);
        }
      }
      // mkdir is the no-replace reservation. rename alone could overwrite an empty output.
      try { await mkdir(directory, { mode: 0o700 }); } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new PlanError('OUTPUT_EXISTS', 'Refusing to overwrite an existing plan path.', 'runtime-error', directory);
        throw error;
      }
      const reserved = await lstat(directory, { bigint: true });
      reservation = { device: reserved.dev, inode: reserved.ino };
      await rename(staging, join(directory, 'contents'));
      requirePlan(await ownsReservation(), 'Output reservation changed during publication.');
      await syncDirectory(directory);
      // Readers accept a plan only once this complete marker is atomically linked.
      const marker = join(directory, '.complete-staging');
      await writeExclusive(marker, JSON.stringify({ formatVersion: 1, id: manifest.id, contentHash: manifest.contentHash }) + '\n');
      requirePlan(await ownsReservation(), 'Output reservation changed before completion.');
      await link(marker, join(directory, 'complete.json'));
      await rm(marker);
      await syncDirectory(directory);
      await syncDirectory(parent);
      complete = true;
      return {
        schemaVersion: 1, command: 'prepare', outcome: 'success', exitCode: EXIT_CODES.success,
        data: { pluginRoot, plan: { id: manifest.id, directory, manifestPath: join(directory, 'contents/manifest.json'), targetCount: snapshots.length }, pluginFiles: 'unchanged', runtime: 'not-verified' },
        diagnostics,
      };
    } finally {
      await rm(staging, { recursive: true, force: true });
      if (!complete && await ownsReservation()) await rm(directory, { recursive: true, force: true });
    }
  } catch (error) {
    const failed = failure(error);
    return {
      schemaVersion: 1, command: 'prepare', outcome: failed.outcome,
      exitCode: failed.outcome === 'usage-error' ? EXIT_CODES.usageError : failed.outcome === 'incompatible' ? EXIT_CODES.incompatible : EXIT_CODES.runtimeError,
      data: null, diagnostics: [...diagnostics, failed.diagnostic],
    };
  }
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  requirePlan(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected a plan object.');
  const record = value as Record<string, unknown>;
  requirePlan(Object.keys(record).sort().join(',') === [...keys].sort().join(','), 'Unknown or missing plan fields.');
  return record;
}

function text(value: unknown): asserts value is string {
  requirePlan(typeof value === 'string' && value.length > 0 && !value.includes('\0'), 'Expected a nonempty string.');
}

function integer(value: unknown): asserts value is number {
  requirePlan(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0, 'Expected a nonnegative safe integer.');
}

function absolute(value: unknown): asserts value is string {
  text(value);
  requirePlan(isAbsolute(value) && resolve(value) === value, 'Target paths must be normalized absolute paths.');
}

function sourceRange(value: unknown): void {
  const record = object(value, ['start', 'end', 'unit']);
  integer(record.start);
  integer(record.end);
  requirePlan(record.unit === 'utf16' && record.start < record.end, 'Invalid UTF-16 source range.');
}

function artifactDescriptor(value: unknown, file: string): void {
  const record = object(value, ['file', 'size', 'sha256']);
  requirePlan(record.file === file, 'Artifact names must use fixed relative basenames; path escape is forbidden.');
  integer(record.size);
  requirePlan(typeof record.sha256 === 'string' && /^[0-9a-f]{64}$/.test(record.sha256), 'Invalid artifact SHA-256.');
}

function validateManifest(value: unknown): asserts value is PlanManifest {
  const manifest = object(value, ['formatVersion', 'patternVersion', 'id', 'pluginRoot', 'runtime', 'pluginFiles', 'targets', 'contentHash']);
  const legacy = manifest.formatVersion === 1 && manifest.patternVersion === 'site-status-v1';
  const selection = manifest.formatVersion === 2 && manifest.patternVersion === 'site-status-selection-v1';
  requirePlan(legacy || selection, 'Unsupported plan format or pattern version.');
  requirePlan(typeof manifest.id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(manifest.id), 'Invalid plan identity.');
  requirePlan(typeof manifest.contentHash === 'string' && /^[0-9a-f]{64}$/.test(manifest.contentHash), 'Invalid manifest digest.');
  absolute(manifest.pluginRoot);
  requirePlan(manifest.runtime === 'not-verified' && manifest.pluginFiles === 'unchanged', 'Invalid preparation evidence claims.');
  requirePlan(Array.isArray(manifest.targets) && manifest.targets.length > 0, 'Plan must contain targets.');
  const ids = new Set<string>();
  const paths = new Set<string>();
  const realPaths = new Set<string>();
  const files = new Set<string>();
  for (const [index, item] of manifest.targets.entries()) {
    const target = object(item, ['id', 'identity', 'original', 'patched', 'localDiff', 'evidence', 'expression', ...(selection ? ['patternVersion'] : [])]);
    const pattern = legacy ? 'site-status-v1' : target.patternVersion;
    requirePlan(pattern === 'site-status-v1' || pattern === 'site-status-deferred-v1', 'Unsupported target pattern version.');
    const identity = object(target.identity, ['pluginRoot', 'plugin', 'version', 'path', 'realPath', 'device', 'inode', 'mode']);
    requirePlan(identity.pluginRoot === manifest.pluginRoot, 'Target root identity mismatch.');
    requirePlan(identity.plugin === 'browser' || identity.plugin === 'chrome', 'Invalid plugin identity.');
    text(identity.version);
    requirePlan(!['.', '..'].includes(identity.version) && !identity.version.includes('/') && !identity.version.includes('\\'), 'Invalid version path identity.');
    absolute(identity.path);
    absolute(identity.realPath);
    requirePlan(identity.path === join(manifest.pluginRoot, identity.plugin, identity.version, 'scripts/browser-service.mjs'), 'Target identity does not match plugin root/version/path.');
    requirePlan(typeof identity.device === 'string' && /^(0|[1-9][0-9]*)$/.test(identity.device) &&
      typeof identity.inode === 'string' && /^[1-9][0-9]*$/.test(identity.inode), 'Invalid filesystem identity.');
    integer(identity.mode);
    requirePlan(identity.mode <= 0o7777, 'Invalid target permissions.');
    requirePlan(typeof target.id === 'string' && target.id === hash(canonical(identity)), 'Target identity digest mismatch.');
    const fileKey = `${identity.device}:${identity.inode}`;
    requirePlan(!ids.has(target.id) && !paths.has(identity.path) && !realPaths.has(identity.realPath) && !files.has(fileKey), 'Duplicate or aliased target identity.');
    ids.add(target.id);
    paths.add(identity.path);
    realPaths.add(identity.realPath);
    files.add(fileKey);
    const fileNames = names(index);
    artifactDescriptor(target.original, fileNames.original);
    artifactDescriptor(target.patched, fileNames.patched);
    artifactDescriptor(target.localDiff, fileNames.localDiff);
    const expression = object(target.expression, ['range', 'before', 'after']);
    sourceRange(expression.range);
    text(expression.before);
    text(expression.after);
    const kinds = pattern === 'site-status-v1' ? ['source', 'transport', 'response', 'predicate', 'consumption'] : ['initialization', 'predicate', 'source', 'transport', 'response', 'receiver', 'cache', 'consumption'];
    requirePlan(Array.isArray(target.evidence) && target.evidence.length === kinds.length, 'Invalid structural evidence.');
    for (const [evidenceIndex, entry] of target.evidence.entries()) {
      const evidence = object(entry, ['kind', 'range', 'description']);
      requirePlan(evidence.kind === kinds[evidenceIndex], 'Invalid evidence kind or order for target pattern.');
      sourceRange(evidence.range);
      text(evidence.description);
    }
  }
}

/** Reject duplicate JSON keys instead of silently accepting the last identity. */
function parsePlanJSON(bytes: Buffer): unknown {
  const source = decode(bytes);
  const result: unknown = JSON.parse(source);
  const program = parse(`(${source})`, { ecmaVersion: 2022 }) as unknown as E.Program;
  function inspect(node: E.Node): void {
    if (node.type === 'ObjectExpression') {
      const keys = new Set<string>();
      for (const entry of node.properties) {
        requirePlan(entry.type === 'Property', 'Invalid JSON property.');
        const key = entry.key.type === 'Literal' ? String(entry.key.value) : entry.key.type === 'Identifier' ? entry.key.name : '';
        requirePlan(!keys.has(key), 'Duplicate JSON key.');
        keys.add(key);
        inspect(entry.value);
      }
    } else if (node.type === 'ArrayExpression') {
      for (const entry of node.elements) if (entry) inspect(entry);
    }
  }
  const statement = program.body[0];
  requirePlan(statement?.type === 'ExpressionStatement', 'Invalid plan JSON.');
  inspect(statement.expression);
  return result;
}

async function regularBytes(path: string): Promise<Buffer> {
  const metadata = await lstat(path, { bigint: true });
  requirePlan(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1n, 'Plan artifacts must be unaliased regular files.');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    requirePlan(opened.dev === metadata.dev && opened.ino === metadata.ino, 'Plan artifact changed while opening.');
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    requirePlan(opened.size === after.size && opened.mtimeNs === after.mtimeNs && opened.ctimeNs === after.ctimeNs, 'Plan artifact changed while reading.');
    return bytes;
  } finally { await handle.close(); }
}

/**
 * Validates an untrusted review plan without touching current plugin contents.
 * Rechecks recorded identity syntax, artifact hashes and a freshly derived structural transform.
 * Historical targets may have been removed; loading artifacts never resolves live target paths.
 * Current file/provenance validation belongs to the transaction preflight.
 */
export async function loadPlan(directory: string): Promise<LoadedPlan> {
  const path = resolve(directory);
  requirePlan(await realpath(path) === path && (await lstat(path)).isDirectory(), 'Plan directory must be canonical.');
  const contents = join(path, 'contents');
  requirePlan(!(await lstat(contents)).isSymbolicLink() && (await lstat(contents)).isDirectory(), 'Invalid plan contents directory.');
  const marker = object(parsePlanJSON(await regularBytes(join(path, 'complete.json'))), ['formatVersion', 'id', 'contentHash']);
  const manifest: unknown = parsePlanJSON(await regularBytes(join(contents, 'manifest.json')));
  validateManifest(manifest);
  const { contentHash, ...base } = manifest;
  requirePlan(hash(canonical(base)) === contentHash, 'Manifest integrity mismatch.');
  requirePlan(marker.formatVersion === 1 && marker.id === manifest.id && marker.contentHash === contentHash, 'Plan is not completely published.');
  const expectedFiles = ['manifest.json', ...manifest.targets.flatMap((target) => [target.original.file, target.patched.file, target.localDiff.file])].sort();
  requirePlan(canonical((await readdir(contents)).sort()) === canonical(expectedFiles), 'Unexpected or missing plan artifacts.');
  const targets: LoadedPlan['targets'] = [];
  for (const target of manifest.targets) {
    const original = await regularBytes(join(contents, target.original.file));
    const patched = await regularBytes(join(contents, target.patched.file));
    const diff = await regularBytes(join(contents, target.localDiff.file));
    for (const [artifact, bytes] of [[target.original, original], [target.patched, patched], [target.localDiff, diff]] as const) {
      requirePlan(artifact.size === bytes.length && artifact.sha256 === hash(bytes), 'Artifact size or SHA-256 mismatch.');
    }
    const transformed = transformSource(decode(original));
    requirePlan(transformed.transformation, 'Original no longer satisfies supported structural transformation.');
    const pattern = manifest.formatVersion === 1 ? 'site-status-v1' : (target as PlanTarget & { patternVersion: PatternVersion }).patternVersion;
    requirePlan(transformed.analysis.patternVersion === pattern, 'Target pattern differs from rederived transformation.');
    const change = transformed.transformation;
    requirePlan(patched.equals(Buffer.from(change.patchedSource, 'utf8')), 'Patched artifact differs from rederived transformation.');
    requirePlan(diff.equals(Buffer.from(change.localDiff, 'utf8')), 'Localized diff differs from rederived transformation.');
    requirePlan(canonical(target.expression) === canonical({ range: change.range, before: change.before, after: change.after }), 'Expression differs from rederived transformation.');
    requirePlan(canonical(target.evidence) === canonical(transformed.analysis.evidence), 'Structural evidence differs from rederived transformation.');
    targets.push({ target, original, patched });
  }
  return { directory: path, manifest, targets };
}
