import type { PlanTarget } from '../src/plan.js';
import type { DetectionResult, PreparationResult, OperationResult } from '../src/result.js';
type Output<C extends string> = C extends 'detect' ? DetectionResult : C extends 'prepare' ? PreparationResult : OperationResult;
function parseOutput<C extends string>(text: string, command: C): Output<C> { const parsed: Output<C> = JSON.parse(text); assert.equal(parsed.command, command); return parsed; }
type MutableTarget = Omit<PlanTarget, 'identity'> & {identity: PlanTarget['identity']; patternVersion?: string};
interface MutableManifest {id: string; contentHash: string; formatVersion: number; patternVersion: string; targets: MutableTarget[]; extra?: boolean}
function parseManifest(text: string): MutableManifest { return JSON.parse(text); }
function required<T>(value: T): NonNullable<T> { assert.ok(value !== null && value !== undefined, 'Expected test value to be present'); return value; }
import type { TestContext } from 'node:test';
import { sourceFixture } from './helpers/paths.js';
import assert from 'node:assert/strict';
import { runCli } from './helpers/cli.js';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const darwin = fileURLToPath(new URL('./fixtures/darwin.cjs', import.meta.url));
const source = await readFile(sourceFixture('site-status.js.txt'), 'utf8');
const digest = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const { loadPlan } = await import('../src/plan.js');

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

async function rewriteManifest(directory: string, mutate: (manifest: MutableManifest) => void | Promise<void>) {
  const path = join(directory, 'contents/manifest.json');
  const manifest = parseManifest(await readFile(path, 'utf8'));
  await mutate(manifest);
  const { contentHash: ignored, ...body } = manifest;
  void ignored;
  manifest.contentHash = digest(canonical(body));
  await writeFile(path, JSON.stringify(manifest));
  await writeFile(join(directory, 'complete.json'), JSON.stringify({ formatVersion: 1, id: manifest.id, contentHash: manifest.contentHash }));
}

async function sandbox(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codex-prepare-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'home'));
  await mkdir(join(directory, 'store'));
  return directory;
}

async function artifact(root: string, plugin: string = 'browser', version: string = 'unknown', text = source) {
  const scripts = join(root, plugin, version, 'scripts');
  await mkdir(scripts, { recursive: true });
  const path = join(scripts, 'browser-service.mjs');
  await writeFile(path, text);
  return path;
}

function run(directory: string, args: string[], fixture = darwin, extraEnv: NodeJS.ProcessEnv = {}) {
  return runCli(['prepare', '--plugin-root', join(directory, 'plugins'), ...args, '--json'], { directory, fixture, env: extraEnv });
}

test('prepare publishes a complete verifiable review plan for one explicit target without changing plugin or operation store', async (t: TestContext) => {
  const directory = await sandbox(t);
  const target = await artifact(join(directory, 'plugins'));
  const output = join(directory, 'review-plan');
  const result = run(directory, ['--target', target, '--output', output]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const response = parseOutput(result.stdout, 'prepare');
  assert.equal(response.command, 'prepare');
  assert.equal(response.outcome, 'success');
  assert.equal(required(response.data).plan.directory, output);
  assert.equal(required(response.data).runtime, 'not-verified');
  assert.equal(required(response.data).pluginFiles, 'unchanged');
  const manifest = parseManifest(await readFile(required(response.data).plan.manifestPath, 'utf8'));
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.patternVersion, 'site-status-v1');
  assert.equal(manifest.targets.length, 1);
  const entry = manifest.targets[0];
  assert.equal(required(entry).identity.path, target);
  assert.equal(required(entry).identity.realPath, target);
  assert.equal(required(entry).identity.plugin, 'browser');
  assert.equal(required(entry).identity.version, 'unknown');
  assert.equal(required(entry).evidence.length, 5);
  assert.equal(required(entry).expression.before, 'body');
  assert.equal(required(entry).expression.range.unit, 'utf16');
  const contents = join(output, 'contents');
  const original = await readFile(join(contents, required(entry).original.file));
  const patched = await readFile(join(contents, required(entry).patched.file));
  assert.deepEqual(original, Buffer.from(source));
  assert.equal(required(entry).original.sha256, digest(original));
  assert.equal(required(entry).patched.sha256, digest(patched));
  assert.equal(required(entry).original.size, original.length);
  assert.equal(required(entry).patched.size, patched.length);
  assert.match(await readFile(join(contents, required(entry).localDiff.file), 'utf8'), /agent:false/);
  assert.equal(await readFile(target, 'utf8'), source);
  assert.deepEqual(await readdir(join(directory, 'home')), []);
  assert.deepEqual(await readdir(join(directory, 'store')), []);
  assert.deepEqual((await readdir(directory)).sort(), ['home', 'plugins', 'review-plan', 'store']);
});

test('explicit one/multiple targets preserve selection across versions; all-compatible filters unsupported sources', async (t: TestContext) => {
  const directory = await sandbox(t);
  const root = join(directory, 'plugins');
  const first = await artifact(root, 'browser', '100');
  const second = await artifact(root, 'browser', '9');
  const third = await artifact(root, 'chrome', 'future');
  await artifact(root, 'chrome', 'unsupported', 'const absent = true;');
  const selected = run(directory, ['--target', third, '--target', first, '--output', join(directory, 'selected')]);
  assert.equal(selected.status, 0, selected.stdout + selected.stderr);
  const selectedManifest = parseManifest(await readFile(required(parseOutput(selected.stdout, 'prepare').data).plan.manifestPath, 'utf8'));
  assert.deepEqual(selectedManifest.targets.map((entry) => entry.identity.path), [third, first]);
  const all = run(directory, ['--all-compatible', '--output', join(directory, 'all')]);
  assert.equal(all.status, 0, all.stdout + all.stderr);
  const allManifest = parseManifest(await readFile(required(parseOutput(all.stdout, 'prepare').data).plan.manifestPath, 'utf8'));
  assert.deepEqual(allManifest.targets.map((entry) => entry.identity.path), [first, second, third]);
  assert.equal(required(parseOutput(all.stdout, 'prepare').diagnostics[0]).code, 'NO_TARGET');
  assert.equal(required(parseOutput(all.stdout, 'prepare').diagnostics[0]).severity, 'warning');
  for (const path of [first, second, third]) assert.equal(await readFile(path, 'utf8'), source);
});

test('selection errors and incompatible explicit selection publish nothing', async (t: TestContext) => {
  const directory = await sandbox(t);
  const root = join(directory, 'plugins');
  const good = await artifact(root);
  const bad = await artifact(root, 'chrome', 'unsupported', 'const absent = true;');
  const output = join(directory, 'must-not-exist');
  for (const [selection, status, code] of [
    [[], 2, 'INVALID_ARGUMENTS'],
    [['--target', good, '--all-compatible'], 2, 'INVALID_ARGUMENTS'],
    [['--target', good, '--target', good], 2, 'INVALID_ARGUMENTS'],
    [['--target', 'relative-path'], 2, 'INVALID_ARGUMENTS'],
    [['--target', join(directory, 'absent')], 2, 'TARGET_NOT_FOUND'],
    [['--target', good, '--target', bad], 3, 'TARGET_INCOMPATIBLE'],
  ] satisfies [string[], number, string][]) {
    const result = run(directory, [...selection, '--output', output]);
    assert.equal(result.status, status, result.stdout + result.stderr);
    assert.equal(required(parseOutput(result.stdout, 'prepare').diagnostics.at(-1)).code, code);
    assert.equal(result.stderr, '');
    assert.ok(!(await readdir(directory)).includes('must-not-exist'));
  }
  await rm(join(root, 'browser'), { recursive: true });
  const empty = run(directory, ['--all-compatible', '--output', output]);
  assert.equal(empty.status, 3);
  assert.equal(required(parseOutput(empty.stdout, 'prepare').diagnostics.at(-1)).code, 'NO_COMPATIBLE_TARGETS');
  assert.ok(!(await readdir(directory)).includes('must-not-exist'));
});

test('duplicate symlink and hardlink identities are rejected before publishing any plan', async (t: TestContext) => {
  const directory = await sandbox(t);
  const root = join(directory, 'plugins');
  const original = await artifact(root, 'browser', 'one');
  await symlink(join(root, 'browser', 'one'), join(root, 'browser', 'alias'));
  const alias = join(root, 'browser', 'alias', 'scripts/browser-service.mjs');
  const hardlink = await artifact(root, 'chrome', 'hardlink');
  await rm(hardlink);
  await link(original, hardlink);
  for (const second of [alias, hardlink]) {
    const result = run(directory, ['--target', original, '--target', second, '--output', join(directory, 'rejected')]);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.equal(required(parseOutput(result.stdout, 'prepare').diagnostics.at(-1)).code, 'DUPLICATE_TARGET');
  }
  assert.deepEqual((await readdir(directory)).sort(), ['home', 'plugins', 'store']);
});

test('prepare preserves runtime discovery failures and never silently filters unavailable artifacts', async (t: TestContext) => {
  const directory = await sandbox(t);
  const good = await artifact(join(directory, 'plugins'));
  await mkdir(join(directory, 'plugins/chrome/missing/scripts'), { recursive: true });
  for (const selection of [['--target', good], ['--all-compatible']]) {
    const result = run(directory, [...selection, '--output', join(directory, 'rejected')]);
    assert.equal(result.status, 1);
    assert.equal(required(parseOutput(result.stdout, 'prepare').diagnostics.at(-1)).code, 'ARTIFACT_UNAVAILABLE');
  }
  assert.deepEqual((await readdir(directory)).sort(), ['home', 'plugins', 'store']);
});

test('existing output directories, files and symlinks are never replaced', async (t: TestContext) => {
  const directory = await sandbox(t);
  const target = await artifact(join(directory, 'plugins'));
  const empty = join(directory, 'empty');
  const existing = join(directory, 'existing');
  const alias = join(directory, 'alias');
  await mkdir(empty);
  await writeFile(existing, 'preserve this');
  await symlink(existing, alias);
  for (const output of [empty, existing, alias]) {
    const result = run(directory, ['--target', target, '--output', output]);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.equal(required(parseOutput(result.stdout, 'prepare').diagnostics.at(-1)).code, 'OUTPUT_EXISTS');
  }
  assert.deepEqual(await readdir(empty), []);
  assert.equal(await readFile(existing, 'utf8'), 'preserve this');
  assert.equal(await readFile(alias, 'utf8'), 'preserve this');
  assert.ok(!(await readdir(directory)).some((name) => name.includes('staging')));
});

test('loader independently rederives the transform and rejects rehashed malicious patches', async (t: TestContext) => {
  const directory = await sandbox(t);
  const target = await artifact(join(directory, 'plugins'));
  const output = join(directory, 'review');
  const result = run(directory, ['--target', target, '--output', output]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const loaded = await loadPlan(output);
  assert.equal(loaded.targets.length, 1);
  assert.deepEqual(required(loaded.targets[0]).original, Buffer.from(source));
  await rewriteManifest(output, async (manifest) => {
    const entry = required(manifest.targets[0]).patched;
    const bytes = Buffer.from(source.replace("'agent'", "'comment'"));
    await writeFile(join(output, 'contents', entry.file), bytes);
    entry.size = bytes.length;
    entry.sha256 = digest(bytes);
  });
  await assert.rejects(loadPlan(output), /rederived|transformation/i);
});

test('versioned loader rejects malformed, escaped, duplicated and tampered identities and artifacts', async (t: TestContext) => {
  const directory = await sandbox(t);
  const first = await artifact(join(directory, 'plugins'), 'browser', 'one', '﻿/* 中文 😀 */\r\n' + source.replaceAll('\n', '\r\n'));
  const second = await artifact(join(directory, 'plugins'), 'chrome', 'two');
  const mutations: [string, (manifest: MutableManifest, directory: string) => void | Promise<void>][] = [
    ['original hash mismatch', async (manifest, output) => {
      await writeFile(join(output, 'contents', required(manifest.targets[0]).original.file), source + '\n// changed artifact');
    }],
    ['patched hash mismatch', async (manifest, output) => {
      await writeFile(join(output, 'contents', required(manifest.targets[0]).patched.file), source);
    }],
    ['unsupported version', (manifest) => { manifest.formatVersion = 99; }],
    ['unknown fields', (manifest) => { manifest.extra = true; }],
    ['missing identity', (manifest) => { Reflect.deleteProperty(required(manifest.targets[0]), 'identity'); }],
    ['duplicate identity', (manifest) => { manifest.targets[1] = JSON.parse(JSON.stringify(manifest.targets[0])); }],
    ['artifact escape', (manifest) => { required(manifest.targets[0]).original.file = '../../outside.mjs'; }],
    ['absolute artifact', (manifest) => { required(manifest.targets[0]).patched.file = '/tmp/outside.mjs'; }],
    ['target path tamper', (manifest) => { required(manifest.targets[0]).identity.path = second; }],
    ['canonical identity tamper', (manifest) => {
      const entry = manifest.targets[0];
      required(entry).identity.realPath = second;
      required(entry).id = digest(canonical(required(entry).identity));
    }],
    ['version escape', (manifest) => { required(manifest.targets[0]).identity.version = '../outside'; }],
    ['invalid inode', (manifest) => { required(manifest.targets[0]).identity.inode = '-1'; }],
    ['range tamper', (manifest) => { required(manifest.targets[0]).expression.range.start = 0; }],
    ['evidence tamper', (manifest) => { required(required(manifest.targets[0]).evidence[0]).description = 'forged proof'; }],
    ['diff tamper', async (manifest, output) => {
      const entry = required(manifest.targets[0]).localDiff;
      await writeFile(join(output, 'contents', entry.file), 'forged diff');
      entry.size = 11;
      entry.sha256 = digest('forged diff');
    }],
    ['invalid UTF8 original', async (manifest, output) => {
      const entry = required(manifest.targets[0]).original;
      const bytes = Buffer.from([0xff, 0xfe]);
      await writeFile(join(output, 'contents', entry.file), bytes);
      entry.size = bytes.length;
      entry.sha256 = digest(bytes);
    }],
  ];
  for (const [index, [label, mutate]] of mutations.entries()) {
    const output = join(directory, `case-${index}`);
    const result = run(directory, ['--target', first, '--target', second, '--output', output]);
    assert.equal(result.status, 0, label + result.stdout + result.stderr);
    await rewriteManifest(output, (manifest) => mutate(manifest, output));
    await assert.rejects(loadPlan(output), () => true, label);
  }
  const output = join(directory, 'raw');
  assert.equal(run(directory, ['--target', first, '--output', output]).status, 0);
  const manifestPath = join(output, 'contents/manifest.json');
  const originalManifest = await readFile(manifestPath, 'utf8');
  await writeFile(manifestPath, originalManifest.replace('"formatVersion": 1,', '"formatVersion": 1,"formatVersion": 1,'));
  await assert.rejects(loadPlan(output), /Duplicate JSON key/);
  await writeFile(manifestPath, originalManifest);
  const markerPath = join(output, 'complete.json');
  const originalMarker = await readFile(markerPath, 'utf8');
  await writeFile(markerPath, JSON.stringify({ formatVersion: 1, id: 'forged', contentHash: '0'.repeat(64) }));
  await assert.rejects(loadPlan(output), /not completely published/);
  await writeFile(markerPath, originalMarker);
  await writeFile(manifestPath, originalManifest.replace('"runtime": "not-verified"', '"runtime": "verified"'));
  await assert.rejects(loadPlan(output));
  await writeFile(manifestPath, originalManifest);
  await rm(markerPath);
  await assert.rejects(loadPlan(output));
});

test('loader refuses symlinked artifacts and unaccounted files', async (t: TestContext) => {
  const directory = await sandbox(t);
  const target = await artifact(join(directory, 'plugins'));
  const output = join(directory, 'review');
  assert.equal(run(directory, ['--target', target, '--output', output]).status, 0);
  const loaded = await loadPlan(output);
  const original = join(output, 'contents', required(loaded.manifest.targets[0]).original.file);
  await rm(original);
  await symlink(target, original);
  await assert.rejects(loadPlan(output), /unaliased regular files/);
  await rm(original);
  await writeFile(original, source);
  await writeFile(join(output, 'contents', 'unaccounted'), 'unexpected');
  await assert.rejects(loadPlan(output), /Unexpected or missing/);
});

test('preparation and publication failures expose no complete plan and preserve competing output owners', async (t: TestContext) => {
  const directory = await sandbox(t);
  const root = join(directory, 'plugins');
  const first = await artifact(root, 'browser', 'one');
  const second = await artifact(root, 'chrome', 'two');
  const fixture = fileURLToPath(new URL('./fixtures/prepare-fs.cjs', import.meta.url));
  for (const fault of ['second-artifact', 'publish-marker', 'race-output', 'replaced-reservation']) {
    const output = join(directory, fault);
    const result = run(directory, ['--target', first, '--target', second, '--output', output], fixture, {
      CODEX_TEST_PREPARE_FAULT: fault, CODEX_TEST_PREPARE_OUTPUT: output,
    });
    assert.equal(result.status, 1, `${fault}: ${result.stdout} ${result.stderr}`);
    await assert.rejects(loadPlan(output));
    if (fault === 'race-output' || fault === 'replaced-reservation') {
      assert.equal(await readFile(join(output, 'other-owner'), 'utf8'), fault === 'race-output' ? 'preserve competing output' : 'preserve replacement');
      assert.ok(!(await readdir(output)).includes('complete.json'));
    } else {
      assert.ok(!(await readdir(directory)).includes(fault));
    }
  }
  assert.equal(await readFile(first, 'utf8'), source);
  assert.equal(await readFile(second, 'utf8'), source);
  assert.ok(!(await readdir(directory)).some((name) => name.includes('.staging-')));
});

test('source changes during preparation fail before publication without undoing external edits', async (t: TestContext) => {
  const directory = await sandbox(t);
  const target = await artifact(join(directory, 'plugins'));
  const output = join(directory, 'review');
  const fixture = fileURLToPath(new URL('./fixtures/prepare-fs.cjs', import.meta.url));
  const result = run(directory, ['--target', target, '--output', output], fixture, {
    CODEX_TEST_PREPARE_FAULT: 'source-changed', CODEX_TEST_PREPARE_OUTPUT: output, CODEX_TEST_PREPARE_TARGET: target,
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(required(parseOutput(result.stdout, 'prepare').diagnostics.at(-1)).code, 'TARGET_CHANGED');
  assert.equal(await readFile(target, 'utf8'), source + '\n// changed during preparation\n');
  assert.deepEqual((await readdir(directory)).sort(), ['home', 'plugins', 'store']);
});

test('UTF-8 BOM, CRLF and non-BMP artifacts survive public prepare and verified load intact', async (t: TestContext) => {
  const directory = await sandbox(t);
  const text = '﻿/* 中文 😀 */\r\n' + source.replaceAll('\n', '\r\n');
  const target = await artifact(join(directory, 'plugins'), 'browser', 'unicode', text);
  const output = join(directory, 'unicode-plan');
  const result = run(directory, ['--target', target, '--output', output]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const loaded = await loadPlan(output);
  const entry = loaded.targets[0];
  assert.deepEqual(required(entry).original, Buffer.from(text));
  assert.deepEqual(required(entry).patched.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
  const range = required(entry).target.expression.range;
  const prefix = Buffer.from(text.slice(0, range.start));
  const suffix = Buffer.from(text.slice(range.end));
  assert.deepEqual(required(entry).patched.subarray(0, prefix.length), prefix);
  assert.deepEqual(required(entry).patched.subarray(required(entry).patched.length - suffix.length), suffix);
  assert.equal(required(entry).target.original.size, Buffer.byteLength(text));
  assert.equal(await readFile(target, 'utf8'), text);
});

test('prepare help and human output state explicit selection and unchanged files; invalid command options stay usage errors', async (t: TestContext) => {
  const directory = await sandbox(t);
  const target = await artifact(join(directory, 'plugins'));
  const execute = (args: string[]) => runCli(args, { directory });
  const help = execute(['prepare', '--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--all-compatible/);
  assert.match(help.stdout, /--target/);
  assert.match(help.stdout, /not authentication/);
  const human = execute(['prepare', '--plugin-root', join(directory, 'plugins'), '--target', target, '--output', join(directory, 'human')]);
  assert.equal(human.status, 0, human.stdout + human.stderr);
  assert.match(human.stdout, /Review plan:/);
  assert.match(human.stdout, /plugin files unchanged/);
  assert.match(human.stdout, /Runtime: not-verified/);
  for (const args of [
    ['detect', '--target', target],
    ['detect', '--output', join(directory, 'invalid')],
    ['prepare', '--target', target],
    ['prepare', '--all-compatible', '--output='],
    ['prepare', '--all-compatible', '--output', 'one', '--output', 'two'],
    ['prepare', '--all-compatible', '--all-compatible', '--output', 'one'],
  ]) {
    const result = execute([...args, '--json']);
    assert.equal(result.status, 2, result.stdout + result.stderr);
    assert.equal(parseOutput(result.stdout, required(args[0])).outcome, 'usage-error');
    assert.equal(result.stderr, '');
  }
});
