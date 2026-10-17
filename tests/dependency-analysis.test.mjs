import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { analyzeSource, transformSource } from '../dist/analysis.js';

const source = await readFile(new URL('./fixtures/deferred-site-status.js.txt', import.meta.url), 'utf8');
// Independently authored inert module: one () -> i32 imported function, no body.
// These bytes are never compiled, instantiated or executed.
const resource = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 127, 2, 7, 1, 1, 97, 1, 70, 0, 0]);
const digest = value => createHash('sha256').update(value).digest('hex');
const evidenceFor = (text = source, bytes = resource) => ({
  schemaVersion: 1,
  contract: { id: 'zxing-reader-lifetime-noninterference', revision: 1 },
  association: { sourceSha256: digest(text), relativePath: './zxing_reader.wasm', route: 'adjacent' },
  resourceBytes: bytes,
});

test('explicit bytes are independently measured and unknown resources cannot grant a dependency contract', () => {
  const input = evidenceFor();
  const result = transformSource(source, input);
  assert.equal(result.analysis.compatibility, 'incompatible');
  assert.equal(result.transformation, null);
  assert.equal(result.analysis.dependencyProof.status, 'rejected');
  assert.equal(result.analysis.dependencyProof.acceptedContract, null);
  assert.deepEqual(result.analysis.dependencyProof.resource, {
    size: 24, sha256: 'e03ae00775241ba76d1a252a7b8be899de4142d95b6c36839a67a6f8aad1e163',
    binaryVersion: 1, imports: [{ module: 'a', name: 'F', parameters: [], results: ['i32'] }],
    exports: [], hasStart: false,
  });
  assert.ok(result.analysis.diagnostics.some(entry => entry.code === 'DEPENDENCY_RESOURCE_IDENTITY'));
  assert.deepEqual(input.resourceBytes, resource);
  assert.equal(analyzeSource(source).compatibility, 'compatible');
});

test('a registered inert resource exposes measurements but never skips an unproved JavaScript bridge', async t => {
  // Approval substitution belongs only to this isolated build. Production input
  // has no registry parameter, environment switch, loader or mutation API.
  const { mkdtemp, mkdir, copyFile, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const directory = await mkdtemp(join(tmpdir(), 'dependency-test-build-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'dist'));
  for (const file of ['analysis.js', 'deferred-analysis.js', 'dependency-analysis.js', 'dependency-source.js']) await copyFile(new URL(`../dist/${file}`, import.meta.url), join(directory, 'dist', file));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  // Resolve the unchanged parser dependencies from the repository installation.
  const { symlink } = await import('node:fs/promises');
  await symlink(new URL('../node_modules', import.meta.url).pathname, join(directory, 'node_modules'), 'dir');
  await writeFile(join(directory, 'dist/dependency-contracts.js'), `export const dependencyContracts = Object.freeze([Object.freeze(${JSON.stringify({ id: 'zxing-reader-lifetime-noninterference', revision: 1, size: 24, sha256: digest(resource), binaryVersion: 1, relativePath: './zxing_reader.wasm', imports: 'a.F:>i' })})]);`);
  const isolated = await import(pathToFileURL(join(directory, 'dist/analysis.js')).href);
  await t.test('registry identity cannot replace a mismatched independently decoded interface', async () => {
    const second = join(directory, 'mismatch');
    await mkdir(second);
    for (const file of ['analysis.js', 'deferred-analysis.js', 'dependency-analysis.js', 'dependency-source.js']) await copyFile(new URL(`../dist/${file}`, import.meta.url), join(second, file));
    await writeFile(join(second, 'dependency-contracts.js'), `export const dependencyContracts = [${JSON.stringify({ id: 'zxing-reader-lifetime-noninterference', revision: 1, size: 24, sha256: digest(resource), binaryVersion: 1, relativePath: './zxing_reader.wasm', imports: 'a.F:i>i' })}];`);
    const mismatch = await import(pathToFileURL(join(second, 'analysis.js')).href);
    const result = mismatch.analyzeSource(source, evidenceFor());
    assert.equal(result.dependencyProof.diagnostics[0].code, 'DEPENDENCY_IMPORT_INTERFACE');
    assert.equal(result.dependencyProof.registeredContract, null);
  });
  const analysis = isolated.analyzeSource(source, evidenceFor());
  assert.equal(analysis.compatibility, 'incompatible');
  assert.equal(analysis.target, null);
  assert.equal(analysis.dependencyProof.registeredContract.id, 'zxing-reader-lifetime-noninterference');
  assert.equal(analysis.dependencyProof.status, 'incomplete');
  assert.equal(analysis.dependencyProof.acceptedContract, null);
  assert.equal(analysis.dependencyProof.diagnostics[0].code, 'DEPENDENCY_LOADER_UNPROVEN');
  await t.test('measured import signatures must match the compiled contract interface', () => {
    const changed = resource.slice();
    changed[14] = 126; // A valid different result type, i64 instead of i32.
    const result = isolated.analyzeSource(source, evidenceFor(source, changed));
    assert.equal(result.dependencyProof.resource.imports[0].results[0], 'i64');
    assert.equal(result.dependencyProof.acceptedContract, null);
    assert.equal(result.dependencyProof.diagnostics[0].code, 'DEPENDENCY_RESOURCE_IDENTITY');
  });
  await t.test('finite loader proves both read branches and reports the next missing initialization edge', () => {
    const text = source + `
async function loadReader(host) {
  try { return await host.filesystem.readBytes(new URL('./zxing_reader.wasm', import.meta.url)); }
  catch { return await host.filesystem.readBytes(new URL('../../../node_modules/zxing-wasm/dist/reader/zxing_reader.wasm', import.meta.url)); }
}
`;
    const result = isolated.transformSource(text, evidenceFor(text));
    assert.equal(result.analysis.compatibility, 'incompatible');
    assert.equal(result.transformation, null);
    assert.equal(result.analysis.dependencyProof.evidence.length, 1);
    assert.match(result.analysis.dependencyProof.evidence[0].description, /fallback/);
    assert.equal(result.analysis.dependencyProof.diagnostics[0].code, 'DEPENDENCY_INITIALIZATION_UNPROVEN');
    const copied = text + `
let readerLoad;
async function initializeReader(host) {
  readerLoad == null && (readerLoad = loadReader(host).then(bytes => {
    let copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes), configureReader({overrides:{wasmBinary:copy.buffer}});
  }));
  await readerLoad;
}
function configureReader(options) { return prepareReader(readerFactory, options); }
async function readerFactory(options = {}) { return options; }
`;
    const next = isolated.analyzeSource(copied, evidenceFor(copied));
    assert.equal(next.dependencyProof.evidence.length, 2);
    assert.match(next.dependencyProof.evidence[1].description, /copy/);
    assert.equal(next.dependencyProof.diagnostics[0].code, 'DEPENDENCY_CACHE_UNPROVEN');
    const cache = copied + `
const defaultReaderOptions = {locateFile:(name, prefix) => prefix + name};
const readerStates = new WeakMap;
function equalOptions(left, right) {
  return Object.is(left,right) || Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => Object.hasOwn(right,key) && left[key] === right[key]);
}
function prepareReader(factory, {overrides, equalityFn = equalOptions, fireImmediately = false} = {}) {
  var previous, comparison;
  let [saved, module] = (previous = readerStates.get(factory)) == null ? [defaultReaderOptions] : previous, selected = overrides ?? saved, equal;
  if (fireImmediately) {
    if (module && (equal = equalityFn(saved, selected))) return module;
    let ready = factory({...selected});
    return readerStates.set(factory,[selected,ready]),ready;
  }
  ((comparison = equal) == null ? equalityFn(saved,selected) : comparison) || readerStates.set(factory,[selected]);
}
`;
    const cached = isolated.analyzeSource(cache, evidenceFor(cache));
    assert.equal(cached.dependencyProof.evidence.length, 3);
    assert.equal(cached.dependencyProof.diagnostics[0].code, 'DEPENDENCY_LIFETIME_UNPROVEN');
    const escaped = cache + '\nunknown(readerStates);';
    const rejected = isolated.analyzeSource(escaped, evidenceFor(escaped));
    assert.equal(rejected.dependencyProof.diagnostics[0].code, 'DEPENDENCY_PRIVATE_STATE_ESCAPE');
    assert.equal(rejected.dependencyProof.evidence.length, 2);
    for (const [label, changed, code] of [
      ['extra loader effect', cache.replace('try { return await host.filesystem', 'try { unknown(); return await host.filesystem'), 'DEPENDENCY_LOADER_UNPROVEN'],
      ['wrong adjacent path', cache.replace("new URL('./zxing_reader.wasm'", "new URL('./other.wasm'"), 'DEPENDENCY_LOADER_UNPROVEN'],
      ['wrong fallback', cache.replace('../../../node_modules/zxing-wasm/dist/reader/zxing_reader.wasm', './fallback.wasm'), 'DEPENDENCY_LOADER_UNPROVEN'],
      ['extra hook own key', cache.replace('wasmBinary:copy.buffer', 'wasmBinary:copy.buffer,preRun:unknown'), 'DEPENDENCY_INITIALIZATION_UNPROVEN'],
      ['copy aliases input', cache.replace('new Uint8Array(bytes.byteLength)', 'bytes'), 'DEPENDENCY_INITIALIZATION_UNPROVEN'],
      ['merge instead of replace', cache.replace('selected = overrides ?? saved', 'selected = {...saved,...overrides}'), 'DEPENDENCY_CACHE_UNPROVEN'],
      ['direct cache alias', cache + '\nconst alias = readerStates;', 'DEPENDENCY_PRIVATE_STATE_ESCAPE'],
      ['cache reflection', cache + '\nReflect.set(readerStates,"get",unknown);', 'DEPENDENCY_PRIVATE_STATE_ESCAPE'],
      ['extra cache operation', cache.replace('var previous, comparison;', 'unknown(); var previous, comparison;'), 'DEPENDENCY_CACHE_UNPROVEN'],
    ]) {
      const result = isolated.transformSource(changed, evidenceFor(changed));
      assert.equal(result.analysis.dependencyProof.diagnostics[0].code, code, label);
      assert.equal(result.analysis.dependencyProof.acceptedContract, null, label);
      assert.equal(result.transformation, null, label);
    }
    for (const changed of [cache + '\nObject.prototype.preRun = unknown;', cache + '\nconst root = Object.prototype; Reflect.set(root,"instantiateWasm",unknown);', cache + '\nconst root = Object.prototype; unknown?.(root);']) {
      const result = isolated.transformSource(changed, evidenceFor(changed));
      assert.ok(result.analysis.diagnostics.some(entry => entry.code === 'DEFERRED_HOST_MUTATION'));
      assert.equal(result.analysis.dependencyProof.acceptedContract, null);
      assert.equal(result.transformation, null);
    }
    const renamed = cache.replace(/\breaderStates\b/g, 'privateModules').replace(/\bloadReader\b/g, 'readModule').replace(/\bcopy\b/g, 'ownedBytes').replaceAll('\n', '\r\n');
    const supported = isolated.analyzeSource(renamed, evidenceFor(renamed));
    assert.equal(supported.dependencyProof.evidence.length, 3);
    assert.equal(supported.dependencyProof.diagnostics[0].code, 'DEPENDENCY_LIFETIME_UNPROVEN');
    const glue = cache.replace('async function readerFactory(options = {}) { return options; }', `async function readerFactory(options = {}) {
  class Value {}
  function installMethods() { Object.assign(Value.prototype,{release(){ unknown(this); }}); }
  installMethods();
  return options;
}`);
    const unresolved = isolated.analyzeSource(glue, evidenceFor(glue));
    const blocker = unresolved.dependencyProof.diagnostics[0];
    assert.equal(blocker.code, 'DEPENDENCY_GLUE_EFFECT_UNPROVEN');
    assert.equal(glue.slice(blocker.range.start, blocker.range.end), 'Object.assign(Value.prototype,{release(){ unknown(this); }})');
    assert.match(blocker.message, /prototype/);
    assert.equal(unresolved.dependencyProof.acceptedContract, null);
  });
});

test('wrong contract, association, malformed interfaces and changed bytes give specific public refusals', () => {
  const invalid = [
    [{ ...evidenceFor(), contract: { id: 'arbitrary', revision: 1 } }, 'DEPENDENCY_CONTRACT_UNKNOWN'],
    [{ ...evidenceFor(), contract: { id: 'zxing-reader-lifetime-noninterference', revision: 2 } }, 'DEPENDENCY_CONTRACT_UNKNOWN'],
    [{ ...evidenceFor(), association: { ...evidenceFor().association, sourceSha256: '0'.repeat(64) } }, 'DEPENDENCY_ASSOCIATION'],
    [{ ...evidenceFor(), association: { ...evidenceFor().association, route: 'fallback' } }, 'DEPENDENCY_ASSOCIATION'],
    [{ ...evidenceFor(), association: { ...evidenceFor().association, relativePath: '/tmp/zxing_reader.wasm' } }, 'DEPENDENCY_ASSOCIATION'],
    [evidenceFor(source, resource.subarray(0, resource.length - 1)), 'DEPENDENCY_BINARY_INTERFACE'],
    [evidenceFor(source, Uint8Array.from([0, 97, 115, 109, 2, 0, 0, 0])), 'DEPENDENCY_BINARY_INTERFACE'],
    [evidenceFor(source, Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, 1, 255, 255, 255, 255, 16])), 'DEPENDENCY_BINARY_INTERFACE'],
  ];
  for (const [input, code] of invalid) {
    const result = transformSource(source, input);
    assert.equal(result.analysis.dependencyProof.diagnostics[0].code, code);
    assert.equal(result.analysis.dependencyProof.acceptedContract, null);
    assert.equal(result.transformation, null);
  }
});

test('invalid evidence versions and arbitrary trusted flags cannot silently fall back to source-only acceptance', () => {
  for (const input of [null, true, { trusted: true }, { ...evidenceFor(), schemaVersion: 2 }, { ...evidenceFor(), trusted: true }]) {
    const result = transformSource(source, input);
    assert.equal(result.analysis.compatibility, 'incompatible');
    assert.equal(result.transformation, null);
    assert.equal(result.analysis.dependencyProof.acceptedContract, null);
    assert.equal(result.analysis.dependencyProof.diagnostics[0].code, 'DEPENDENCY_EVIDENCE_FORMAT');
  }
});
