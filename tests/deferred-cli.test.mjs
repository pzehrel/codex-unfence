import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCli } from './helpers/cli.mjs';

const source = await readFile(new URL('./fixtures/deferred-site-status.js.txt', import.meta.url), 'utf8');

async function sandbox(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'codex-deferred-stage-')));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = join(directory, 'plugins');
  const targets = ['browser', 'chrome'].map(plugin => join(root, plugin, 'synthetic/scripts/browser-service.mjs'));
  for (const target of targets) {
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, source);
  }
  return { directory, root, targets, run: args => runCli(args, { directory }) };
}

test('detect human/JSON exposes deferred stage evidence and remaining proof obligations for both plugins', async t => {
  const box = await sandbox(t);
  const detected = box.run(['detect', '--plugin-root', box.root, '--json']);
  assert.equal(detected.status, 3, detected.stdout + detected.stderr);
  assert.equal(detected.stderr, '');
  const output = JSON.parse(detected.stdout);
  assert.equal(output.outcome, 'incompatible');
  assert.equal(output.data.artifacts.length, 2);
  for (const artifact of output.data.artifacts) {
    assert.equal(artifact.analysis.patternVersion, 'site-status-deferred-v1');
    assert.equal(artifact.analysis.compatibility, 'incompatible');
    assert.equal(artifact.analysis.target, null);
    assert.deepEqual(artifact.analysis.evidence.map(entry => entry.kind), ['initialization', 'predicate', 'source', 'transport', 'response']);
    assert.deepEqual(artifact.analysis.diagnostics.map(entry => entry.code), ['UNPROVEN_CACHE_POLICY', 'DEFERRED_TRANSFORM_DISABLED']);
    for (const entry of artifact.analysis.evidence) {
      assert.equal(entry.range.unit, 'utf16');
      assert.ok(source.slice(entry.range.start, entry.range.end).length > 0);
    }
  }
  const human = box.run(['detect', '--plugin-root', box.root]);
  assert.equal(human.status, 3);
  assert.match(human.stdout, /Evidence initialization:.*utf16.*normal completion/);
  assert.match(human.stdout, /Evidence predicate:.*strict equality to true/);
  assert.match(human.stdout, /Evidence source:.*origin\/pathname\/search/);
  assert.match(human.stdout, /Evidence transport:.*receiver.*GET/);
  assert.match(human.stdout, /Evidence response:.*same HTTP.*JSON.*binding/);
  assert.doesNotMatch(human.stdout, /UNPROVEN_REQUEST_CHAIN/);
  assert.match(human.stdout, /UNPROVEN_CACHE_POLICY/);
  assert.match(human.stdout, /target, transformation and plan publication remain disabled/);
  for (const target of box.targets) assert.equal(await readFile(target, 'utf8'), source);
  assert.deepEqual(await readdir(box.directory), ['plugins']);
});

test('detect human/JSON pinpoints request provenance failures and prepare keeps the installation unchanged', async t => {
  const box = await sandbox(t);
  for (const [text, code] of [
    [source.replace('copy.search = url.search', 'copy.search = url.hash'), 'DEFERRED_REQUEST_SITE_URL'],
    [source.replace('metadata?.session_id', 'metadata?.turn_id'), 'DEFERRED_REQUEST_CONTEXT'],
    [source.replace("method: 'GET'", "method: 'POST'"), 'DEFERRED_REQUEST_GET'],
    [source.replace('await response.json()', 'await other.json()'), 'DEFERRED_RESPONSE_BINDING'],
    [source.replace('runtime.fetch(endpoint, options)', 'runtime.fetch.call(other, endpoint, options)'), 'DEFERRED_TRANSPORT_RECEIVER'],
    [source + '\nconst alias = endpointFor; unknown(alias);', 'DEFERRED_ESCAPED_BINDING'],
  ]) {
    await writeFile(box.targets[0], text);
    const detected = box.run(['detect', '--plugin-root', box.root, '--json']);
    assert.equal(detected.status, 3);
    const analysis = JSON.parse(detected.stdout).data.artifacts[0].analysis;
    assert.equal(analysis.diagnostics[0].code, code);
    assert.ok(text.slice(analysis.diagnostics[0].range.start, analysis.diagnostics[0].range.end).length > 0);
    assert.deepEqual(analysis.evidence, []);
    assert.equal(analysis.target, null);
    const human = box.run(['detect', '--plugin-root', box.root]);
    assert.equal(human.status, 3);
    assert.ok(human.stdout.includes(`[${code}]`));
    assert.equal(await readFile(box.targets[0], 'utf8'), text);
  }
});

test('prepare publishes nothing for explicit deferred targets or all-compatible selection', async t => {
  const box = await sandbox(t);
  for (const [index, selection] of [ ['--target', box.targets[0]], ['--target', box.targets[1]], ['--all-compatible'] ].entries()) {
    const output = join(box.directory, `plan-${index}`);
    const prepared = box.run(['prepare', '--plugin-root', box.root, ...selection, '--output', output, '--json']);
    assert.equal(prepared.status, 3, prepared.stdout + prepared.stderr);
    assert.equal(JSON.parse(prepared.stdout).data, null);
    assert.ok(!(await readdir(box.directory)).includes(`plan-${index}`));
  }
  for (const target of box.targets) assert.equal(await readFile(target, 'utf8'), source);
  assert.deepEqual(await readdir(box.directory), ['plugins']);
});

test('detect gives concrete initialization and semantic diagnostics without partial compatibility', async t => {
  const box = await sandbox(t);
  for (const [text, code] of [
    [source.replace('initialize();\nasync function transport', 'if (ready) initialize();\nasync function transport'), 'DEFERRED_MISSING_INITIALIZATION'],
    [source.replace('flags[key] === true', 'flags[key]'), 'DEFERRED_AGENT_SEMANTICS'],
    [source + '\nconst alias = enabled; unknown(alias);', 'DEFERRED_ESCAPED_BINDING'],
  ]) {
    await writeFile(box.targets[0], text);
    const output = box.run(['detect', '--plugin-root', box.root, '--json']);
    assert.equal(output.status, 3);
    const analysis = JSON.parse(output.stdout).data.artifacts[0].analysis;
    assert.equal(analysis.diagnostics[0].code, code);
    assert.equal(analysis.target, null);
    assert.deepEqual(analysis.evidence, []);
    const human = box.run(['detect', '--plugin-root', box.root]);
    assert.equal(human.status, 3);
    assert.ok(human.stdout.includes(`[${code}]`));
    assert.match(human.stdout, /structural compatibility: incompatible/);
  }
});
