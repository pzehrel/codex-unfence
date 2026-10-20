/* global require */
/* eslint-disable @typescript-eslint/no-require-imports -- Synthetic external filesystem boundary, never distributed. */
require('./transaction-boundaries.cjs');
const promises = require('node:fs/promises');
const { syncBuiltinESMExports } = require('node:module');
const readdir = promises.readdir;
// Discovery must never enumerate real installed applications in these tests.
promises.readdir = function (path, ...args) {
  if (path === '/Applications') return Promise.resolve([]);
  return readdir(path, ...args);
};
syncBuiltinESMExports();
