import assert from 'node:assert/strict';
import test from 'node:test';
import { ESLint } from 'eslint';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from './helpers/cli.mjs';

const eslint = new ESLint();
const check = fileURLToPath(new URL('../scripts/check.mjs', import.meta.url));

async function checkSandbox(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codex-check-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const run = (args, binary = check) => runCli(args, { directory, binary, fixture: null });
  const git = (args) => runCli(args, { directory, binary: 'git', direct: true });
  assert.equal(git(['init', '--quiet']).status, 0);
  await writeFile(join(directory, 'tracked.txt'), 'clean\n');
  assert.equal(git(['add', 'tracked.txt']).status, 0);
  const commit = git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'baseline']);
  assert.equal(commit.status, 0, commit.stdout + commit.stderr);
  return { directory, run, git };
}

test('check requires an explicit resolvable base and rejects option or shell-shaped input', async (t) => {
  const { directory, run } = await checkSandbox(t);
  const help = run(['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--base <ref>/);
  for (const args of [[], ['--base'], ['--base', '--help'], ['--base', 'missing-ref'], ['--base', 'HEAD; touch injected'], ['--base', 'HEAD', '--wat']]) {
    const output = run(args);
    assert.equal(output.status, 2, output.stdout + output.stderr);
    assert.match(output.stderr, /Usage:|Invalid base/);
  }
  await assert.rejects(readFile(join(directory, 'injected')));
  assert.equal((await readFile(join(directory, 'tracked.txt'), 'utf8')), 'clean\n');
});

test('check reports committed, staged and working whitespace against the chosen base and runs the shared pipeline', async (t) => {
  const { directory, run, git } = await checkSandbox(t);
  const baseline = git(['rev-parse', 'HEAD']).stdout.trim();
  const scripts = Object.fromEntries(['typecheck', 'lint', 'test'].map((name) => [name, `node -e "console.log('checked ${name}')"`]));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts }));
  const clean = run(['--base', baseline]);
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
  assert.match(clean.stdout, /checked typecheck[\s\S]*checked lint[\s\S]*checked test/);
  for (const phase of ['working', 'staged', 'committed']) {
    await writeFile(join(directory, 'tracked.txt'), `${phase} \n`);
    if (phase !== 'working') assert.equal(git(['add', 'tracked.txt']).status, 0);
    if (phase === 'committed') assert.equal(git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'whitespace']).status, 0);
    const dirty = run(['--base', baseline, '--whitespace-only']);
    assert.notEqual(dirty.status, 0);
    assert.match(dirty.stdout, /tracked.txt:1: trailing whitespace/);
    assert.doesNotMatch(dirty.stdout, /checked typecheck/);
  }
  // A new branch's initial push has no before commit. CI supplies the empty tree explicitly.
  const emptyTree = git(['hash-object', '-w', '-t', 'tree', '--stdin']).stdout.trim();
  assert.match(run(['--base', emptyTree, '--whitespace-only']).stdout, /trailing whitespace/);
  await writeFile(join(directory, 'tracked.txt'), 'clean\n');
  scripts.lint = 'node -e "process.exit(7)"';
  await writeFile(join(directory, 'package.json'), JSON.stringify({ scripts }));
  const failure = run(['--base', baseline]);
  assert.equal(failure.status, 7, failure.stdout + failure.stderr);
  assert.doesNotMatch(failure.stdout, /checked test/);
});

test('process fixture permits its ps mock but rejects appended direct CLI launches', async () => {
  const filePath = 'tests/fixtures/transaction-boundaries.cjs';
  const fixture = await readFile(new URL('./fixtures/transaction-boundaries.cjs', import.meta.url), 'utf8');
  const [legitimate] = await eslint.lintText(fixture, { filePath });
  assert.deepEqual(legitimate.messages, []);
  for (const launch of [
    "childProcess.execFile(process.execPath, ['dist/cli.js', 'detect', '--json'], () => {});",
    "childProcess['execFile'](process.execPath, ['dist/cli.js'], () => {});",
    "childProcess.spawn(process.execPath, ['dist/cli.js']);",
  ]) {
    const [result] = await eslint.lintText(`${fixture}\n${launch}\n`, { filePath });
    assert.ok(result.messages.some((message) => message.message.includes('shared CLI launcher')), launch);
    assert.ok(result.messages.every((message) => ['no-restricted-syntax', 'no-restricted-properties'].includes(message.ruleId)), JSON.stringify(result.messages));
  }
});

test('test lint rejects direct subprocess access through imports, reexports, dynamic imports and require', async () => {
  const examples = [
    "import { spawn } from 'node:child_process'; void spawn;",
    "import child from 'child_process'; void child;",
    "export { spawnSync } from 'node:child_process';",
    "export * from 'child_process';",
    "void import('node:child_process');",
    'void import(`child_process`);',
    "void import('node:child_process', { with: { type: 'json' } });",
    "const child = require('node:child_process'); void child;",
    'const child = require(`child_process`); void child;',
    "const child = localRequire('child_process'); void child;",
    "const child = process.getBuiltinModule('node:child_process'); void child;",
  ];
  for (const source of examples) {
    const [result] = await eslint.lintText(source, { filePath: 'tests/direct-launch.mjs' });
    assert.ok(result.messages.some((message) => message.message.includes('shared CLI launcher')), source);
  }
  const [typescript] = await eslint.lintText("import child = require('node:child_process'); void child;", { filePath: 'tests/direct-launch.ts' });
  assert.ok(typescript.messages.some((message) => message.message.includes('shared CLI launcher')));
  for (const source of ["childProcess.spawn('node', ['dist/cli.js']);", "void require('child_process');"]) {
    const [result] = await eslint.lintText(source, { filePath: 'tests/fixtures/transaction-boundaries.cjs' });
    assert.ok(result.messages.some((message) => message.message.includes('shared CLI launcher')), source);
  }
});
