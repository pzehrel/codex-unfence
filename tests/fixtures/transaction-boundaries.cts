export {};
/* global require, queueMicrotask */
/* eslint-disable @typescript-eslint/no-require-imports -- Explicit Node --require system-boundary fixture. */
// Loaded only by synthetic CLI tests. No production bypass flag or test-only API.
const fs: typeof import('node:fs') = require('node:fs');
const promises: typeof import('node:fs/promises') = require('node:fs/promises');
// eslint-disable-next-line no-restricted-syntax -- Patch only execFile's /bin/ps boundary; CLI launches use the shared isolated launcher.
const childProcess: typeof import('node:child_process') = require('node:child_process');
const { syncBuiltinESMExports }: typeof import('node:module') = require('node:module');
const { dirname, join }: typeof import('node:path') = require('node:path');
const os: typeof import('node:os') = require('node:os');
const userInfo = os.userInfo;
// Isolate the OS-account home boundary too; production does not trust HOME/XDG.
const home = join(process.cwd(), 'home');
os.userInfo = ((...args: Parameters<typeof userInfo>) => {
  fs.mkdirSync(home, { recursive: true });
  return { ...userInfo(...args), homedir: home };
}) as typeof userInfo;
if (process.env.CODEX_TEST_ALTERNATE_HOME) {
  process.env.HOME = join(process.cwd(), 'alternate-home');
  process.env.XDG_STATE_HOME = join(process.cwd(), 'alternate-state');
}
Object.defineProperty(process, 'platform', { value: 'darwin' });
const execute = childProcess.execFile;
childProcess.execFile = function (this: unknown, file: string, args: unknown, ...rest: unknown[]) {
  if (file !== '/bin/ps') return Reflect.apply(execute, this, [file, args, ...rest]);
  const callback = rest.at(-1);
  if (typeof callback !== 'function' || !Array.isArray(args)) throw new Error('Synthetic ps requires argument array and callback.');
  const started = 'Fri Oct 16 10:00:00 2026';
  const rows: { pid: number; start?: string; executable: string; command: string }[] = process.env.CODEX_TEST_PROCESS_ROWS ? JSON.parse(process.env.CODEX_TEST_PROCESS_ROWS) : [];
  const all = [{ pid: process.pid, start: started, executable: process.execPath, command: process.argv.map(argument => /\s/.test(argument) ? JSON.stringify(argument) : argument).join(' ') }, ...rows];
  const output = args.includes('pid=,lstart=,comm=')
    ? all.map((row) => `${row.pid} ${row.start ?? started} ${row.executable}\n`).join('') + `999991 ${started} /bin/ps\n`
    : all.map((row) => `${row.pid} ${row.command}\n`).join('') + '999992 /bin/ps -axww -o pid=,command=\n';
  queueMicrotask(() => callback(process.env.CODEX_TEST_PROCESS_FAILURE ? new Error('synthetic ps unavailable') : null, output, ''));
  return {};
} as typeof childProcess.execFile;
const rename = promises.rename;
const open = promises.open;
const link = promises.link;
const rm = promises.rm;
let targetLeasePublished = false;
const target = process.env.CODEX_TEST_TARGET;
let paused = false;
let replacements = 0;
const fault = process.env.CODEX_TEST_FAULT;
function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`Missing synthetic fixture input: ${name}`);
  return value;
}
let recoveryIntentPaused = false;
const ioError = () => Object.assign(new Error('synthetic filesystem failure'), { code: 'EIO' });
async function boundary(name: string) {
  if (!paused && process.env.CODEX_TEST_PAUSE === name) {
    paused = true;
    await new Promise<unknown>((resolve) => {
      process.once('message', resolve);
      if (!process.send) throw new Error('Boundary pause requires IPC.');
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
    if (record.phase === 'rolling-back' && fault === 'recovery-backup-change') fs.writeFileSync(requiredEnvironment('CODEX_TEST_BACKUP'), 'external backup change');
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
      if (fault === 'recovery-later-backup-change') fs.writeFileSync(requiredEnvironment('CODEX_TEST_BACKUP'), 'external backup change');
    }
  }
  if (String(to).endsWith('/journal.json') && fault === 'commit-journal-renamed-error' && JSON.parse(fs.readFileSync(to, 'utf8')).record.phase === 'committed') throw ioError();
  if (to === target) {
    if (fault === 'postwrite-change' && replacements === 1) fs.writeFileSync(target ?? requiredEnvironment('CODEX_TEST_TARGET'), 'external boundary change');
    await boundary('after-target-rename');
    if ((fault === 'rename-then-error' || fault === 'rollback-failure') && replacements === 1) throw ioError();
  }
  return result;
};
promises.open = async function (path, ...args) {
  if (String(path).includes('.codex-unfence-') && String(path).endsWith('.tmp') && args[0] === 'wx') {
    if (fault === 'write-failure' && dirname(String(path)) === dirname(target ?? '')) throw ioError();
    if (fault === 'prewrite-change') fs.writeFileSync(target ?? requiredEnvironment('CODEX_TEST_TARGET'), 'external boundary change');
    if (fault === 'parent-replaced') {
      const parent = dirname(target ?? requiredEnvironment('CODEX_TEST_TARGET'));
      const bytes = fs.readFileSync(target ?? requiredEnvironment('CODEX_TEST_TARGET'));
      const mode = fs.statSync(target ?? requiredEnvironment('CODEX_TEST_TARGET')).mode & 0o7777;
      fs.renameSync(parent, `${parent}-external`);
      fs.mkdirSync(parent);
      fs.writeFileSync(join(parent, 'browser-service.mjs'), bytes, { mode });
    }
  }
  return open(path, ...args);
};
promises.link = async function (from, to) {
  if (String(to).includes('target-leases') && !JSON.parse(fs.readFileSync(from, 'utf8')).released) await boundary('before-coordination-link');
  if (String(to).includes('operation.lock') && !JSON.parse(fs.readFileSync(from, 'utf8')).released) await boundary('before-operation-lock');
  if (fault === 'release-failure' && String(to).endsWith('.next') && JSON.parse(fs.readFileSync(from, 'utf8')).released) throw ioError();
  const result = await link(from, to);
  const record = JSON.parse(fs.readFileSync(from, 'utf8'));
  const scope = String(to).includes('operation.lock') ? 'operation' : String(to).includes('target-leases') ? 'coordination' : 'target';
  if (record.released) await boundary(`after-${scope}-release-link`);
  else await boundary(`after-${scope}-${String(to).endsWith('.next') ? 'successor' : 'lock'}-link`);
  if ((String(to).endsWith('.codex-unfence.lock') || String(to).includes('.codex-unfence.lock.')) && !JSON.parse(fs.readFileSync(from, 'utf8')).released) targetLeasePublished = true;
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
