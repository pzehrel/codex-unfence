import assert from 'node:assert/strict';
import { runCli, startCli } from './helpers/cli.mjs';
import { packPackage, installPackage } from './helpers/npm-package.mjs';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout } from 'node:timers';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const repository = fileURLToPath(new URL('..', import.meta.url));
// Explicit external --require fixtures affect test children only. They are never packaged.
const fixture = fileURLToPath(new URL('./fixtures/transaction-boundaries.cjs', import.meta.url));
const source = await readFile(new URL('./fixtures/site-status.js.txt', import.meta.url), 'utf8');
const outcomes = ['success', 'runtime-error', 'usage-error', 'incompatible', 'conflict'];

function result(child, command, code = 0) {
  assert.equal(child.status, code, child.stdout + child.stderr);
  assert.equal(child.stderr, '');
  const output = JSON.parse(child.stdout);
  assert.deepEqual(Object.keys(output).sort(), ['command', 'data', 'diagnostics', 'exitCode', 'outcome', 'schemaVersion']);
  assert.equal(output.schemaVersion, 1);
  assert.equal(output.command, command);
  assert.equal(output.exitCode, code);
  assert.equal(output.outcome, outcomes[code]);
  assert.ok(Array.isArray(output.diagnostics));
  for (const diagnostic of output.diagnostics) {
    assert.equal(typeof diagnostic.code, 'string');
    assert.ok(['info', 'warning', 'error'].includes(diagnostic.severity));
    assert.equal(typeof diagnostic.message, 'string');
  }
  if (output.data) assert.equal(output.data.runtime, 'not-verified');
  return output;
}

async function sandbox(t, installation) {
  const directory = await realpath(await mkdtemp(join(installation.directory, 'scenario-')));
  const root = join(directory, 'plugins');
  const targets = [
    join(root, 'browser/100/scripts/browser-service.mjs'),
    join(root, 'browser/9/scripts/browser-service.mjs'),
    join(root, 'chrome/future/scripts/browser-service.mjs'),
  ];
  for (const path of targets) {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, source, { mode: 0o640 });
  }
  t.after(() => rm(directory, { recursive: true, force: true }));
  const run = (args, { json = true, extraEnv = {} } = {}) => runCli(
    [...args, ...(json ? ['--json'] : [])], { directory, fixture, binary: installation.binary, env: extraEnv });
  const plan = join(directory, 'review-plan');
  const store = join(directory, 'private-store');
  return { directory, root, targets, plan, store, run, binary: installation.binary };
}

function prepare(box) {
  const output = result(box.run(['prepare', '--plugin-root', box.root, '--all-compatible', '--output', box.plan]), 'prepare');
  assert.equal(output.data.pluginFiles, 'unchanged');
  assert.equal(output.data.plan.targetCount, 3);
  return output;
}

const operationArgs = (box, command) => command === 'recover'
  ? ['recover', '--store', box.store]
  : [command, '--plan', box.plan, '--store', box.store];
const operation = (box, command, options) => box.run(operationArgs(box, command), options);

async function interrupt(t, box, command, boundary, target) {
  const child = startCli([...operationArgs(box, command), '--json'], {
    directory: box.directory, binary: box.binary, fixture, env: { CODEX_TEST_PAUSE: boundary, CODEX_TEST_TARGET: target },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let text = '';
  child.stdout.on('data', (chunk) => { text += chunk; });
  child.stderr.on('data', (chunk) => { text += chunk; });
  await Promise.race([
    once(child, 'message').then(([message]) => assert.equal(message.boundary, boundary)),
    once(child, 'exit').then(([code, signal]) => { throw new Error(`Installed CLI exited before ${boundary}: ${code}/${signal} ${text}`); }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`No installed CLI boundary ${boundary}: ${text}`)), 10_000); timer.unref(); }),
  ]);
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  assert.deepEqual(await exited, [null, 'SIGKILL']);
}

test('installed tarball public bin satisfies package and full CLI acceptance without source imports or Codex', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'codex-package-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const directory = await realpath(temporary);
  // A build directory may retain local evidence or stale build outputs. Neither belongs in delivery.
  const privateArtifact = join(repository, 'dist/package-acceptance-private-plan.json');
  await writeFile(privateArtifact, '{"syntheticLocalState":true}');
  t.after(() => rm(privateArtifact, { force: true }));
  const pack = packPackage(directory);
  assert.equal(pack.status, 0, pack.stderr);
  const [output] = JSON.parse(pack.stdout);
  const files = output.files.map((file) => file.path);
  assert.deepEqual(files.filter((path) => !path.startsWith('node_modules/')).sort(), [
    'README.md', 'dist/analysis.js', 'dist/cli.js', 'dist/deferred-analysis.js', 'dist/dependency-analysis.js', 'dist/dependency-contracts.js', 'dist/dependency-source.js', 'dist/discovery.js', 'dist/handle-provenance.js', 'dist/integrity.js', 'dist/plan.js', 'dist/processes.js', 'dist/resource-provenance.js', 'dist/result.js',
    'dist/transaction-locks.js', 'dist/transaction-storage.js', 'dist/transactions.js', 'package.json',
  ]);
  const dependencies = new Set();
  for (const path of files.filter((path) => path.startsWith('node_modules/'))) {
    assert.match(path, /^node_modules\/(acorn|eslint-scope|esrecurse|estraverse)\//);
    dependencies.add(path.split('/')[1]);
  }
  assert.deepEqual([...dependencies].sort(), ['acorn', 'eslint-scope', 'esrecurse', 'estraverse']);
  const prefix = join(directory, 'installation');
  const install = installPackage(directory, prefix, join(directory, output.filename));
  assert.equal(install.status, 0, install.stderr);
  const binary = join(prefix, 'bin/codex-browser-patch');
  const installed = join(prefix, 'lib/node_modules/codex-browser-liberation-patch');
  assert.equal(await realpath(binary), join(installed, 'dist/cli.js'));
  const metadata = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(metadata.engines.node, '>=22.13.0');
  assert.deepEqual(metadata.bin, { 'codex-browser-patch': 'dist/cli.js' });
  await assert.rejects(access(join(installed, 'src')));
  await assert.rejects(access(join(installed, 'tests')));
  const installation = { directory, binary };

  await t.test('installed pure analysis measures explicit inert bytes without granting an unknown dependency contract', async () => {
    const { analyzeSource } = await import(pathToFileURL(join(installed, 'dist/analysis.js')).href);
    const { createHash } = await import('node:crypto');
    const text = await readFile(new URL('./fixtures/deferred-site-status.js.txt', import.meta.url), 'utf8');
    const analysis = analyzeSource(text, {
      schemaVersion: 1,
      contract: { id: 'zxing-reader-lifetime-noninterference', revision: 1 },
      association: { sourceSha256: createHash('sha256').update(text).digest('hex'), relativePath: './zxing_reader.wasm', route: 'adjacent' },
      resourceBytes: Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]),
    });
    assert.equal(analysis.compatibility, 'incompatible');
    assert.equal(analysis.dependencyProof.resource.binaryVersion, 1);
    assert.equal(analysis.dependencyProof.acceptedContract, null);
    assert.equal(analysis.dependencyProof.diagnostics[0].code, 'DEPENDENCY_RESOURCE_IDENTITY');
  });

  await t.test('installed CLI proves deferred sources and rederives mixed mode plans offline', async t => {
    const box = await sandbox(t, installation);
    const deferred = await readFile(new URL('./fixtures/deferred-site-status.js.txt', import.meta.url), 'utf8');
    const unicode = '﻿/* 中文 😀 */\r\n' + deferred.replaceAll('\n', '\r\n');
    await writeFile(box.targets[0], unicode);
    await writeFile(box.targets[2], deferred);
    const detected = result(box.run(['detect', '--plugin-root', box.root]), 'detect');
    for (const artifact of detected.data.artifacts.filter(entry => entry.version !== '9')) {
      assert.equal(artifact.analysis.patternVersion, 'site-status-deferred-v1');
      assert.deepEqual(artifact.analysis.evidence.map(entry => entry.kind), ['initialization', 'predicate', 'source', 'transport', 'response', 'receiver', 'cache', 'consumption']);
      assert.equal((artifact.plugin === 'browser' ? unicode : deferred).slice(artifact.analysis.target.start, artifact.analysis.target.end), 'body');
      assert.deepEqual(artifact.analysis.diagnostics, []);
    }
    const human = box.run(['detect', '--plugin-root', box.root], {json: false});
    assert.equal(human.status, 0, human.stdout + human.stderr);
    assert.match(human.stdout, /Evidence cache:.*same current promise/);
    const prepared = prepare(box);
    const manifest = JSON.parse(await readFile(prepared.data.plan.manifestPath, 'utf8'));
    assert.equal(manifest.formatVersion, 2);
    assert.equal(manifest.patternVersion, 'site-status-selection-v1');
    assert.deepEqual(manifest.targets.map(entry => entry.patternVersion), ['site-status-deferred-v1', 'site-status-v1', 'site-status-deferred-v1']);
    const entry = manifest.targets[0], patched = await readFile(join(box.plan, 'contents', entry.patched.file));
    const prefix = Buffer.from(unicode.slice(0, entry.expression.range.start)), suffix = Buffer.from(unicode.slice(entry.expression.range.end));
    assert.deepEqual(patched.subarray(0, prefix.length), prefix);
    assert.deepEqual(patched.subarray(patched.length - suffix.length), suffix);
    assert.equal(entry.original.size, Buffer.byteLength(unicode));
    assert.deepEqual(result(operation(box, 'status'), 'status').data.targets.map(entry => entry.state), ['original', 'original', 'original']);
    assert.equal(await readFile(box.targets[0], 'utf8'), unicode);
    assert.equal(await readFile(box.targets[1], 'utf8'), source);
    assert.equal(await readFile(box.targets[2], 'utf8'), deferred);
    result(box.run(['prepare', '--plugin-root', box.root, '--all-compatible', '--output', box.plan]), 'prepare', 1);
    const selected = join(box.directory, 'deferred-only');
    result(box.run(['prepare', '--plugin-root', box.root, '--target', box.targets[2], '--output', selected]), 'prepare');
    assert.deepEqual(result(box.run(['status', '--plan', selected, '--store', box.store]), 'status').data.targets.map(entry => entry.state), ['original']);
  });

  await t.test('installed executable documents all commands, supported platform and exit protocol', () => {
    const help = runCli(['--help'], { directory, binary, direct: true });
    assert.equal(help.status, 0, help.stderr);
    assert.equal(help.stderr, '');
    assert.match(help.stdout, /macOS/);
    for (const command of ['detect', 'prepare', 'apply', 'status', 'restore', 'recover']) assert.match(help.stdout, new RegExp(`codex-browser-patch ${command}`));
    assert.match(help.stdout, /2 invalid arguments, 3 incompatible .*4 conflict/);
    assert.match(help.stdout, /never continues apply or restore/);
  });

  await t.test('installed CLI preserves explicit selection and multi-target human/JSON round trips', async (t) => {
    const box = await sandbox(t, installation);
    const empty = result(box.run(['detect']), 'detect');
    assert.deepEqual(empty.data.artifacts, []);
    const detected = result(box.run(['detect', '--plugin-root', box.root]), 'detect');
    assert.deepEqual(detected.data.artifacts.map(({ path, realPath, compatibility }) => ({ path, realPath, compatibility })),
      box.targets.map((path) => ({ path, realPath: path, compatibility: 'compatible' })));
    const humanDetection = box.run(['detect', '--plugin-root', box.root], { json: false });
    assert.equal(humanDetection.status, 0, humanDetection.stdout + humanDetection.stderr);
    assert.match(humanDetection.stdout, /^detect: success/);
    for (const path of box.targets) assert.ok(humanDetection.stdout.includes(path));
    const selectedPlan = join(box.directory, 'selected-plan');
    const selected = result(box.run(['prepare', '--plugin-root', box.root, '--target', box.targets[2], '--target', box.targets[0], '--output', selectedPlan]), 'prepare');
    assert.equal(selected.data.plan.targetCount, 2);
    const appliedSelection = result(box.run(['apply', '--plan', selectedPlan, '--store', box.store]), 'apply');
    assert.deepEqual(appliedSelection.data.targets.map(({ path, action }) => ({ path, action })), [
      { path: box.targets[2], action: 'applied' }, { path: box.targets[0], action: 'applied' },
    ]);
    assert.equal(await readFile(box.targets[1], 'utf8'), source);
    result(box.run(['restore', '--plan', selectedPlan, '--store', box.store]), 'restore');
    const preparedHuman = box.run(['prepare', '--plugin-root', box.root, '--all-compatible', '--output', box.plan], { json: false });
    assert.equal(preparedHuman.status, 0, preparedHuman.stdout + preparedHuman.stderr);
    assert.match(preparedHuman.stdout, /Targets: 3; plugin files unchanged/);
    assert.match(preparedHuman.stdout, /Runtime: not-verified/);
    for (const path of box.targets) assert.equal(await readFile(path, 'utf8'), source);
    const initial = result(operation(box, 'status'), 'status');
    assert.deepEqual(initial.data.targets.map((target) => target.state), ['original', 'original', 'original']);
    const applied = result(operation(box, 'apply'), 'apply');
    assert.deepEqual(applied.data.targets.map((target) => target.action), ['applied', 'applied', 'applied']);
    for (const path of box.targets) {
      assert.match(await readFile(path, 'utf8'), /agent:false/);
      assert.equal((await stat(path)).mode & 0o7777, 0o640);
    }
    const repeated = operation(box, 'apply', { json: false });
    assert.equal(repeated.status, 0, repeated.stdout + repeated.stderr);
    assert.match(repeated.stdout, /^apply: success/);
    assert.equal(repeated.stdout.match(/tool-applied \(already-applied\)/g).length, 3);
    const queried = result(box.run(['status', '--target', box.targets[2], '--target', box.targets[0], '--store', box.store]), 'status');
    assert.deepEqual(queried.data.targets.map((target) => target.path), [box.targets[2], box.targets[0]]);
    assert.deepEqual(queried.data.targets.map((target) => target.state), ['tool-applied', 'tool-applied']);
    const humanStatus = operation(box, 'status', { json: false });
    assert.equal(humanStatus.status, 0, humanStatus.stdout + humanStatus.stderr);
    assert.match(humanStatus.stdout, /Group: complete/);
    const restored = result(operation(box, 'restore'), 'restore');
    assert.deepEqual(restored.data.targets.map((target) => target.action), ['restored', 'restored', 'restored']);
    const repeatedRestore = operation(box, 'restore', { json: false });
    assert.equal(repeatedRestore.status, 0, repeatedRestore.stdout + repeatedRestore.stderr);
    assert.equal(repeatedRestore.stdout.match(/original \(already-original\)/g).length, 3);
    for (const path of box.targets) assert.equal(await readFile(path, 'utf8'), source);
    assert.equal(result(operation(box, 'recover'), 'recover').diagnostics[0].code, 'NO_INCOMPLETE_TRANSACTION');
  });

  await t.test('installed CLI exposes stable human/JSON errors for exits 1, 2, 3 and 4', async (t) => {
    const box = await sandbox(t, installation);
    prepare(box);
    const unsupported = join(box.root, 'chrome/unsupported/scripts/browser-service.mjs');
    await mkdir(join(unsupported, '..'), { recursive: true });
    await writeFile(unsupported, 'const unsupported = true;');
    for (const args of [
      ['prepare', '--plugin-root', box.root, '--output', join(box.directory, 'missing-selection')],
      ['prepare', '--plugin-root', box.root, '--target', box.targets[0], '--all-compatible', '--output', join(box.directory, 'ambiguous-selection')],
      ['prepare', '--plugin-root', box.root, '--target', 'relative', '--output', join(box.directory, 'relative-selection')],
      ['apply', '--plan', box.plan], ['restore', '--store', box.store], ['recover', '--store', box.store, '--plan', box.plan],
      ['status', '--target', box.targets[0], '--plan', box.plan, '--store', box.store],
      ['detect', '--unknown'],
    ]) assert.equal(result(box.run(args), args[0], 2).diagnostics[0].code, 'INVALID_ARGUMENTS');
    const cases = [
      { args: ['detect', '--unknown'], code: 2, diagnostic: 'INVALID_ARGUMENTS' },
      { args: ['detect', '--plugin-root', box.root], code: 3, diagnostic: 'NO_TARGET' },
      { args: ['prepare', '--plugin-root', box.root, '--target', unsupported, '--output', join(box.directory, 'unsupported-plan')], code: 3, diagnostic: 'TARGET_INCOMPATIBLE' },
      { args: operationArgs(box, 'apply'), code: 1, diagnostic: 'PROCESS_ENUMERATION_FAILED', extraEnv: { CODEX_TEST_PROCESS_FAILURE: '1' } },
    ];
    for (const { args, code, diagnostic, extraEnv = {} } of cases) {
      const output = result(box.run(args, { extraEnv }), args[0], code);
      assert.ok(output.diagnostics.some((item) => item.code === diagnostic), JSON.stringify(output));
      const human = box.run(args, { json: false, extraEnv });
      assert.equal(human.status, code, human.stdout + human.stderr);
      assert.equal(human.stderr, '');
      assert.ok(human.stdout.startsWith(`${args[0]}: ${outcomes[code]}`));
      assert.ok(human.stdout.includes(`[${diagnostic}]`));
    }
    await writeFile(box.targets[2], 'external upgrade');
    const conflict = result(operation(box, 'apply'), 'apply', 4);
    assert.equal(conflict.diagnostics[0].code, 'TARGET_CONFLICT');
    const humanConflict = operation(box, 'apply', { json: false });
    assert.equal(humanConflict.status, 4, humanConflict.stdout + humanConflict.stderr);
    assert.match(humanConflict.stdout, /^apply: conflict/);
    assert.match(humanConflict.stdout, /\[TARGET_CONFLICT\]/);
    assert.equal(await readFile(box.targets[0], 'utf8'), source);
    assert.equal(await readFile(box.targets[1], 'utf8'), source);
    assert.equal(await readFile(box.targets[2], 'utf8'), 'external upgrade');
    assert.equal(result(operation(box, 'status'), 'status', 4).data.targets[2].state, 'conflict');
  });

  await t.test('installed detect/prepare reject reflective aliases and unsupported dynamic receivers', async (t) => {
    const box = await sandbox(t, installation);
    const extras = [
      "const change = Reflect.set; change(URL.prototype, 'toString', function () { return 'https://other.invalid'; });",
      "const change = Object.defineProperty; change(Policy.prototype, 'load', { value: async function () { return false; } });",
      "class ActualPolicy extends Policy { async query(runtime, request) { return { blocked: true }; } }",
      "Policy.prototype.check.call({ query: async function () { return { blocked: true }; } }, runtime, site);",
    ];
    for (const [index, extra] of extras.entries()) {
      await writeFile(box.targets[0], source + '\n' + extra);
      const detected = result(box.run(['detect', '--plugin-root', box.root]), 'detect', 3);
      assert.equal(detected.data.artifacts[0].compatibility, 'incompatible');
      const output = join(box.directory, `refused-${index}`);
      const prepared = result(box.run(['prepare', '--plugin-root', box.root, '--target', box.targets[0], '--output', output]), 'prepare', 3);
      assert.equal(prepared.data, null);
      await assert.rejects(access(output));
      assert.equal(await readFile(box.targets[0], 'utf8'), source + '\n' + extra);
    }
  });

  await t.test('installed bin retries killed lease publication including successor and release links', async (t) => {
    for (const scope of ['operation', 'target']) {
      for (const phase of ['lock', 'successor', 'release']) {
        const box = await sandbox(t, installation);
        prepare(box);
        if (phase === 'successor') result(operation(box, 'apply'), 'apply');
        await interrupt(t, box, phase === 'successor' ? 'restore' : 'apply', `after-${scope}-${phase}-link`, box.targets[0]);
        const state = phase === 'lock' ? 'original' : 'tool-applied';
        assert.deepEqual(result(operation(box, 'status'), 'status').data.targets.map((target) => target.state), Array(3).fill(state));
        assert.equal(result(operation(box, 'recover'), 'recover').diagnostics[0].code, 'NO_INCOMPLETE_TRANSACTION');
        result(operation(box, 'apply'), 'apply');
        result(operation(box, 'restore'), 'restore');
        for (const path of box.targets) assert.equal(await readFile(path, 'utf8'), source);
      }
    }
  });

  await t.test('installed bin ignores removed terminal targets while validating live selection and recovering pending work', async (t) => {
    for (const pending of [false, true]) {
      const box = await sandbox(t, installation);
      const [old, current] = box.targets;
      const oldPlan = join(box.directory, 'old-plan');
      result(box.run(['prepare', '--plugin-root', box.root, '--target', old, '--output', oldPlan]), 'prepare');
      result(box.run(['apply', '--plan', oldPlan, '--store', box.store]), 'apply');
      result(box.run(['restore', '--plan', oldPlan, '--store', box.store]), 'restore');
      result(box.run(['prepare', '--plugin-root', box.root, '--target', current, '--output', box.plan]), 'prepare');
      if (pending) await interrupt(t, box, 'apply', 'after-target-rename', current);
      await rm(join(old, '../..'), { recursive: true });
      assert.equal(result(operation(box, 'status'), 'status').data.targets[0].state, pending ? 'incomplete' : 'original');
      if (pending) {
        assert.equal(result(operation(box, 'apply'), 'apply', 4).diagnostics[0].code, 'INCOMPLETE_TRANSACTION');
        result(operation(box, 'recover'), 'recover');
        assert.equal(await readFile(current, 'utf8'), source);
      }
      result(operation(box, 'apply'), 'apply');
      result(operation(box, 'restore'), 'restore');
      assert.equal(result(operation(box, 'status'), 'status').data.targets[0].state, 'original');
      assert.equal(result(operation(box, 'recover'), 'recover').diagnostics[0].code, 'NO_INCOMPLETE_TRANSACTION');
      // The selected target itself must still pass current identity checks.
      await writeFile(current, 'external current version');
      result(operation(box, 'apply'), 'apply', 4);
      assert.equal(await readFile(current, 'utf8'), 'external current version');
    }
  });

  await t.test('installed CLI retains failed second-target rollback and explicitly recovers the group', async (t) => {
    const box = await sandbox(t, installation);
    prepare(box);
    const failed = result(operation(box, 'apply', { extraEnv: { CODEX_TEST_TARGET: box.targets[1], CODEX_TEST_FAULT: 'rollback-failure' } }), 'apply', 1);
    assert.equal(failed.diagnostics[0].code, 'ROLLBACK_FAILED');
    const pending = result(operation(box, 'status'), 'status');
    assert.equal(pending.data.groupState, 'incomplete');
    assert.deepEqual(pending.data.targets.map((target) => target.state), ['incomplete', 'incomplete', 'incomplete']);
    assert.equal(result(operation(box, 'apply'), 'apply', 4).diagnostics[0].code, 'INCOMPLETE_TRANSACTION');
    assert.equal(result(operation(box, 'restore'), 'restore', 4).diagnostics[0].code, 'INCOMPLETE_TRANSACTION');
    const human = operation(box, 'recover', { json: false });
    assert.equal(human.status, 0, human.stdout + human.stderr);
    assert.match(human.stdout, /^recover: success/);
    assert.equal(human.stdout.match(/original \(rolled-back\)/g).length, 3);
    for (const path of box.targets) assert.equal(await readFile(path, 'utf8'), source);
    assert.equal(result(operation(box, 'status'), 'status').data.groupState, 'complete');
  });

  await t.test('installed CLI survives killed apply/restore and killed recovery, restoring each mixed prestate', async (t) => {
    for (const command of ['apply', 'restore']) {
      const box = await sandbox(t, installation);
      prepare(box);
      const single = join(box.directory, 'single');
      result(box.run(['prepare', '--plugin-root', box.root, '--target', box.targets[0], '--output', single]), 'prepare');
      result(box.run(['apply', '--plan', single, '--store', box.store]), 'apply');
      const before = await Promise.all(box.targets.map((path) => readFile(path)));
      await interrupt(t, box, command, 'after-target-rename', command === 'apply' ? box.targets[2] : box.targets[0]);
      const pending = result(operation(box, 'status'), 'status');
      assert.equal(pending.data.groupState, 'incomplete');
      assert.equal(pending.data.operation, command);
      assert.deepEqual(pending.data.targets.map((target) => target.pending.before), ['tool-applied', 'original', 'original']);
      assert.equal(pending.data.pendingTransactions[0].targets.length, 3);
      const human = operation(box, 'status', { json: false });
      assert.equal(human.status, 0, human.stdout + human.stderr);
      assert.match(human.stdout, /Explicit recover rolls back to the preoperation state/);
      assert.equal(result(operation(box, 'apply'), 'apply', 4).diagnostics[0].code, 'INCOMPLETE_TRANSACTION');
      // Unknown contents anywhere must preserve the entire group and pending recovery evidence.
      await writeFile(box.targets[2], 'external interruption edit');
      const current = await Promise.all(box.targets.map((path) => readFile(path)));
      assert.equal(result(operation(box, 'recover'), 'recover', 4).diagnostics[0].code, 'RECOVERY_CONFLICT');
      for (const [index, path] of box.targets.entries()) assert.deepEqual(await readFile(path), current[index]);
      // Remove only our synthetic edit, preserving the same file identity.
      await writeFile(box.targets[2], command === 'apply' ? await readFile(join(box.plan, 'contents/0002.patched.mjs')) : before[2]);
      await interrupt(t, box, 'recover', 'after-target-rename', command === 'apply' ? box.targets[1] : box.targets[0]);
      assert.equal(result(operation(box, 'status'), 'status').data.groupState, 'incomplete');
      const recovered = result(operation(box, 'recover'), 'recover');
      assert.deepEqual(recovered.data.targets.map((target) => target.state), ['tool-applied', 'original', 'original']);
      for (const [index, path] of box.targets.entries()) assert.deepEqual(await readFile(path), before[index]);
      assert.deepEqual(result(operation(box, 'status'), 'status').data.targets.map((target) => target.state), ['tool-applied', 'original', 'original']);
      result(operation(box, 'restore'), 'restore');
      for (const path of box.targets) assert.equal(await readFile(path, 'utf8'), source);
    }
  });
});
