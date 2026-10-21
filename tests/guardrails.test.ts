import assert from 'node:assert/strict';
import test from 'node:test';
import type { TestContext } from 'node:test';
import { ESLint } from 'eslint';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceFixture } from './helpers/paths.js';
import { runCli } from './helpers/cli.js';

const eslint = new ESLint();
const check = fileURLToPath(new URL('../scripts/check.js', import.meta.url));
const pipelineScripts = Object.fromEntries(['typecheck', 'lint', 'test'].map((name) => [name, `node -e "console.log('checked ${name}')"`]));
const packageMetadata = { packageManager: 'pnpm@10.34.5', scripts: pipelineScripts };
const strictOptions = { strict: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true };


async function checkSandbox(t: TestContext) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codex-check-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const run = (args: readonly string[], binary = check) => runCli(args, { directory, binary, fixture: null });
  const git = (args: readonly string[]) => runCli(args, { directory, binary: 'git', direct: true });
  assert.equal(git(['init', '--quiet']).status, 0);
  await writeFile(join(directory, 'tracked.txt'), 'clean\n');
  await writeFile(join(directory, 'package.json'), JSON.stringify(packageMetadata));
  await writeFile(join(directory, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n");
  await writeFile(join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: strictOptions }));
  await writeFile(join(directory, 'tsconfig.tools.json'), JSON.stringify({ extends: './tsconfig.json', compilerOptions: { rootDir: '.', noEmit: true } }));
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
  const scripts: Record<string, string> = Object.fromEntries(['typecheck', 'lint', 'test'].map((name) => [name, `node -e "console.log('checked ${name}')"`]));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ ...packageMetadata, scripts }));
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
  await writeFile(join(directory, 'package.json'), JSON.stringify({ ...packageMetadata, scripts }));
  const failure = run(['--base', baseline]);
  assert.equal(failure.status, 7, failure.stdout + failure.stderr);
  assert.doesNotMatch(failure.stdout, /checked test/);
});

const preloadContracts: [string, string][] = [
  ['npx-final-bin.cts', './managed-boundaries.cjs'],
  ['managed-boundaries.cts', './transaction-boundaries.cjs'],
];

test('boundary fixtures require their fixed preload composition through ESLint', async () => {
  for (const [name, boundary] of preloadContracts) {
    const filePath = `tests/fixtures/${name}`;
    const fixture = await readFile(sourceFixture(name), 'utf8');
    for (const source of [fixture, `process.env.CODEX_TEST_SETUP = 'synthetic';\n${fixture}`]) {
      const [legitimate] = await eslint.lintText(source, { filePath });
      assert.ok(legitimate);
      assert.deepEqual(legitimate.messages, [], name);
    }
    const load = `require('${boundary}');`;
    const mutations: [string, string][] = [
      ['missing', ''],
      ['replaced', `require('${name === 'npx-final-bin.cts' ? './transaction-boundaries.cjs' : './darwin.cjs'}');`],
      ['conditional', `if (process.env.CODEX_TEST_FAULT) ${load}`],
      ['conditional expression', `process.env.CODEX_TEST_FAULT && require('${boundary}');`],
      ['optional loader', `require?.('${boundary}');`],
      ['uncalled', `function unusedBoundary() { ${load} } void unusedBoundary;`],
      ['string', `void ${JSON.stringify(load)};`],
      ['comment', `// ${load}`],
      ['wrong loader', `void ((require) => require('${boundary}'))(() => {});`],
      ['late', ''],
      ['late after saving execFile', ''],
      ...(name === 'npx-final-bin.cts' ? [['late after home wrapper', ''] as [string, string]] : []),
    ];
    for (const [mutation, replacement] of mutations) {
      let source = fixture.replace(load, replacement);
      if (mutation === 'late') source += `\n${load}\n`;
      if (mutation === 'late after saving execFile') source = source.replace('const execFile = childProcess.execFile;', `const execFile = childProcess.execFile;\n${load}`);
      if (mutation === 'late after home wrapper') source = source.replace('const scenarioPath =', `${load}\nconst scenarioPath =`);
      const [result] = await eslint.lintText(source, { filePath });
      assert.ok(result);
      assert.ok(result.filePath.endsWith(filePath));
      assert.ok(result.messages.some(message => message.ruleId === 'test-boundaries/required-preload'
        && message.message.includes(boundary) && message.message.includes(name)),
      `${name} ${mutation}: ${JSON.stringify(result.messages)}`);
    }
  }
});

test('boundary preloads precede destructured API saves through ESLint', async (t) => {
  const saves: [string, string, string, string][] = [
    ['managed-boundaries.cts', './transaction-boundaries.cjs', 'childProcess', 'execFile'],
    ['npx-final-bin.cts', './managed-boundaries.cjs', 'childProcess', 'execFile'],
    ['managed-boundaries.cts', './transaction-boundaries.cjs', 'promises', 'readdir'],
    ['npx-final-bin.cts', './managed-boundaries.cjs', 'promises', 'rename'],
  ];
  for (const [name, boundary, object, api] of saves) {
    const filePath = `tests/fixtures/${name}`;
    const fixture = await readFile(sourceFixture(name), 'utf8');
    const load = `require('${boundary}');`;
    for (const [form, save] of [
      ['declaration', `const { ${api} } = ${object};`],
      ['assignment', `let ${api};\n({ ${api} } = ${object});\n({ ${api} } = ${object});`],
    ] as const) {
      await t.test(`${name} ${object}.${api} ${form}`, async () => {
        const source = fixture.replace(`const ${api} = ${object}.${api};`, save);
        const [early] = await eslint.lintText(source, { filePath });
        assert.ok(early);
        assert.deepEqual(early.messages, [], `${name} early preload`);
        const lateSource = source.replace(load, '').replace(save, `${save}\n${load}`);
        const [late] = await eslint.lintText(lateSource, { filePath });
        assert.ok(late);
        assert.ok(late.messages.some(message => message.ruleId === 'test-boundaries/required-preload'
          && message.message.includes(boundary) && message.message.includes(name)),
        `${name} late preload after ${form}: ${JSON.stringify(late.messages)}`);
      });
    }
  }
});

test('npx preload precedes static userInfo wrapper assignments through ESLint', async (t) => {
  const name = 'npx-final-bin.cts';
  const filePath = `tests/fixtures/${name}`;
  const boundary = './managed-boundaries.cjs';
  const load = `require('${boundary}');`;
  const fixture = await readFile(sourceFixture(name), 'utf8');
  for (const member of ['os.userInfo', "os['userInfo']", 'os[`userInfo`]']) {
    await t.test(member, async () => {
      const source = fixture.replace('os.userInfo =', `${member} =`);
      const [early] = await eslint.lintText(source, { filePath });
      assert.ok(early);
      assert.deepEqual(early.messages, [], `${member} early preload`);
      const lateSource = source.replace(load, '').replace('const scenarioPath =', `${load}\nconst scenarioPath =`);
      const [late] = await eslint.lintText(lateSource, { filePath });
      assert.ok(late);
      assert.ok(late.messages.some(message => message.ruleId === 'test-boundaries/required-preload'
        && message.message.includes(boundary) && message.message.includes(name)),
      `${member} late preload: ${JSON.stringify(late.messages)}`);
    });
  }
});

test('all three boundary fixtures permit ps save/wrap/delegate but reject restricted subprocess APIs', async () => {
  for (const name of ['npx-final-bin.cts', 'managed-boundaries.cts', 'transaction-boundaries.cts']) {
    const filePath = `tests/fixtures/${name}`;
    const fixture = await readFile(sourceFixture(name), 'utf8');
    for (const source of [fixture, fixture.replaceAll('childProcess.execFile', "childProcess['execFile']"), fixture.replaceAll('childProcess.execFile', 'childProcess[`execFile`]')]) {
      const [legitimate] = await eslint.lintText(source, { filePath });
      assert.ok(legitimate);
      assert.deepEqual(legitimate.messages, [], name);
    }
    for (const api of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFileSync', 'fork', 'execFile']) {
      for (const member of [`childProcess.${api}`, `childProcess['${api}']`, `childProcess[\`${api}\`]`]) {
        // Saving execFile for the existing ps wrapper is permitted; other launchers cannot be saved either.
        const accesses = api === 'execFile' ? [`${member}(process.execPath, ['dist/cli.js'], () => {});`]
          : [`${member}(process.execPath, ['dist/cli.js']);`, `void ${member};`];
        for (const launch of accesses) {
          const [result] = await eslint.lintText(`${fixture}\n${launch}\n`, { filePath });
          assert.ok(result);
          assert.ok(result.filePath.endsWith(filePath));
          assert.ok(result.messages.some(message => message.message.includes('shared CLI launcher')
            && message.message.includes(api)), `${name}: ${launch}: ${JSON.stringify(result.messages)}`);
          assert.ok(result.messages.every(message => ['no-restricted-syntax', 'no-restricted-properties'].includes(message.ruleId ?? '')), JSON.stringify(result.messages));
        }
      }
    }
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
    const [result] = await eslint.lintText(source, { filePath: 'tests/direct-launch.ts' });
    assert.ok(result);
    assert.ok(result.messages.some((message) => message.message.includes('shared CLI launcher')), source);
  }
  const [typescript] = await eslint.lintText("import child = require('node:child_process'); void child;", { filePath: 'tests/direct-launch.ts' });
  assert.ok(typescript);
  assert.ok(typescript.messages.some((message) => message.message.includes('shared CLI launcher')));
  for (const name of ['npx-final-bin.cts', 'managed-boundaries.cts', 'transaction-boundaries.cts']) {
    const filePath = `tests/fixtures/${name}`;
    const fixture = await readFile(sourceFixture(name), 'utf8');
    for (const source of examples) {
      const [result] = await eslint.lintText(`${fixture}\n${source}\n`, { filePath });
      assert.ok(result);
      assert.ok(result.messages.some(message => message.message.includes('shared CLI launcher')), `${name}: ${source}`);
    }
  }
});


test('check enforces TypeScript sources and pnpm engineering policy through its public entrypoint', async (t) => {
  for (const path of ['src/new.js', 'scripts/new.mjs', 'tests/new.cjs', 'tests/new.py', 'tests/helpers/new.exp', 'eslint.config.js', 'new.mjs']) {
    await t.test(`rejects maintained ${path}`, async (t) => {
      const { directory, run } = await checkSandbox(t);
      await mkdir(join(directory, path, '..'), { recursive: true });
      await writeFile(join(directory, path), '// handwritten entry\n');
      const output = run(['--base', 'HEAD']);
      assert.equal(output.status, 1, output.stdout + output.stderr);
      assert.match(output.stderr, /Engineering policy:[\s\S]*TypeScript/);
      assert.doesNotMatch(output.stdout, /checked typecheck/);
    });
  }
  const mutations: [string, string | null][] = [
    ['pnpm-lock.yaml', null],
    ['package-lock.json', '{}'],
    ['npm-shrinkwrap.json', '{}'],
    ['package.json', JSON.stringify({ scripts: pipelineScripts })],
    ['package.json', JSON.stringify({ ...packageMetadata, packageManager: 'npm@10.0.0' })],
    ['package.json', JSON.stringify({ ...packageMetadata, packageManager: 'pnpm@latest' })],
    ...Object.keys(strictOptions).map((option): [string, string] => ['tsconfig.json', JSON.stringify({ compilerOptions: { ...strictOptions, [option]: false } })]),
    ['tsconfig.tools.json', JSON.stringify({ compilerOptions: { rootDir: '.', noEmit: true } })],
    ...Object.keys(strictOptions).map((option): [string, string] => ['tsconfig.tools.json', JSON.stringify({ extends: './tsconfig.json', compilerOptions: { [option]: false } })]),
  ];
  for (const [index, [path, content]] of mutations.entries()) {
    await t.test(`rejects policy mutation ${index} in ${path}`, async (t) => {
      const { directory, run } = await checkSandbox(t);
      if (content === null) await rm(join(directory, path));
      else await writeFile(join(directory, path), content);
      const output = run(['--base', 'HEAD']);
      assert.equal(output.status, 1, output.stdout + output.stderr);
      assert.match(output.stderr, /Engineering policy:[\s\S]*(TypeScript|pnpm)/);
      assert.doesNotMatch(output.stdout, /checked typecheck/);
    });
  }
  await t.test('accepts generated assets and plugin source data', async (t) => {
    const { directory, run } = await checkSandbox(t);
    for (const path of ['dist/cli.js', '.build/tests/fixture.cjs', 'node_modules/dependency/index.js', '.claude/hook.js', 'evidence/sample.js', 'patch-plans/sample.js', 'tests/fixtures/plugin.js.txt']) {
      await mkdir(join(directory, path, '..'), { recursive: true });
      await writeFile(join(directory, path), '// generated output or source data\n');
    }
    const output = run(['--base', 'HEAD']);
    assert.equal(output.status, 0, output.stdout + output.stderr);
    assert.match(output.stdout, /checked typecheck[\s\S]*checked lint[\s\S]*checked test/);
  });
});
