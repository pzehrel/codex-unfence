import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';
import { runCli } from './helpers/cli.mjs';
import test from 'node:test';
import { transformRequestTransport } from '../scripts/cua-request-wrapper.mjs';

// Self-authored code only. No installed source is imported or executed by these tests.
const fixture = `/* 中文 🦉 */
async function transport(runtime, url, options) {
  if (typeof runtime.fetch !== 'function') throw new Error('fetch unavailable');
  return await runtime.fetch(url, options);
}
async function neighbor(runtime, url, options) {
  return await runtime.fetch(url, options);
}
async function consume(runtime, url, options) {
  const response = await transport(runtime, url, options);
  if (!response.ok) throw new Error('original HTTP error');
  return await response.json();
}
`;
const expected = 'await runtime.fetch(url, options)';
const recipe = { start: fixture.indexOf(expected), end: fixture.indexOf(expected) + expected.length, expected };

function transformed(source = fixture, range = recipe) {
  const result = transformRequestTransport(source, range);
  const api = runInThisContext(`(function () { ${result.source}\nreturn { transport, neighbor, consume }; })()`);
  return { ...api, result };
}

test('dedicated transport adapts agent true on frozen responses without changing other JSON data', async () => {
  const other = Object.freeze({ retain: 17 });
  const body = Object.freeze({ feature_status: Object.freeze({ agent: true, other: 'keep' }), other });
  const response = Object.freeze({ ok: true, json() { return body; } });
  const runtime = Object.freeze({ fetch() { return response; } });
  const { consume } = transformed();
  const result = await consume(runtime, 'self-authored://status', Object.freeze({ method: 'GET' }));
  assert.deepEqual(result, { feature_status: { agent: false, other: 'keep' }, other: { retain: 17 } });
  assert.notEqual(result, body);
  assert.notEqual(result.feature_status, body.feature_status);
  assert.equal(result.other, other);
  assert.equal(body.feature_status.agent, true);
});

test('transport preserves member receivers, argument identity, await order and lazy ok/json reads', async () => {
  const events = [];
  const url = Object.freeze({ exact: 'url identity' });
  const options = Object.freeze({ method: 'GET' });
  const body = { feature_status: { agent: true }, trace: 'keep' };
  let fetchCalls = 0;
  let jsonCalls = 0;
  const response = Object.freeze({
    get ok() { events.push('ok'); assert.equal(this, response); return 'truthy'; },
    get json() {
      events.push('json read');
      assert.equal(this, response);
      return function () {
        assert.equal(this, response);
        assert.equal(arguments.length, 0);
        jsonCalls++;
        return { then(resolve) { events.push('json then'); resolve(body); } };
      };
    },
  });
  const runtime = Object.freeze({
    fetch(request, init) {
      assert.equal(this, runtime);
      assert.equal(arguments.length, 2);
      assert.equal(request, url);
      assert.equal(init, options);
      fetchCalls++;
      events.push('fetch');
      return { then(resolve) { events.push('fetch then'); resolve(response); } };
    },
  });
  const { transport, neighbor } = transformed();
  const adapted = await transport(runtime, url, options);
  assert.equal(fetchCalls, 1);
  assert.deepEqual(events, ['fetch', 'fetch then']);
  assert.equal(adapted.ok, 'truthy');
  assert.equal(adapted.ok, 'truthy');
  assert.deepEqual(events, ['fetch', 'fetch then', 'ok', 'ok']);
  assert.equal(jsonCalls, 0);
  assert.deepEqual(await adapted.json(), { feature_status: { agent: false }, trace: 'keep' });
  assert.deepEqual(await adapted.json(), { feature_status: { agent: false }, trace: 'keep' });
  assert.equal(jsonCalls, 2);
  assert.deepEqual(events.slice(4), ['json read', 'json then', 'json read', 'json then']);
  assert.equal(await neighbor(runtime, url, options), response);
  assert.equal(fetchCalls, 2);
});

test('unknown JSON shapes return their original identity, including nonboolean agent values', async () => {
  const accessor = {};
  Object.defineProperty(accessor, 'feature_status', { enumerable: true, get() { throw new Error('unsupported accessor read'); } });
  const accessorAgent = {};
  Object.defineProperty(accessorAgent, 'agent', { enumerable: true, get() { throw new Error('unsupported agent read'); } });
  const inherited = Object.create({ feature_status: { agent: true } });
  const nonEnumerable = Object.defineProperty({}, 'feature_status', { value: { agent: true } });
  const symbol = { feature_status: { agent: true }, [Symbol('unsupported')]: 1 };
  const bodies = [null, undefined, true, 3, 'text', [], {}, { feature_status: null }, { feature_status: [] },
    { feature_status: {} }, ...[false, null, undefined, 'true', 1, 0, {}].map(agent => ({ feature_status: { agent } })),
    accessor, { feature_status: accessorAgent }, inherited, nonEnumerable, symbol, new Date(0)];
  const { transport } = transformed();
  for (const body of bodies) {
    const response = await transport({ fetch() { return { json() { return body; } }; } });
    assert.equal(await response.json(), body);
  }
  const status = Object.assign(Object.create(null), { agent: true, retain: 4 });
  const body = Object.assign(Object.create(null), { feature_status: status, retain: 5 });
  const response = await transport({ fetch() { return { json() { return Promise.resolve(body); } }; } });
  assert.deepEqual(await response.json(), { feature_status: { agent: false, retain: 4 }, retain: 5 });
  assert.equal(status.agent, true);
});

test('fetch, ok and JSON failures propagate without body reads or error replacement', async () => {
  const { transport, consume } = transformed();
  const error = new Error('original failure');
  for (const fetch of [() => { throw error; }, () => Promise.reject(error), () => ({ then(resolve, reject) { reject(error); } })]) {
    await assert.rejects(transport({ fetch }), failure => failure === error);
  }
  let bodyReads = 0;
  const failed = { fetch() { return { ok: false, json() { bodyReads++; throw error; } }; } };
  await assert.rejects(consume(failed), { message: 'original HTTP error' });
  assert.equal(bodyReads, 0);
  const okThrows = await transport({ fetch() { return { get ok() { throw error; }, json() { bodyReads++; } }; } });
  assert.throws(() => okThrows.ok, failure => failure === error);
  assert.equal(bodyReads, 0);
  const jsonFailures = [
    { get json() { throw error; } },
    { json() { throw error; } },
    { json() { return Promise.reject(error); } },
    { json() { return { then(resolve, reject) { reject(error); } }; } },
  ];
  for (const response of jsonFailures) {
    const adapted = await transport({ fetch() { return response; } });
    await assert.rejects(adapted.json(), failure => failure === error);
    await assert.rejects(adapted.json(), failure => failure === error);
  }
  await assert.rejects(transport({ fetch: null }), { message: 'fetch unavailable' });
});

test('mechanical UTF-16 edit preserves outside bytes and refuses stale or already patched ranges', () => {
  const { result } = transformed();
  assert.equal(result.assessment, 'version-scoped-reviewed-pattern');
  assert.equal(result.operation, 'mechanical-edit');
  assert.equal(result.runtime, 'not-verified');
  assert.deepEqual(result.range, { start: recipe.start, end: recipe.end, unit: 'utf16' });
  const before = Buffer.from(fixture.slice(0, recipe.start));
  const after = Buffer.from(fixture.slice(recipe.end));
  const bytes = Buffer.from(result.source);
  assert.deepEqual(bytes.subarray(0, before.length), before);
  assert.deepEqual(bytes.subarray(bytes.length - after.length), after);
  assert.throws(() => transformRequestTransport(result.source, recipe), /does not match/);
  assert.throws(() => transformRequestTransport(fixture, { ...recipe, start: recipe.start + 1 }), /does not match/);
  assert.throws(() => transformRequestTransport(fixture, { start: -1, end: 0, expected: '' }), /does not match/);
  const direct = fixture.replace(expected, 'runtime.fetch(url, options)');
  assert.throws(() => transformRequestTransport(direct, { start: recipe.start, end: recipe.end - 6, expected: 'runtime.fetch(url, options)' }), /must await/);
  const malformed = fixture + '\nfunction {';
  assert.throws(() => transformRequestTransport(malformed, recipe), SyntaxError);
});

const repository = fileURLToPath(new URL('..', import.meta.url));
const binary = join(repository, 'scripts/cua-request-wrapper.mjs');
let createdEvidence = false;
test.before(async () => {
  try { await mkdir(join(repository, 'evidence'), { mode: 0o700 }); createdEvidence = true; }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
});
test.after(async () => { if (createdEvidence) await rmdir(join(repository, 'evidence')); });
async function sandbox(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'cua-wrapper-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function run(directory, args) {
  return runCli(args, { directory, binary, fixture: null });
}

test('prepare CLI refuses unpinned bytes without creating output or changing source', async t => {
  const directory = await sandbox(t);
  const source = join(directory, 'self-authored.mjs');
  await writeFile(source, fixture);
  const output = join(repository, 'evidence', `cua-wrapper-refused-${directory.split('/').at(-1)}`);
  const result = run(directory, ['--source', source, '--output-dir', output]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /identity.*size.*SHA-256/i);
  await assert.rejects(readFile(join(output, 'manifest.json')), { code: 'ENOENT' });
  assert.equal(await readFile(source, 'utf8'), fixture);
  assert.deepEqual(await readdir(directory), ['self-authored.mjs']);
  // Same byte size is insufficient; this inert, self-authored input has the wrong hash.
  const sameSize = Buffer.alloc(1938669, 32);
  await writeFile(source, sameSize);
  const rejected = run(directory, ['--source', source, '--output-dir', output]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /identity.*size.*SHA-256/i);
  assert.deepEqual(await readFile(source), sameSize);
  await assert.rejects(readFile(join(output, 'manifest.json')), { code: 'ENOENT' });
});

test('prepare CLI refuses existing files, directories and symlinks without overwriting', async t => {
  const directory = await sandbox(t);
  const output = await mkdtemp(join(repository, 'evidence/cua-wrapper-test-'));
  t.after(() => rm(output, { recursive: true, force: true }));
  const file = output + '-file';
  const alias = output + '-alias';
  t.after(() => rm(file, { force: true }));
  t.after(() => rm(alias, { force: true }));
  await writeFile(file, 'preserve this');
  await symlink(file, alias);
  for (const path of [output, file, alias]) {
    const result = run(directory, ['--source', join(directory, 'absent.mjs'), '--output-dir', path]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already exists/);
  }
  assert.equal(await readFile(file, 'utf8'), 'preserve this');
  assert.equal(await readFile(alias, 'utf8'), 'preserve this');
  assert.deepEqual(await readdir(output), []);
});

test('prepare CLI limits output to one evidence child and refuses install paths or extra flags', async t => {
  const directory = await sandbox(t);
  const source = join(directory, 'absent.mjs');
  await mkdir(join(directory, 'Synthetic.app'));
  for (const output of [join(directory, 'Synthetic.app/prepared'), join(repository, 'evidence/Synthetic.app'), repository + '/evidence/Synthetic.app/../escaped']) {
    const result = run(directory, ['--source', source, '--output-dir', output]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /\.app output/);
  }
  for (const output of [directory, join(repository, 'evidence/nested/output'), repository, source]) {
    const result = run(directory, ['--source', source, '--output-dir', output]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /one new direct child/);
  }
  for (const args of [[], ['--apply'], ['--source', 'relative', '--output-dir', directory], ['--source', source, '--output-dir', directory, '--profile', 'untrusted']]) {
    const result = run(directory, args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Expected --source/);
  }
  const help = run(directory, ['--help']);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Prepare only/);
  assert.match(help.stdout, /runtime: not-verified/);
  assert.match(help.stdout, /evidence/);
  assert.deepEqual(await readdir(directory), ['Synthetic.app']);
});

test('JSON own __proto__ fields survive as data without changing object prototypes', async () => {
  const body = JSON.parse('{"__proto__":{"retained":1},"feature_status":{"__proto__":{"retained":2},"agent":true}}');
  const { transport } = transformed();
  const response = await transport({ fetch() { return { json() { return body; } }; } });
  const result = await response.json();
  assert.deepEqual(result, JSON.parse('{"__proto__":{"retained":1},"feature_status":{"__proto__":{"retained":2},"agent":false}}'));
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  assert.equal(Object.getPrototypeOf(result.feature_status), Object.prototype);
  assert.equal(Object.hasOwn(result, '__proto__'), true);
  assert.equal(Object.hasOwn(result.feature_status, '__proto__'), true);
  assert.equal(body.feature_status.agent, true);
});
