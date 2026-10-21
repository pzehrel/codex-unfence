function required<T>(value: T): NonNullable<T> { assert.ok(value !== null && value !== undefined, 'Expected test value to be present'); return value; }
import type { DependencyEvidenceInput, SourceAnalysis } from '../src/analysis.js';
import type { TestContext } from 'node:test';
import { sourceFixture, repositoryRoot } from './helpers/paths.js';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
// Self-authored inert interface bytes. Never compile, instantiate or execute.
const resource = Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0]);
const base = await readFile(sourceFixture('deferred-site-status.js.txt'), 'utf8');
const source = base + `
let readerLoad;
async function loadReader(host) {
  try { return await host.filesystem.readBytes(new URL('./zxing_reader.wasm', import.meta.url)); }
  catch { return await host.filesystem.readBytes(new URL('../../../node_modules/zxing-wasm/dist/reader/zxing_reader.wasm', import.meta.url)); }
}
async function initializeReader(host) {
  readerLoad == null && (readerLoad = loadReader(host).then(bytes => {
    let copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes), configureReader({overrides:{wasmBinary:copy.buffer}});
  }));
  await readerLoad;
}
function configureReader(options) { return prepareReader(readerFactory, options); }
const defaults = {locateFile: name => new URL(name, import.meta.url).href};
const modules = new WeakMap;
function equalOptions(left, right) {
  return Object.is(left,right) || Object.keys(left).length === Object.keys(right).length && Object.keys(left).every(key => Object.hasOwn(right,key) && left[key] === right[key]);
}
function prepareReader(factory, {overrides, equalityFn = equalOptions, fireImmediately = false} = {}) {
  var previous, comparison;
  let [saved, module] = (previous = modules.get(factory)) == null ? [defaults] : previous, selected = overrides ?? saved, equal;
  if (fireImmediately) {
    if (module && (equal = equalityFn(saved, selected))) return module;
    let ready = factory({...selected});
    return modules.set(factory,[selected,ready]),ready;
  }
  ((comparison = equal) == null ? equalityFn(saved,selected) : comparison) || modules.set(factory,[selected]);
}
async function readerFactory(options = {}) { return options; }
async function decodeReader(factory,input,options) {
  let copied = {...options};
  let module = await prepareReader(factory,{fireImmediately:true});
  let pointer = module._malloc(input.length);
  module.HEAPU8.set(input,pointer);
  let result = module.decode(pointer,input.length,copied);
  module._free(pointer);
  return result;
}
function decode(input,options) { return decodeReader(readerFactory,input,options); }
async function scan(host,input) {
  try { await initializeReader(host); let result = await decode(input,{}); return finish(result); }
  catch { return undefined; }
}
scan(host,input);
`;
const evidenceFor = (source: string): DependencyEvidenceInput => ({ schemaVersion: 1, contract: { id: 'zxing-reader-lifetime-noninterference', revision: 1 }, association: { sourceSha256: digest(source), relativePath: './zxing_reader.wasm', route: 'adjacent' }, resourceBytes: resource });
async function fixtureBuild(t: TestContext): Promise<typeof import('../src/analysis.js')> {
  const directory = await mkdtemp(join(tmpdir(), 'loader-configuration-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'dist'));
  for (const file of ['analysis.js', 'deferred-analysis.js', 'dependency-analysis.js', 'dependency-source.js', 'descriptor-provenance.js', 'resource-provenance.js', 'handle-provenance.js', 'loader-configuration-proof.js', 'source-context.js']) {
    try { await copyFile(new URL(`../src/${file}`, import.meta.url), join(directory, 'dist', file)); }
    catch (error) { if (!(error instanceof Error && 'code' in error) || error.code !== 'ENOENT' || file !== 'loader-configuration-proof.js') throw error; }
  }
  await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  await symlink(join(repositoryRoot, 'node_modules'), join(directory, 'node_modules'), 'dir');
  await writeFile(join(directory, 'dist/dependency-contracts.js'), `export const dependencyContracts = Object.freeze([Object.freeze(${JSON.stringify({ id: 'zxing-reader-lifetime-noninterference', revision: 1, size: resource.length, sha256: digest(resource), binaryVersion: 1, relativePath: './zxing_reader.wasm', imports: '' })})]);`);
  return import(pathToFileURL(join(directory, 'dist/analysis.js')).href);
}
const records = (result: SourceAnalysis, role: string) => required(result.dependencyProof).evidence.filter(entry => entry.description.startsWith(`Loader ${role}:`));

test('catch binding destructuring retains its own failure instead of certifying undefined conversion', async (t: TestContext) => {
  const api = await fixtureBuild(t);
  const changed = source.replace('catch { return undefined; }', 'catch ({message}) { return undefined; }');
  const result = api.transformSource(changed, evidenceFor(changed));
  assert.equal(records(result.analysis, 'caller errors').length, 0);
  assert.equal(required(result.analysis.dependencyProof).acceptedContract, null);
  assert.equal(result.transformation, null);
});

test('unrelated spread and throwing catch cannot certify option-copy or undefined failure records', async (t: TestContext) => {
  const api = await fixtureBuild(t);
  const decoy = source.replace('let copied = {...options};', 'let copied = options; let noise = {...foreign};');
  const wrongOptions = api.transformSource(decoy, evidenceFor(decoy));
  assert.equal(records(wrongOptions.analysis, 'readiness ordering').length, 0);
  for (const changed of [
    source.replace('catch { return undefined; }', 'catch { throw error; return undefined; }'),
    source.replace('catch { return undefined; }', 'catch { return undefined; } finally { throw error; }'),
  ]) {
    const result = api.transformSource(changed, evidenceFor(changed));
    assert.equal(records(result.analysis, 'caller errors').length, 0);
    assert.equal(result.transformation, null);
  }
});

test('decoder parameter replacement cannot retain same-factory readiness evidence', async (t: TestContext) => {
  const api = await fixtureBuild(t);
  const changed = source.replace('let copied = {...options};', 'factory = foreign; let copied = {...options};');
  const result = api.transformSource(changed, evidenceFor(changed));
  assert.equal(records(result.analysis, 'readiness ordering').length, 0);
  assert.equal(result.transformation, null);
});

test('default object publication and nested comparison rewrites lose only their own local provenance', async (t: TestContext) => {
  const api = await fixtureBuild(t);
  const changed = source + '\npublish(defaults);';
  const mutation = api.transformSource(changed, evidenceFor(changed));
  assert.equal(records(mutation.analysis, 'defaults allocation').length, 0);
  assert.equal(records(mutation.analysis, 'cache transition').length, 4);
  assert.equal(mutation.transformation, null);
  const renamed = source.replaceAll('readerLoad','memoSlot').replaceAll('readerFactory','resourceFactory').replaceAll('equalOptions','sameOptions').replace(/\bmodules\b/g,'cacheEntries').replace(/\bmodule\b/g,'instance').replaceAll('\n','\r\n');
  const result = api.analyzeSource(renamed, evidenceFor(renamed));
  assert.equal(records(result, 'readiness ordering').length, 1, JSON.stringify(result.dependencyProof));
  assert.equal(records(result, 'equality syntax').length, 1);
  assert.equal(required(result.dependencyProof).acceptedContract, null);
});

test('minified same-declaration await preserves sequence while conditional configuration cannot prove decoder ordering', async (t: TestContext) => {
  const api = await fixtureBuild(t);
  const minified = source.replace('await initializeReader(host); let result = await decode(input,{})', 'let configured = await initializeReader(host), result = await decode(input,{})').replace('let module = await prepareReader(factory,{fireImmediately:true});\n  let pointer = module._malloc(input.length);', 'let module = await prepareReader(factory,{fireImmediately:true}), pointer = module._malloc(input.length);');
  const valid = api.analyzeSource(minified, evidenceFor(minified));
  assert.equal(records(valid, 'readiness ordering').length, 1);
  const changed = source.replace('await initializeReader(host);', 'if (condition) await initializeReader(host);');
  const invalid = api.transformSource(changed, evidenceFor(changed));
  assert.equal(records(invalid.analysis, 'readiness ordering').length, 0);
  assert.equal(required(invalid.analysis.dependencyProof).acceptedContract, null);
  assert.equal(invalid.transformation, null);
});

test('factory option Gets retain repeated guard and invocation reads, dynamic export collisions and then requirements', async (t: TestContext) => {
  const api = await fixtureBuild(t);
  const changed = source.replace('async function readerFactory(options = {}) { return options; }', `async function readerFactory(options = {}) {
    var module = options;
    if (module.instantiateWasm) module.instantiateWasm(imports,receive);
    if (module.onRuntimeInitialized) module.onRuntimeInitialized();
    for (; module.preInit.length;) module.preInit.pop()();
    module[exportName] = exported;
    module.then;
    return module;
  }`);
  const result = api.transformSource(changed, evidenceFor(changed));
  const gets = records(result.analysis, 'factory option Get');
  assert.equal(gets.length, 7);
  assert.deepEqual(gets.slice(0,4).map(entry => changed.slice(entry.range.start,entry.range.end)), ['module.instantiateWasm', 'module.instantiateWasm', 'module.onRuntimeInitialized', 'module.onRuntimeInitialized']);
  assert.match(required(gets[0]).description, /branch.*separate.*repeated Gets/);
  assert.match(required(gets[4]).description, /loop.*source occurrence.*invocation count/);
  assert.match(required(records(result.analysis, 'factory option write')[0]).description, /dynamic.*hook names.*then.*__proto__.*not excluded/);
  for (const entry of [...gets, ...records(result.analysis, 'factory option write')]) {
    assert.match(entry.description, /conditional.*hooks-absent.*intervening-effects/);
  }
  assert.equal(required(result.analysis.dependencyProof).acceptedContract, null);
  assert.equal(result.transformation, null);
});

test('loader reference evidence distinguishes extra reads, memo aliases, resets and factory publications', async (t: TestContext) => {
  const api = await fixtureBuild(t);
  for (const [label, changed, role] of [
    ['loader extra read', source + '\nloadReader(host);', 'adjacent read'],
    ['memo alias', source + '\npublish(readerLoad);', 'memo assignment'],
    ['memo reset', source + '\nreaderLoad = null;', 'memo assignment'],
    ['factory escape', source + '\npublish(readerFactory);', 'factory references'],
    ['factory replacement', source + '\nreaderFactory = foreign;', 'factory references'],
    ['wrong filesystem receiver', source.replace('host.filesystem.readBytes', 'foreign.filesystem.readBytes'), 'adjacent read'],
    ['cache extra write', source + '\nmodules.set(readerFactory,foreign);', 'cache transition'],
  ] as const) {
    const result = api.transformSource(changed, evidenceFor(changed));
    assert.equal(records(result.analysis, role).length, 0, label);
    assert.equal(required(result.analysis.dependencyProof).acceptedContract, null, label);
    assert.equal(result.transformation, null, label);
  }
  const original = api.analyzeSource(source, evidenceFor(source));
  assert.equal(records(original, 'factory references').length, 1);
  assert.match(required(records(original, 'factory references')[0]).description, /two.*cache keys.*no binding writers.*publication/);
});

test('configuration await is distinct from module readiness and follows the second awaited decoder edge', async (t: TestContext) => {
  const api = await fixtureBuild(t);
  const result = api.transformSource(source, evidenceFor(source));
  assert.equal(records(result.analysis, 'readiness ordering').length, 1);
  const readiness = records(result.analysis, 'readiness ordering')[0];
  assert.match(required(readiness).description, /configuration await.*not module readiness.*second awaited.*factory.*fireImmediately/);
  assert.match(required(readiness).description, /spread.*before.*await.*malloc.*HEAPU8.*decode.*free/);
  assert.match(required(readiness).description, /hooks-absent.*then-assimilation.*intervening-effects/);
  assert.match(required(records(result.analysis, 'caller errors')[0]).description, /explicit await.*undefined.*unawaited.*rejection/);
  for (const [label, changed] of [
    ['missing configuration await', source.replace('await initializeReader(host)', 'initializeReader(host)')],
    ['wrong order', source.replace('await initializeReader(host); let result = await decode(input,{})', 'let result = await decode(input,{}); await initializeReader(host)')],
    ['unawaited cache result', source.replace('let module = await prepareReader', 'let module = prepareReader')],
    ['wrong cache key', source.replace('prepareReader(factory,{fireImmediately:true})', 'prepareReader(foreign,{fireImmediately:true})')],
    ['decoder alias', source.replace('function decode(input,options)', 'publish(decodeReader); function decode(input,options)')],
    ['changed readiness option', source.replace('{fireImmediately:true}', '{fireImmediately:false}')],
  ] as const) {
    const mutation = api.transformSource(changed, evidenceFor(changed));
    assert.equal(records(mutation.analysis, 'readiness ordering').length, 0, label);
    assert.equal(required(mutation.analysis.dependencyProof).acceptedContract, null, label);
    assert.equal(mutation.transformation, null, label);
  }
});

test('equality proves only finite own-string comparison syntax and defaults retain ordinary prototype and callback effects', async (t: TestContext) => {
  const api = await fixtureBuild(t);
  const result = api.analyzeSource(source, evidenceFor(source));
  const equality = records(result, 'equality syntax');
  assert.equal(equality.length, 1);
  assert.match(required(equality[0]).description, /Object.is.*three Object.keys.*every.*Object.hasOwn.*indexed Gets/);
  assert.match(required(equality[0]).description, /Symbols.*prototype.*nonenumerable.*in-place mutation.*never proves hooks/);
  assert.match(required(records(result, 'defaults allocation')[0]).description, /locateFile.*ordinary prototype.*callback effects remain/);
  for (const changed of [
    source.replace('Object.hasOwn(right,key)', 'right.hasOwnProperty(key)'),
    source.replace('left[key] === right[key]', 'left[key] !== right[key]'),
    source.replace('const defaults =', 'publish(equalOptions); const defaults ='),
    source.replace('const defaults =', 'equalOptions = foreign; const defaults ='),
  ]) {
    const mutation = api.transformSource(changed, evidenceFor(changed));
    assert.equal(records(mutation.analysis, 'equality syntax').length, 0);
    assert.equal(required(mutation.analysis.dependencyProof).acceptedContract, null);
    assert.equal(mutation.transformation, null);
  }
});

test('actual-shaped cache transitions retain original options, spread snapshot and reentry or rejection behavior', async (t: TestContext) => {
  const api = await fixtureBuild(t);
  const result = api.analyzeSource(source, evidenceFor(source));
  assert.equal(records(result, 'cache transition').length, 4);
  const descriptions = records(result, 'cache transition').map(entry => entry.description).join('\n');
  assert.match(descriptions, /false and equal.*preserves.*false and unequal.*drops/);
  assert.match(descriptions, /truthy.*equal.*reuses.*falsy.*not reused/);
  assert.match(descriptions, /factory throws.*preserves.*promise.*before.*rejection.*no eviction/);
  assert.match(descriptions, /original options.*snapshot.*Symbols.*no placeholder.*reentry/);
  assert.equal(required(result.dependencyProof).acceptedContract, null);
});

test('adjacent loader evidence retains independent fallback reads, memo assignment timing and copy allocation conditions', async (t: TestContext) => {
  const api = await fixtureBuild(t);
  const result = api.transformSource(source, evidenceFor(source));
  assert.equal(records(result.analysis, 'adjacent read').length, 1);
  assert.equal(source.slice(required(records(result.analysis, 'adjacent read')[0]).range.start,required(records(result.analysis, 'adjacent read')[0]).range.end), "host.filesystem.readBytes(new URL('./zxing_reader.wasm', import.meta.url))");
  assert.match(required(records(result.analysis, 'fallback read')[0]).description, /receiver is read again.*failure propagates/);
  assert.match(required(records(result.analysis, 'memo assignment')[0]).description, /after then returns.*reentry.*rejected promise remains cached/);
  assert.match(required(records(result.analysis, 'copy allocation')[0]).description, /byteLength.*set.*buffer.*inherited/);
  assert.equal(required(result.analysis.dependencyProof).acceptedContract, null);
  assert.equal(result.analysis.compatibility, 'incompatible');
  assert.equal(result.transformation, null);
});
