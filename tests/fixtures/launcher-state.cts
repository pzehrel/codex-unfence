export {};
/* global require */
/* eslint-disable @typescript-eslint/no-require-imports -- Explicit Node --require system-boundary fixture. */
const assert: typeof import('node:assert/strict') = require('node:assert/strict');
const { join }: typeof import('node:path') = require('node:path');
require('./darwin.cjs');
const directory = process.env.CODEX_TEST_SANDBOX;
assert.ok(directory);
assert.equal(process.cwd(), directory);
assert.equal(process.env.HOME, join(directory, 'home'));
assert.equal(process.env.XDG_STATE_HOME, join(directory, 'store'));
assert.equal(process.env.PWD, directory);
assert.equal(process.env.OLDPWD, directory);
assert.equal(process.env.NODE_OPTIONS, '');
assert.equal(process.env.NODE_PATH, '');
assert.equal(process.env.CODEX_TEST_HOST_SECRET, undefined);
