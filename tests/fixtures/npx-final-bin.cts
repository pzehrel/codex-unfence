export {};
/* global require */
/* eslint-disable @typescript-eslint/no-require-imports -- External preload for the packed public bin only. */
const fs: typeof import('node:fs') = require('node:fs');
const os: typeof import('node:os') = require('node:os');
const { isAbsolute, join, relative }: typeof import('node:path') = require('node:path');
const { syncBuiltinESMExports }: typeof import('node:module') = require('node:module');

const root = fs.realpathSync(process.env.CODEX_NPX_SANDBOX ?? '');
const entry = fs.realpathSync(process.argv[1] ?? '');
const suffix = relative(join(root, 'npm-cache'), entry);
if (!suffix || suffix.startsWith('..') || isAbsolute(suffix)
  || !entry.endsWith('/node_modules/codex-unfence/dist/cli.js')) {
  throw new Error('Test preload may only affect this sandbox npx public bin.');
}
const userInfo = os.userInfo;
require('./managed-boundaries.cjs');
os.userInfo = ((...args: Parameters<typeof userInfo>) => ({ ...userInfo(...args), homedir: join(root, 'home') })) as typeof userInfo;
const scenarioPath = join(root, 'boundary.json');
const scenario: { killAfterRename?: string } = fs.existsSync(scenarioPath) ? JSON.parse(fs.readFileSync(scenarioPath, 'utf8')) : {};
const childProcess: typeof import('node:child_process') = require('node:child_process'); // eslint-disable-line no-restricted-syntax -- External ps boundary only.
const execFile = childProcess.execFile;
childProcess.execFile = function (this: unknown, file: string, ...args: unknown[]) {
  if (file === '/bin/ps') {
    const current: { processRows?: unknown[]; processFailure?: boolean } = fs.existsSync(scenarioPath) ? JSON.parse(fs.readFileSync(scenarioPath, 'utf8')) : {};
    process.env.CODEX_TEST_PROCESS_ROWS = JSON.stringify(current.processRows ?? []);
    if (current.processFailure) process.env.CODEX_TEST_PROCESS_FAILURE = '1';
    else delete process.env.CODEX_TEST_PROCESS_FAILURE;
  }
  return Reflect.apply(execFile, this, [file, ...args]);
} as typeof childProcess.execFile;
const promises: typeof import('node:fs/promises') = require('node:fs/promises');
const rename = promises.rename;
promises.rename = async function (from, to) {
  const result = await rename(from, to);
  if (to === scenario.killAfterRename) process.kill(process.pid, 'SIGKILL');
  return result;
};
syncBuiltinESMExports();
fs.writeFileSync(join(root, 'final-bin.json'), JSON.stringify({
  pid: process.pid, entry, cwd: process.cwd(), home: os.userInfo().homedir,
  stdinTTY: process.stdin.isTTY === true, stdoutTTY: process.stdout.isTTY === true,
}), { mode: 0o600 });
