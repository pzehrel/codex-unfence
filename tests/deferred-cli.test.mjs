import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runCli } from './helpers/cli.mjs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const transactionFixture = fileURLToPath(new URL('./fixtures/transaction-boundaries.cjs', import.meta.url));

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);

async function rewriteManifest(directory, mutate) {
  const path = join(directory, 'contents/manifest.json');
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  await mutate(manifest);
  const { contentHash: ignored, ...body } = manifest;
  void ignored;
  manifest.contentHash = digest(canonical(body));
  await writeFile(path, JSON.stringify(manifest));
  await writeFile(join(directory, 'complete.json'), JSON.stringify({formatVersion: 1, id: manifest.id, contentHash: manifest.contentHash}));
}

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
  return { directory, root, targets, run: args => runCli(args, { directory, fixture: transactionFixture }) };
}

test('detect human/JSON exposes complete deferred compatibility and evidence for both plugins', async t => {
  const box = await sandbox(t);
  const detected = box.run(['detect', '--plugin-root', box.root, '--json']);
  assert.equal(detected.status, 0, detected.stdout + detected.stderr);
  assert.equal(detected.stderr, '');
  const output = JSON.parse(detected.stdout);
  assert.equal(output.outcome, 'success');
  assert.equal(output.data.artifacts.length, 2);
  for (const artifact of output.data.artifacts) {
    assert.equal(artifact.analysis.patternVersion, 'site-status-deferred-v1');
    assert.equal(artifact.analysis.compatibility, 'compatible');
    assert.equal(source.slice(artifact.analysis.target.start, artifact.analysis.target.end), 'body');
    assert.deepEqual(artifact.analysis.evidence.map(entry => entry.kind), ['initialization', 'predicate', 'source', 'transport', 'response', 'receiver', 'cache', 'consumption']);
    assert.deepEqual(artifact.analysis.diagnostics, []);
    for (const entry of artifact.analysis.evidence) {
      assert.equal(entry.range.unit, 'utf16');
      assert.ok(source.slice(entry.range.start, entry.range.end).length > 0);
    }
  }
  const human = box.run(['detect', '--plugin-root', box.root]);
  assert.equal(human.status, 0);
  assert.match(human.stdout, /Evidence initialization:.*utf16.*normal completion/);
  assert.match(human.stdout, /Evidence predicate:.*strict equality to true/);
  assert.match(human.stdout, /Evidence source:.*origin\/pathname\/search/);
  assert.match(human.stdout, /Evidence transport:.*receiver.*GET/);
  assert.match(human.stdout, /Evidence response:.*same HTTP.*JSON.*binding/);
  assert.doesNotMatch(human.stdout, /UNPROVEN_REQUEST_CHAIN/);
  assert.match(human.stdout, /Evidence receiver:.*Date.now.*metadata/);
  assert.match(human.stdout, /Evidence cache:.*86400000.*same current promise.*discarded/);
  assert.match(human.stdout, /Evidence consumption:.*checkUrl.*result.blocked/);
  assert.doesNotMatch(human.stdout, /UNPROVEN_CACHE_POLICY/);
  assert.match(human.stdout, /structural compatibility: compatible/);
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
    [source.replace('>= ttl', '> ttl'), 'DEFERRED_CACHE_TTL'],
    [source.replace('=== current &&', '!== current &&'), 'DEFERRED_CACHE_CLEANUP'],
    [source.replace('pending.catch(() => {}), { blocked: cached', 'pending, { blocked: cached'), 'DEFERRED_CACHE_DISCARDED_REQUEST'],
    [source.replace('status.result.blocked', 'status.request.blocked'), 'DEFERRED_POLICY_BLOCKED'],
    [source.replace('return runtime.turn;', 'return other.turn;'), 'DEFERRED_METADATA_ACCESSOR'],
    [source + '\nunknown(policy);', 'DEFERRED_REQUEST_RECEIVER'],
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

test('partial, unknown and ambiguous deferred chains publish no plan for explicit or all-compatible selection', async t => {
  const box = await sandbox(t);
  for (const [index, text] of [
    source.slice(0, source.indexOf('async function enforce(')),
    source.replace('return agentBlocked(body);', 'return agentBlocked(other);'),
    source + '\nclass Other { check(value) { if (value.blocked) throw new Error("blocked"); } }',
    source + '\nconst handles = []; opaqueInstantiate({get: () => handles.push(globalThis)});',
  ].entries()) {
    for (const target of box.targets) await writeFile(target, text);
    const output = join(box.directory, `refused-${index}`);
    for (const selection of [['--target', box.targets[0]], ['--all-compatible']]) {
      const prepared = box.run(['prepare', '--plugin-root', box.root, ...selection, '--output', output, '--json']);
      assert.equal(prepared.status, 3, prepared.stdout + prepared.stderr);
      assert.equal(JSON.parse(prepared.stdout).data, null);
      assert.ok(!(await readdir(box.directory)).includes(`refused-${index}`));
    }
    for (const target of box.targets) assert.equal(await readFile(target, 'utf8'), text);
  }
});

test('review counterexamples cannot publish plans while equivalent safe controls remain rederivable', async t => {
  const box = await sandbox(t);
  const declaration = "var metadata, initMetadata = once(() => { metadata = { name: 'synthetic' }; });";
  const early = source.replace(declaration, '').replace('var initErrors =', 'function swallow(callback) { try { callback(); } catch {} }\nvar early = swallow(() => { initSiteStatus(); });\n' + declaration + '\nvar initErrors =');
  const inline = source.slice(0, source.indexOf('async function enforce(')) + `
    var Gate = class { policies = {siteStatus: async site => {
      if ((await checkSite(this.runtime, site, this.backend))?.result.blocked) throw new Error('Blocked');
    }}; };
    var gate = new Gate;
    gate.runtime = runtime; gate.backend = backend;
  `;
  const entry = '\ngate.policies.siteStatus(site);';
  const variants = [
    [source + '\nconst [proto] = [URL.prototype]; proto.toString = replacement;', 'DEFERRED_HOST_MUTATION'],
    [source + '\nconst proto = URL.prototype || {}; proto.toString = replacement;', 'DEFERRED_HOST_MUTATION'],
    [source + '\nconst proto = (0, URL.prototype); proto.toString = replacement;', 'DEFERRED_HOST_MUTATION'],
    [early, 'DEFERRED_INITIALIZATION_ORDER'],
    [inline + 'gate.policies = {siteStatus: async site => {}};' + entry, 'DEFERRED_POLICY_RECEIVER'],
    [inline + 'gate.policies.siteStatus = async site => {};' + entry, 'DEFERRED_POLICY_RECEIVER'],
    [inline + 'function overwrite(table) { table.siteStatus = async site => {}; } overwrite(gate.policies);' + entry, 'DEFERRED_POLICY_RECEIVER'],
  ];
  for (const [index, [text, code]] of variants.entries()) {
    await writeFile(box.targets[0], text);
    const detected = box.run(['detect', '--plugin-root', box.root, '--json']);
    assert.equal(detected.status, 3);
    const analysis = JSON.parse(detected.stdout).data.artifacts[0].analysis;
    assert.equal(analysis.diagnostics[0].code, code);
    assert.equal(analysis.target, null);
    const output = join(box.directory, `refused-review-${index}`);
    const prepared = box.run(['prepare', '--plugin-root', box.root, '--target', box.targets[0], '--output', output, '--json']);
    assert.equal(prepared.status, 3, prepared.stdout + prepared.stderr);
    assert.equal(JSON.parse(prepared.stdout).data, null);
    assert.ok(!(await readdir(box.directory)).includes(`refused-review-${index}`));
    assert.equal(await readFile(box.targets[0], 'utf8'), text);
  }
  for (const [index, text] of [
    source + '\nconst [local] = [{}]; const alias = (0, local) || {}; alias.value = 1;',
    source.replace('initialize();\nasync function transport', 'initMetadata();\ninitialize();\nasync function transport'),
    inline + entry,
  ].entries()) {
    await writeFile(box.targets[0], text);
    const output = join(box.directory, `safe-review-${index}`);
    const prepared = box.run(['prepare', '--plugin-root', box.root, '--target', box.targets[0], '--output', output, '--json']);
    assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
    const status = box.run(['status', '--plan', output, '--store', join(box.directory, 'store'), '--json']);
    assert.equal(status.status, 0, status.stdout + status.stderr);
    assert.equal(JSON.parse(status.stdout).data.targets[0].state, 'original');
    assert.equal(await readFile(box.targets[0], 'utf8'), text);
  }
});

test('upward once initialization is rederivable through CLI while caught paths and enum mutation publish no plan', async t => {
  const box = await sandbox(t);
  const upward = `var choices, initChoices = once(() => {
    choices = (entry => (entry.First = 'first', entry.Second = 'second', entry))(choices || {});
  });
  var values, initSettings = once(() => { initProtocols(); initChoices(); values = Object.values(choices); });
  initSettings();
  `;
  const safe = source.replace('var initErrors =', upward + 'var initErrors =');
  await writeFile(box.targets[0], safe);
  const detected = box.run(['detect', '--plugin-root', box.root, '--json']);
  assert.equal(detected.status, 0, detected.stdout + detected.stderr);
  assert.equal(JSON.parse(detected.stdout).data.artifacts[0].analysis.compatibility, 'compatible');
  const plan = join(box.directory, 'upward-plan');
  const prepared = box.run(['prepare', '--plugin-root', box.root, '--target', box.targets[0], '--output', plan, '--json']);
  assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
  const status = box.run(['status', '--plan', plan, '--store', join(box.directory, 'store'), '--json']);
  assert.equal(status.status, 0, status.stdout + status.stderr);
  assert.equal(JSON.parse(status.stdout).data.targets[0].state, 'original');
  assert.equal(await readFile(box.targets[0], 'utf8'), safe);
  for (const [index, [text, code]] of [
    [safe.replace('initSettings();\n', 'try { initSettings(); } catch {}\n'), 'DEFERRED_INITIALIZATION_ORDER'],
    [safe + '\nObject.defineProperty(choices, "First", {get: replacement});', 'DEFERRED_ESCAPED_BINDING'],
    [safe.replace('values = Object.values(choices)', 'values = unknown()'), 'DEFERRED_INITIALIZER_EFFECT'],
  ].entries()) {
    await writeFile(box.targets[0], text);
    const output = join(box.directory, `upward-refused-${index}`);
    const result = box.run(['prepare', '--plugin-root', box.root, '--target', box.targets[0], '--output', output, '--json']);
    assert.equal(result.status, 3, result.stdout + result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.data, null);
    assert.ok(result.stdout.includes(code), result.stdout);
    assert.ok(!(await readdir(box.directory)).includes(`upward-refused-${index}`));
    assert.equal(await readFile(box.targets[0], 'utf8'), text);
  }
});

test('prepare publishes rederivable deferred plans for either plugin and all-compatible without overwriting', async t => {
  const box = await sandbox(t);
  for (const [index, selection] of [ ['--target', box.targets[0]], ['--target', box.targets[1]], ['--all-compatible'] ].entries()) {
    const output = join(box.directory, `plan-${index}`);
    const args = ['prepare', '--plugin-root', box.root, ...selection, '--output', output, '--json'];
    const prepared = box.run(args);
    assert.equal(prepared.status, 0, prepared.stdout + prepared.stderr);
    const response = JSON.parse(prepared.stdout);
    assert.equal(response.data.pluginFiles, 'unchanged');
    assert.equal(response.data.runtime, 'not-verified');
    const manifest = JSON.parse(await readFile(response.data.plan.manifestPath, 'utf8'));
    assert.equal(manifest.formatVersion, 2);
    assert.equal(manifest.patternVersion, 'site-status-selection-v1');
    assert.deepEqual(manifest.targets.map(entry => entry.identity.path), index === 2 ? box.targets : [box.targets[index]]);
    for (const entry of manifest.targets) {
      assert.equal(entry.patternVersion, 'site-status-deferred-v1');
      assert.equal(entry.evidence.length, 8);
      assert.equal(entry.expression.before, 'body');
      const original = await readFile(join(output, 'contents', entry.original.file));
      const patched = await readFile(join(output, 'contents', entry.patched.file));
      assert.deepEqual(original, Buffer.from(source));
      assert.equal(entry.original.sha256, digest(original));
      assert.equal(entry.patched.sha256, digest(patched));
    }
    const status = box.run(['status', '--plan', output, '--store', join(box.directory, 'store'), '--json']);
    assert.equal(status.status, 0, status.stdout + status.stderr);
    assert.deepEqual(JSON.parse(status.stdout).data.targets.map(entry => entry.state), manifest.targets.map(() => 'original'));
    const repeated = box.run(args);
    assert.equal(repeated.status, 1);
    assert.equal(JSON.parse(repeated.stdout).diagnostics.at(-1).code, 'OUTPUT_EXISTS');
  }
  for (const target of box.targets) assert.equal(await readFile(target, 'utf8'), source);
});

test('mixed mode selections retain ordered target identities through trusted status, apply and restore', async t => {
  const box = await sandbox(t);
  const legacy = await readFile(new URL('./fixtures/site-status.js.txt', import.meta.url), 'utf8');
  const older = join(box.root, 'browser/older/scripts/browser-service.mjs');
  await mkdir(join(older, '..'), {recursive: true});
  await writeFile(older, legacy);
  const output = join(box.directory, 'mixed');
  const prepare = box.run(['prepare', '--plugin-root', box.root, '--target', box.targets[1], '--target', older, '--target', box.targets[0], '--output', output, '--json']);
  assert.equal(prepare.status, 0, prepare.stdout + prepare.stderr);
  const manifest = JSON.parse(await readFile(JSON.parse(prepare.stdout).data.plan.manifestPath, 'utf8'));
  assert.equal(manifest.formatVersion, 2);
  assert.equal(manifest.patternVersion, 'site-status-selection-v1');
  assert.deepEqual(manifest.targets.map(entry => entry.patternVersion), ['site-status-deferred-v1', 'site-status-v1', 'site-status-deferred-v1']);
  assert.deepEqual(manifest.targets.map(entry => entry.evidence.length), [8, 5, 8]);
  assert.deepEqual(manifest.targets.map(entry => entry.identity.path), [box.targets[1], older, box.targets[0]]);
  const store = join(box.directory, 'store');
  for (const [command, states] of [['status', ['original', 'original', 'original']], ['apply', ['tool-applied', 'tool-applied', 'tool-applied']], ['status', ['tool-applied', 'tool-applied', 'tool-applied']], ['restore', ['original', 'original', 'original']]]) {
    const result = box.run([command, '--plan', output, '--store', store, '--json']);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).data.targets.map(entry => entry.state), states);
  }
  for (const target of box.targets) assert.equal(await readFile(target, 'utf8'), source);
  assert.equal(await readFile(older, 'utf8'), legacy);
  const all = box.run(['prepare', '--plugin-root', box.root, '--all-compatible', '--output', join(box.directory, 'all'), '--json']);
  assert.equal(all.status, 0, all.stdout + all.stderr);
  assert.equal(JSON.parse(all.stdout).data.plan.targetCount, 3);
});

test('rehashed deferred and mixed plan tampering is rejected by public status rederivation', async t => {
  const box = await sandbox(t);
  const legacy = await readFile(new URL('./fixtures/site-status.js.txt', import.meta.url), 'utf8');
  await writeFile(box.targets[1], legacy);
  const mutations = [
    ['unknown target mode', m => { m.targets[0].patternVersion = 'unknown'; }],
    ['mismatched target mode', m => { m.targets[0].patternVersion = 'site-status-v1'; }],
    ['missing target mode', m => { delete m.targets[0].patternVersion; }],
    ['unknown selection mode', m => { m.patternVersion = 'site-status-deferred-v1'; }],
    ['legacy envelope mismatch', m => { m.formatVersion = 1; m.patternVersion = 'site-status-v1'; }],
    ['forged evidence', m => { m.targets[0].evidence[0].description = 'forged'; }],
    ['forged evidence range', m => { m.targets[0].evidence[0].range.start++; }],
    ['wrong evidence order', m => { m.targets[0].evidence.reverse(); }],
    ['forged target range', m => { m.targets[0].expression.range.start++; }],
    ['forged expression', m => { m.targets[0].expression.after = 'false'; }],
    ['rehashed patch', async (m, directory) => {
      const entry = m.targets[0].patched, bytes = Buffer.from(source.replace("'agent'", "'comment'"));
      await writeFile(join(directory, 'contents', entry.file), bytes);
      entry.size = bytes.length; entry.sha256 = digest(bytes);
    }],
    ['rehashed diff', async (m, directory) => {
      const entry = m.targets[0].localDiff, bytes = Buffer.from('forged diff');
      await writeFile(join(directory, 'contents', entry.file), bytes);
      entry.size = bytes.length; entry.sha256 = digest(bytes);
    }],
    // Keep all evidence/artifacts consistent with the legacy source while lying
    // only about mode. Hash validation alone cannot detect this mismatch.
    ['coherent artifacts wrong mode', m => {
      const entry = m.targets[1]; entry.patternVersion = 'site-status-deferred-v1';
      entry.evidence = m.targets[0].evidence;
    }],
  ];
  for (const [index, [label, mutate]] of mutations.entries()) {
    const output = join(box.directory, `tamper-${index}`);
    const prepare = box.run(['prepare', '--plugin-root', box.root, '--all-compatible', '--output', output, '--json']);
    assert.equal(prepare.status, 0, label + prepare.stdout + prepare.stderr);
    await rewriteManifest(output, m => mutate(m, output));
    const status = box.run(['status', '--plan', output, '--store', join(box.directory, 'store'), '--json']);
    assert.equal(status.status, 4, label + status.stdout + status.stderr);
    assert.equal(JSON.parse(status.stdout).diagnostics[0].code, 'INVALID_PLAN');
    if (label === 'coherent artifacts wrong mode') assert.match(JSON.parse(status.stdout).diagnostics[0].message, /pattern differs from rederived transformation/);
    assert.equal(JSON.parse(status.stdout).data, null);
  }
});

test('unknown deferred response-copy contents never claim trusted application', async t => {
  const box = await sandbox(t);
  await writeFile(box.targets[0], source.replace('return agentBlocked(body);', 'return agentBlocked(({...body,feature_status:{...body?.feature_status,agent:false}}));'));
  const status = box.run(['status', '--target', box.targets[0], '--store', join(box.directory, 'store'), '--json']);
  assert.equal(status.status, 4, status.stdout + status.stderr);
  assert.equal(JSON.parse(status.stdout).data.targets[0].state, 'conflict');
  assert.equal(JSON.parse(status.stdout).diagnostics[0].code, 'UNTRUSTED_PATCHED_SHAPE');
  const detect = box.run(['detect', '--plugin-root', box.root, '--json']);
  assert.equal(detect.status, 3);
  const analysis = JSON.parse(detect.stdout).data.artifacts[0].analysis;
  assert.equal(analysis.compatibility, 'incompatible');
  assert.equal(analysis.target, null);
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
