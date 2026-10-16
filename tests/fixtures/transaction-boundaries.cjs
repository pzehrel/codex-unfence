/* global require, queueMicrotask */
/* eslint-disable @typescript-eslint/no-require-imports -- Explicit Node --require system-boundary fixture. */
// Loaded only by synthetic CLI tests. No production bypass flag or test-only API.
const fs = require('node:fs');
const promises = require('node:fs/promises');
const childProcess = require('node:child_process');
const { syncBuiltinESMExports } = require('node:module');
const { dirname, join } = require('node:path');
Object.defineProperty(process, 'platform', { value: 'darwin' });
const execute = childProcess.execFile;
childProcess.execFile = function (file, args, ...rest) {
  if (file !== '/bin/ps') return execute(file, args, ...rest);
  const callback = rest.at(-1);
  const started = 'Fri Oct 16 10:00:00 2026';
  const rows = process.env.CODEX_TEST_PROCESS_ROWS ? JSON.parse(process.env.CODEX_TEST_PROCESS_ROWS) : [];
  const all = [{ pid: process.pid, start: started, executable: process.execPath, command: `${process.execPath} synthetic-cli` }, ...rows];
  const output = args.includes('pid=,lstart=,comm=')
    ? all.map((row) => `${row.pid} ${row.start ?? started} ${row.executable}\n`).join('') + `999991 ${started} /bin/ps\n`
    : all.map((row) => `${row.pid} ${row.command}\n`).join('') + '999992 /bin/ps -axww -o pid=,command=\n';
  queueMicrotask(() => callback(process.env.CODEX_TEST_PROCESS_FAILURE ? new Error('synthetic ps unavailable') : null, output, ''));
  return {};
};
const rename = promises.rename;
const open = promises.open;
const link = promises.link;
const rm = promises.rm;
let targetLeasePublished = false;
const target = process.env.CODEX_TEST_TARGET;
let paused = false;
let replacements = 0;
const fault = process.env.CODEX_TEST_FAULT;
let recoveryIntentPaused = false;
const ioError = () => Object.assign(new Error('synthetic filesystem failure'), { code: 'EIO' });
async function boundary(name) {
  if (!paused && process.env.CODEX_TEST_PAUSE === name) {
    paused = true;
    await new Promise((resolve) => {
      process.once('message', resolve);
      process.send({ boundary: name });
    });
    process.disconnect();
  }
}
promises.rename = async function (from, to) {
  if (to === target) {
    replacements++;
    await boundary('before-target-rename');
    if (fault === 'rollback-failure' && replacements > 1) throw ioError();
  }
  if (String(to).endsWith('/journal.json')) {
    const record = JSON.parse(fs.readFileSync(from, 'utf8')).record;
    if (record.phase === 'rolled-back') {
      await boundary('before-rollback-commit');
      if (fault === 'rollback-journal-failure') throw ioError();
    }
    if (record.phase === 'rolling-back' && fault === 'recovery-backup-change') fs.writeFileSync(process.env.CODEX_TEST_BACKUP, 'external backup change');
    if (record.phase === 'writing') await boundary('before-writing-journal');
    if (record.phase === 'verifying') await boundary('after-postverification');
    if (record.phase === 'committed') {
      await boundary('before-commit');
      if (fault === 'commit-journal-failure') throw ioError();
    }
  }
  const result = await rename(from, to);
  if (String(from).includes('/transactions/.staging-')) await boundary('after-intent-publication');
  if (String(to).endsWith('/journal.json') && JSON.parse(fs.readFileSync(to, 'utf8')).record.phase === 'verifying') await boundary('after-progress-journal');
  if (String(to).endsWith('/journal.json') && JSON.parse(fs.readFileSync(to, 'utf8')).record.phase === 'rolling-back') {
    await boundary('after-rollback-intent');
    if (!recoveryIntentPaused) {
      recoveryIntentPaused = true;
      if (fault === 'recovery-later-backup-change') fs.writeFileSync(process.env.CODEX_TEST_BACKUP, 'external backup change');
    }
  }
  if (String(to).endsWith('/journal.json') && fault === 'commit-journal-renamed-error' && JSON.parse(fs.readFileSync(to, 'utf8')).record.phase === 'committed') throw ioError();
  if (to === target) {
    if (fault === 'postwrite-change' && replacements === 1) fs.writeFileSync(target, 'external boundary change');
    await boundary('after-target-rename');
    if ((fault === 'rename-then-error' || fault === 'rollback-failure') && replacements === 1) throw ioError();
  }
  return result;
};
promises.open = async function (path, ...args) {
  if (String(path).includes('.codex-browser-patch-') && String(path).endsWith('.tmp') && args[0] === 'wx') {
    if (fault === 'write-failure' && dirname(String(path)) === dirname(target ?? '')) throw ioError();
    if (fault === 'prewrite-change') fs.writeFileSync(target, 'external boundary change');
    if (fault === 'parent-replaced') {
      const parent = dirname(target);
      const bytes = fs.readFileSync(target);
      const mode = fs.statSync(target).mode & 0o7777;
      fs.renameSync(parent, `${parent}-external`);
      fs.mkdirSync(parent);
      fs.writeFileSync(join(parent, 'browser-service.mjs'), bytes, { mode });
    }
  }
  return open(path, ...args);
};
promises.link = async function (from, to) {
  if (String(to).includes('operation.lock') && !JSON.parse(fs.readFileSync(from, 'utf8')).released) await boundary('before-operation-lock');
  if (fault === 'release-failure' && String(to).endsWith('.next') && JSON.parse(fs.readFileSync(from, 'utf8')).released) throw ioError();
  const result = await link(from, to);
  if ((String(to).endsWith('.codex-browser-patch.lock') || String(to).includes('.codex-browser-patch.lock.')) && !JSON.parse(fs.readFileSync(from, 'utf8')).released) targetLeasePublished = true;
  return result;
};
promises.rm = async function (path, ...args) {
  const result = await rm(path, ...args);
  if (targetLeasePublished && String(path).includes('.publish-')) {
    targetLeasePublished = false;
    await boundary('target-lock-acquired');
  }
  return result;
};
syncBuiltinESMExports();
