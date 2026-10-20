/* global require */
/* eslint-disable @typescript-eslint/no-require-imports -- Synthetic external filesystem boundary, never distributed. */
require('./transaction-boundaries.cjs');
const promises = require('node:fs/promises');
const { syncBuiltinESMExports } = require('node:module');
const fs = require('node:fs');
// eslint-disable-next-line no-restricted-syntax -- Only a ps boundary wrapper; launches still use the shared test helper.
const childProcess = require('node:child_process');
const execFile = childProcess.execFile;
let snapshots = 0;
childProcess.execFile = function (file, args, ...rest) {
  if (file === '/bin/ps' && args.includes('pid=,command=')) {
    snapshots++;
    if (snapshots === 2 && process.env.CODEX_TEST_FAULT === 'managed-confirmation-change') fs.writeFileSync(process.env.CODEX_TEST_TARGET, fs.readFileSync(process.env.CODEX_TEST_REPLACEMENT));
  }
  return execFile(file, args, ...rest);
};
const readdir = promises.readdir;
// Discovery must never enumerate real installed applications in these tests.
promises.readdir = function (path, ...args) {
  if (path === '/Applications') return Promise.resolve([]);
  return readdir(path, ...args);
};
syncBuiltinESMExports();
