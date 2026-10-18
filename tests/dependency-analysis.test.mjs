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
  for (const file of ['analysis.js', 'deferred-analysis.js', 'dependency-analysis.js', 'dependency-source.js', 'resource-provenance.js', 'handle-provenance.js']) await copyFile(new URL(`../dist/${file}`, import.meta.url), join(directory, 'dist', file));
  await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  // Resolve the unchanged parser dependencies from the repository installation.
  const { symlink } = await import('node:fs/promises');
  await symlink(new URL('../node_modules', import.meta.url).pathname, join(directory, 'node_modules'), 'dir');
  await writeFile(join(directory, 'dist/dependency-contracts.js'), `export const dependencyContracts = Object.freeze([Object.freeze(${JSON.stringify({ id: 'zxing-reader-lifetime-noninterference', revision: 1, size: 24, sha256: digest(resource), binaryVersion: 1, relativePath: './zxing_reader.wasm', imports: 'a.F:>i' })})]);`);
  const isolated = await import(pathToFileURL(join(directory, 'dist/analysis.js')).href);
  await t.test('registry identity cannot replace a mismatched independently decoded interface', async () => {
    const second = join(directory, 'mismatch');
    await mkdir(second);
    for (const file of ['analysis.js', 'deferred-analysis.js', 'dependency-analysis.js', 'dependency-source.js', 'resource-provenance.js', 'handle-provenance.js']) await copyFile(new URL(`../dist/${file}`, import.meta.url), join(second, file));
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
  await t.test('finite loader proves both read branches and reports the next missing initialization edge', async t => {
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
    await t.test('private constructor methods have finite effects on their proven local receivers', () => {
      const privateGlue = cache.replace('async function readerFactory(options = {}) { return options; }', `async function readerFactory(options = {}) {
  function Value(count) { this.count = count; }
  function installMethods() { Object.assign(Value.prototype,{
    read(){ return this.count; },
    set(count){ this.count = count; return this.count; }
  }); }
  installMethods();
  const record = new Value(3);
  record.set(4);
  record.read();
  return options;
}`);
      const result = isolated.transformSource(privateGlue, evidenceFor(privateGlue));
      assert.equal(result.analysis.dependencyProof.diagnostics[0].code, 'DEPENDENCY_LIFETIME_UNPROVEN');
      assert.equal(result.analysis.dependencyProof.evidence.length, 4);
      assert.match(result.analysis.dependencyProof.evidence[3].description, /private.*receiver/i);
      assert.equal(result.analysis.dependencyProof.acceptedContract, null);
      assert.equal(result.transformation, null);
      for (const [label, changed] of [
        ['constructor escape', privateGlue.replace('installMethods();', 'installMethods(); unknown(Value);')],
        ['prototype escape', privateGlue.replace('installMethods();', 'installMethods(); unknown(Value.prototype);')],
        ['instance escape', privateGlue.replace('record.set(4);', 'unknown(record); record.set(4);')],
        ['instance replacement', privateGlue.replace('record.set(4);', 'record.set = unknown; record.set(4);')],
        ['method extraction', privateGlue.replace('record.read();', 'const read = record.read; read();')],
        ['unknown callback', privateGlue.replace('return this.count;', 'return unknown(this);')],
        ['accessor', privateGlue.replace('read(){', 'get read(){')],
        ['prototype replacement', privateGlue.replace('installMethods();', 'installMethods(); Value.prototype = {};')],
        ['reflective write', privateGlue.replace('record.set(4);', 'Reflect.set(record,"set",unknown); record.set(4);')],
        ['unproven arguments', privateGlue.replace('new Value(3)', 'new Value(unknown)')],
        ['unknown statement', privateGlue.replace('set(count){', 'set(count){ while (count) unknown();')],
        ['prototype method mutation', privateGlue.replace('installMethods();', 'installMethods(); Value.prototype.read.call = unknown;')],
        ['recursive converter', privateGlue.replace('read(){ return this.count; }', 'read(){ return this.read(); }')],
        ['object-valued constructor', privateGlue.replace('this.count = count;', 'this.count = {};')],
        ['constructor escape from body', privateGlue.replace('this.count = count;', 'unknown(this); this.count = count;')],
        ['method receiver escape', privateGlue.replace('return this.count;', 'return this;')],
        ['constructor arguments alias', privateGlue.replace('this.count = count;', 'this.count = arguments;')],
        ['installer called twice', privateGlue.replace('installMethods();', 'installMethods(); installMethods();')],
        ['method before construction', privateGlue.replace('const record = new Value(3);', 'record.read(); const record = new Value(3);')],
      ]) {
        const rejected = isolated.transformSource(changed, evidenceFor(changed));
        assert.equal(rejected.analysis.dependencyProof.diagnostics[0].code, 'DEPENDENCY_GLUE_EFFECT_UNPROVEN', label);
        assert.equal(rejected.analysis.dependencyProof.evidence.length, 3, label);
        assert.equal(rejected.transformation, null, label);
      }
    });
    await t.test('private methods may call a closed local conversion function with their own receiver', () => {
      const text = cache.replace('async function readerFactory(options = {}) { return options; }', `async function readerFactory(options = {}) {
  function Descriptor(value) { this.value = value; }
  function readValue() { return this.value; }
  function installMethods() {
    Object.assign(Descriptor.prototype,{read:readValue,convert(value){ return value + this.read(); }});
  }
  installMethods();
  const item = new Descriptor(8);
  item.convert(2);
  return options;
}`);
      const result = isolated.analyzeSource(text, evidenceFor(text));
      assert.equal(result.dependencyProof.evidence.length, 4);
      assert.equal(result.dependencyProof.diagnostics[0].code, 'DEPENDENCY_LIFETIME_UNPROVEN');
      for (const changed of [
        text.replace('return this.value;', 'return unknown(this);'),
        text.replace('installMethods();', 'installMethods(); unknown(readValue);'),
        text.replace('installMethods();', 'installMethods(); readValue = unknown;'),
        text.replace('return value + this.read();', 'return value + this.read.call(unknown);'),
      ]) {
        const rejected = isolated.transformSource(changed, evidenceFor(changed));
        assert.equal(rejected.analysis.dependencyProof.diagnostics[0].code, 'DEPENDENCY_GLUE_EFFECT_UNPROVEN');
        assert.equal(rejected.transformation, null);
      }
    });
    await t.test('bound descriptor converters preserve their proven private receiver', () => {
      const text = cache.replace('async function readerFactory(options = {}) { return options; }', `async function readerFactory(options = {}) {
  function Descriptor(value) { this.value = value; }
  function installMethods() {
    Object.assign(Descriptor.prototype,{readValueFromPointer(pointer){ return this.value + pointer; },toWireType(value){ return value; }});
  }
  installMethods();
  const item = new Descriptor(8);
  const read = item.readValueFromPointer.bind(item);
  const write = item.toWireType.bind(item);
  read(2);
  write(4);
  return options;
}`);
      const result = isolated.analyzeSource(text, evidenceFor(text));
      assert.equal(result.dependencyProof.evidence.length, 4);
      assert.equal(result.dependencyProof.diagnostics[0].code, 'DEPENDENCY_LIFETIME_UNPROVEN');
      for (const [label, changed] of [
        ['wrong receiver', text.replace('bind(item)', 'bind(options)')],
        ['bound callback escape', text.replace('read(2);', 'unknown(read); read(2);')],
        ['converter replacement', text.replace('read(2);', 'read = unknown; read(2);')],
        ['additional bound argument', text.replace('bind(item)', 'bind(item,unknown)')],
        ['unknown call argument', text.replace('read(2);', 'read(options);')],
        ['unknown converter body', text.replace('return this.value + pointer;', 'return unknown(this);')],
      ]) {
        const rejected = isolated.transformSource(changed, evidenceFor(changed));
        assert.equal(rejected.analysis.dependencyProof.diagnostics[0].code, 'DEPENDENCY_GLUE_EFFECT_UNPROVEN', label);
        assert.equal(rejected.transformation, null, label);
      }
    });
    await t.test('private descriptor registration and lookup preserve converter provenance', () => {
      const text = cache.replace('async function readerFactory(options = {}) { return options; }', `async function readerFactory(options = {}) {
  function Descriptor(value) { this.value = value; }
  function installMethods() {
    Object.assign(Descriptor.prototype,{readValueFromPointer(pointer){ return this.value + pointer; }});
  }
  const descriptors = {};
  function register(type, descriptor) {
    if (Object.hasOwn(descriptors,type)) throw Error("duplicate");
    descriptors[type] = descriptor;
  }
  function lookup(type) {
    const descriptor = descriptors[type];
    if (descriptor === undefined) throw Error("unknown");
    return descriptor;
  }
  installMethods();
  const item = new Descriptor(8);
  register(1,item);
  const selected = lookup(1);
  const read = selected.readValueFromPointer.bind(selected);
  read(2);
  return options;
}`);
      const result = isolated.analyzeSource(text, evidenceFor(text));
      assert.equal(result.dependencyProof.evidence.length, 4);
      assert.equal(result.dependencyProof.diagnostics[0].code, 'DEPENDENCY_LIFETIME_UNPROVEN');
      const pending = text.replace('register(1,item);', `function provide(type, callback) { register(type,callback()); }
  provide(1,() => item);`);
      const resolved = isolated.analyzeSource(pending, evidenceFor(pending));
      assert.equal(resolved.dependencyProof.evidence.length, 4);
      assert.equal(resolved.dependencyProof.diagnostics[0].code, 'DEPENDENCY_LIFETIME_UNPROVEN');
      for (const changed of [
        pending.replace('() => item', 'unknown'),
        pending.replace('() => item', '() => unknown(item)'),
        pending.replace('register(type,callback());', 'unknown(callback); register(type,callback());'),
        pending.replace('register(type,callback());', 'register(type,callback()); unknown();'),
        pending.replace('provide(1,() => item);', 'unknown(provide); provide(1,() => item);'),
        pending.replace('() => item', '() => options'),
      ]) {
        const rejected = isolated.transformSource(changed, evidenceFor(changed));
        assert.equal(rejected.analysis.dependencyProof.diagnostics[0].code, 'DEPENDENCY_GLUE_EFFECT_UNPROVEN');
        assert.equal(rejected.transformation, null);
      }
      for (const [label, changed] of [
        ['table escape', text.replace('register(1,item);', 'unknown(descriptors); register(1,item);')],
        ['descriptor replacement', text.replace('const selected', 'descriptors[1] = unknown; const selected')],
        ['table accessor', text.replace('const selected', 'Object.defineProperty(descriptors,"1",{get:unknown}); const selected')],
        ['unproven descriptor', text.replace('register(1,item);', 'register(1,options);')],
        ['unproven type key', text.replace('register(1,item);', 'register("__proto__",item);')],
        ['helper escape', text.replace('register(1,item);', 'unknown(register); register(1,item);')],
        ['lookup escape', text.replace('const selected', 'unknown(lookup); const selected')],
        ['unknown registration effect', text.replace('descriptors[type] = descriptor;', 'unknown(descriptor); descriptors[type] = descriptor;')],
        ['selected descriptor escape', text.replace('read(2);', 'unknown(selected); read(2);')],
      ]) {
        const rejected = isolated.transformSource(changed, evidenceFor(changed));
        assert.equal(rejected.analysis.dependencyProof.diagnostics[0].code, 'DEPENDENCY_GLUE_EFFECT_UNPROVEN', label);
        assert.equal(rejected.transformation, null, label);
      }
    });
    await t.test('registration callbacks expose individual fresh metadata field stores without approving callback effects', () => {
      const text = cache.replace('async function readerFactory(options = {}) { return options; }', `async function readerFactory(options = {}) {
  function Base() {}
  function install() { const prototype = Base.prototype; Object.assign(prototype,{release(){ unknown(this); }}); }
  function Metadata(name, constructor, prototype, destructor, base, actual, upcast, downcast) {
    this.name = name, this.constructor = constructor, this.instancePrototype = prototype,
    this.rawDestructor = destructor, this.baseClass = base, this.getActualType = actual,
    this.upcast = upcast, this.downcast = downcast, this.pureVirtualFunctions = [];
  }
  function schedule(types, dependencies, callback) { return callback(dependencies); }
  function registerClass(type, raw) {
    schedule([type],[],converters => {
      const prototype = Base.prototype;
      const metadata = new Metadata("Class",null,prototype,raw,null,raw,raw,raw);
      return [metadata];
    });
  }
  const imports = {a:{registerClass}};
  install();
  return imports;
}`);
      const result = isolated.transformSource(text, evidenceFor(text));
      const stores = result.analysis.dependencyProof.evidence.filter(entry => /fresh own data field/.test(entry.description));
      assert.equal(stores.length, 9);
      assert.equal(text.slice(stores[0].range.start,stores[0].range.end), 'this.name = name');
      assert.equal(result.analysis.dependencyProof.diagnostics[0].code, 'DEPENDENCY_GLUE_EFFECT_UNPROVEN');
      assert.equal(result.analysis.dependencyProof.acceptedContract, null);
      assert.equal(result.transformation, null);
      for (const changed of [
        text.replace('this.name = name', 'this.name = unknown(name)'),
        text.replace('this.name = name', 'this.__proto__ = name'),
        text.replace('this.name = name', 'Object.defineProperty(this,"name",{get:unknown})'),
        text.replace('new Metadata("Class",null,prototype,raw,null,raw,raw,raw)', 'Metadata("Class",null,prototype,raw,null,raw,raw,raw)'),
        text.replace('schedule([type],[],converters =>', 'unknown(Metadata); schedule([type],[],converters =>'),
        text.replace('this.pureVirtualFunctions = []', 'this.pureVirtualFunctions = unknown'),
        text.replace('this.name = name', 'this.name = name, this.name = name'),
        text.replace('this.name = name', 'this.name = name; return unknown(this); this.name = name'),
        text.replace('const imports = {a:{registerClass}};', 'const imports = {};'),
        text.replace('schedule([type],[],converters =>', 'unknownSchedule([type],[],converters =>'),
        text.replace('function Metadata(name,', 'function Metadata(name = unknown(),'),
      ]) {
        const rejected = isolated.analyzeSource(changed, evidenceFor(changed));
        assert.equal(rejected.dependencyProof.evidence.filter(entry => /fresh own data field/.test(entry.description)).length, 0);
        assert.equal(rejected.dependencyProof.acceptedContract, null);
      }
    });
    await t.test('installer-local prototype aliases retain the same private operation proof', () => {
      const text = cache.replace('async function readerFactory(options = {}) { return options; }', `async function readerFactory(options = {}) {
  function Descriptor(value) { this.value = value; }
  function installMethods() {
    const prototype = Descriptor.prototype;
    Object.assign(prototype,{read(){ return this.value; }});
  }
  installMethods();
  const item = new Descriptor(8);
  item.read();
  return options;
}`);
      const result = isolated.analyzeSource(text, evidenceFor(text));
      assert.equal(result.dependencyProof.evidence.length, 4);
      const renamed = text.replace(/\bDescriptor\b/g, 'RecordType').replace(/\bprototype\b(?= =|,)/g, 'localPrototype').replaceAll('\n', '\r\n');
      const supported = isolated.analyzeSource(renamed, evidenceFor(renamed));
      assert.equal(supported.dependencyProof.evidence.length, 4);
      for (const changed of [
        text.replace('Object.assign(prototype', 'unknown(prototype); Object.assign(prototype'),
        text.replace('return this.value;', 'return unknown(this);'),
        text.replace('const prototype', 'let prototype').replace('Object.assign(prototype', 'prototype = Object.prototype; Object.assign(prototype'),
      ]) {
        const rejected = isolated.transformSource(changed, evidenceFor(changed));
        assert.equal(rejected.analysis.dependencyProof.diagnostics[0].code, 'DEPENDENCY_GLUE_EFFECT_UNPROVEN');
        assert.equal(rejected.transformation, null);
      }
    });
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
