/* global require */
/* eslint-disable @typescript-eslint/no-require-imports -- External preload for the packed public bin only. */
const fs = require('node:fs');
const os = require('node:os');
const { isAbsolute, join, relative } = require('node:path');
const { syncBuiltinESMExports } = require('node:module');

const root = fs.realpathSync(process.env.CODEX_NPX_SANDBOX);
const entry = fs.realpathSync(process.argv[1]);
const suffix = relative(join(root, 'npm-cache'), entry);
if (!suffix || suffix.startsWith('..') || isAbsolute(suffix)
  || !entry.endsWith('/node_modules/codex-browser-liberation-patch/dist/cli.js')) {
  throw new Error('Test preload may only affect this sandbox npm exec public bin.');
}
const userInfo = os.userInfo;
require('./managed-boundaries.cjs');
os.userInfo = (...args) => ({ ...userInfo(...args), homedir: join(root, 'home') });
const scenarioPath = join(root, 'boundary.json');
const scenario = fs.existsSync(scenarioPath) ? JSON.parse(fs.readFileSync(scenarioPath, 'utf8')) : {};
const childProcess = require('node:child_process'); // eslint-disable-line no-restricted-syntax -- External ps boundary only.
const execFile = childProcess.execFile;
childProcess.execFile = function (file, ...args) {
  if (file === '/bin/ps') {
    const current = fs.existsSync(scenarioPath) ? JSON.parse(fs.readFileSync(scenarioPath, 'utf8')) : {};
    process.env.CODEX_TEST_PROCESS_ROWS = JSON.stringify(current.processRows ?? []);
    if (current.processFailure) process.env.CODEX_TEST_PROCESS_FAILURE = '1';
    else delete process.env.CODEX_TEST_PROCESS_FAILURE;
  }
  return execFile(file, ...args);
};
const promises = require('node:fs/promises');
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
