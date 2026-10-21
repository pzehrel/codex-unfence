export {};
/* global require */
/* eslint-disable @typescript-eslint/no-require-imports -- Synthetic external filesystem boundary, never distributed. */
require('./transaction-boundaries.cjs');
const promises: typeof import('node:fs/promises') = require('node:fs/promises');
const { syncBuiltinESMExports }: typeof import('node:module') = require('node:module');
const fs: typeof import('node:fs') = require('node:fs');
// eslint-disable-next-line no-restricted-syntax -- Only a ps boundary wrapper; launches still use the shared test helper.
const childProcess: typeof import('node:child_process') = require('node:child_process');
const execFile = childProcess.execFile;
let snapshots = 0;
childProcess.execFile = function (this: unknown, file: string, args: unknown, ...rest: unknown[]) {
  if (file === '/bin/ps' && Array.isArray(args) && args.includes('pid=,command=')) {
    snapshots++;
    if (snapshots === 2 && ['managed-confirmation-change', 'managed-locator-change'].includes(process.env.CODEX_TEST_FAULT ?? '')) {
      if (process.env.CODEX_TEST_FAULT === 'managed-confirmation-change') fs.writeFileSync(requiredEnvironment('CODEX_TEST_TARGET'), fs.readFileSync(requiredEnvironment('CODEX_TEST_REPLACEMENT')));
      if (process.env.CODEX_TEST_FAULT === 'managed-locator-change') fs.writeFileSync(requiredEnvironment('CODEX_TEST_LOCATOR'), fs.readFileSync(requiredEnvironment('CODEX_TEST_LOCATOR_COPY')), { mode: 0o600 });
    }
  }
  return Reflect.apply(execFile, this, [file, args, ...rest]);
} as typeof childProcess.execFile;
const readdir = promises.readdir;
// Discovery must never enumerate real installed applications in these tests.
promises.readdir = function (this: unknown, path: Parameters<typeof readdir>[0], ...args: unknown[]) {
  if (path === '/Applications') return Promise.resolve([]);
  return Reflect.apply(readdir, this, [path, ...args]);
} as typeof promises.readdir;
syncBuiltinESMExports();

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined) throw new Error(`Missing synthetic fixture input: ${name}`);
  return value;
}
