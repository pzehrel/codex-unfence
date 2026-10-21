import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { CheckResult, OperationResult } from '../src/result.js';
import { runCli } from './helpers/cli.js';
import { packPackage, installPackage, syntheticInstallation } from './helpers/npm-package.js';
import { repositoryRoot } from './helpers/paths.js';

// Explicit external --require fixtures affect test children only. They are never packaged.
const fixture = fileURLToPath(new URL('./fixtures/managed-boundaries.cjs', import.meta.url));

function result<C extends string | null>(child: { status: number | null; stdout: string; stderr: string }, command: C, code = 0) {
  assert.equal(child.status, code, child.stdout + child.stderr);
  assert.equal(child.stderr, '');
  const output: C extends 'check' ? CheckResult : OperationResult = JSON.parse(child.stdout);
  assert.deepEqual(Object.keys(output).sort(), ['command', 'data', 'diagnostics', 'exitCode', 'outcome', 'schemaVersion']);
  assert.equal(output.schemaVersion, 1);
  assert.equal(output.command, command);
  assert.equal(output.exitCode, code);
  assert.equal(output.outcome, ['success', 'runtime-error', 'usage-error', 'incompatible', 'conflict'][code]);
  for (const diagnostic of output.diagnostics) {
    assert.equal(typeof diagnostic.code, 'string');
    assert.ok(['info', 'warning', 'error'].includes(diagnostic.severity));
    assert.equal(typeof diagnostic.message, 'string');
  }
  if (output.data) assert.equal(output.data.runtime, 'not-verified');
  return output;
}

test('installed tarball public bin preserves delivery structure, bundled dependencies and offline CLI acceptance', async (t: TestContext) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codex-package-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Private material outside the clean build directory must not enter delivery.
  const privateArtifact = join(repositoryRoot, 'package-acceptance-private-plan.json');
  await writeFile(privateArtifact, '{"syntheticLocalState":true}');
  t.after(() => rm(privateArtifact, { force: true }));
  const pack = packPackage(directory);
  assert.equal(pack.status, 0, pack.stderr);
  const [output]: [{ filename: string; files: { path: string }[] }] = JSON.parse(pack.stdout);
  const files = output.files.map(file => file.path);
  for (const path of files.filter(path => !path.startsWith('node_modules/'))) {
    assert.ok(path.startsWith('dist/') || path === 'README.md' || path === 'package.json', `Unexpected published file: ${path}`);
  }
  for (const path of ['dist/cli.js', 'dist/cua-analysis.js', 'dist/managed-patches.js', 'README.md', 'package.json']) {
    assert.ok(files.includes(path), `Missing published file: ${path}`);
  }
  for (const name of ['analysis', 'deferred-analysis', 'dependency-analysis', 'dependency-contracts', 'dependency-source', 'resource-provenance', 'handle-provenance', 'descriptor-provenance', 'loader-configuration-proof', 'discovery', 'plan', 'transactions']) {
    assert.ok(!files.includes(`dist/${name}.js`), `Abandoned module remains published: ${name}`);
  }
  assert.ok(!files.includes('package-acceptance-private-plan.json'));
  const dependencies = new Set<string>();
  for (const path of files.filter(path => path.startsWith('node_modules/'))) {
    assert.match(path, /^node_modules\/(acorn|eslint-scope|esrecurse|estraverse)\//);
    const name = path.split('/')[1];
    assert.ok(name);
    dependencies.add(name);
  }
  assert.deepEqual([...dependencies].sort(), ['acorn', 'eslint-scope', 'esrecurse', 'estraverse']);
  const prefix = join(directory, 'installation');
  const install = installPackage(directory, prefix, join(directory, output.filename));
  assert.equal(install.status, 0, install.stderr);
  const binary = join(prefix, 'bin/codex-unfence');
  const installed = join(prefix, 'lib/node_modules/codex-unfence');
  assert.equal(await realpath(binary), join(installed, 'dist/cli.js'));
  const metadata: { engines: { node: string }; bin: Record<string, string> } = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(metadata.engines.node, '>=22.13.0');
  assert.deepEqual(metadata.bin, { 'codex-unfence': 'dist/cli.js' });
  await assert.rejects(access(join(installed, 'src')));
  await assert.rejects(access(join(installed, 'tests')));

  await t.test('installed executable documents the current public commands and managed aliases', () => {
    const help = runCli(['--help'], { directory, binary, direct: true });
    assert.equal(help.status, 0, help.stderr);
    assert.equal(help.stderr, '');
    for (const command of ['install', 'check', 'uninstall']) assert.match(help.stdout, new RegExp(`codex-unfence ${command}`));
    assert.match(help.stdout, /macOS/);
    assert.match(help.stdout, /interactive/);
    assert.doesNotMatch(help.stdout, /codex-unfence (?:detect|prepare)|--plan|--store/);
  });

  await t.test('offline installed check and managed status inspect synthetic CUA bytes without creating recovery state', async () => {
    const selected = await syntheticInstallation({ directory }, 'Installed');
    const run = (args: string[]) => runCli([...args, '--json'], { directory, binary, fixture });
    const checked = result(run(['check', '--app', selected.app]), 'check');
    assert.ok(checked.data?.inspection);
    assert.equal(checked.data.inspection.candidate.targetPath, selected.target);
    assert.equal(checked.data.inspection.support, 'supported');
    assert.equal(checked.data.inspection.state, 'original');
    assert.equal(checked.data.inspection.writeReadiness, 'ready');
    const status = result(run(['status', '--app', selected.app]), 'status');
    assert.equal(status.data?.targets[0]?.state, 'original');
    const human = runCli(['check', '--app', selected.app], { directory, binary, fixture });
    assert.equal(human.status, 0, human.stdout + human.stderr);
    assert.ok(human.stdout.includes(selected.target));
    assert.match(human.stdout, /Runtime: not-verified/);
    assert.deepEqual(await readFile(selected.target), selected.source);
    assert.deepEqual(await readdir(join(directory, 'home')), ['Applications']);
    assert.deepEqual(await readdir(join(selected.target, '..')), ['browser-service.mjs']);
  });

  await t.test('installed CLI rejects abandoned selectors and commands and preserves write confirmation', () => {
    for (const args of [
      ['detect'], ['prepare'], ['apply', '--plan', directory], ['restore', `--store=${directory}`],
      ['check', '--plan='], ['status', '--store'], ['install'], ['uninstall'], ['apply'], ['restore'], ['recover'],
    ]) {
      const command = args[0];
      assert.ok(command);
      const rejected = result(runCli([...args, '--json'], { directory, binary, fixture }), command === 'detect' || command === 'prepare' ? null : command, 2);
      assert.equal(rejected.data, null);
      assert.equal(rejected.diagnostics[0]?.code, 'INVALID_ARGUMENTS');
    }
  });
});
