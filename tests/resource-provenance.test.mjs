import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const digest = value => createHash('sha256').update(value).digest('hex');
// Self-authored inert interface: a.sa takes thirteen i32s; exports include
// one table, one memory and a function. No compilation or instantiation occurs.
const text = value => [value.length, ...Buffer.from(value)];
const section = (id, bytes) => [id, bytes.length, ...bytes];
const resource = Uint8Array.from([
  0, 97, 115, 109, 1, 0, 0, 0,
  ...section(1, [1, 96, 13, ...Array(13).fill(127), 0]),
  ...section(2, [1, ...text('a'), ...text('sa'), 0, 0]),
  ...section(7, [3, ...text('callbacks'), 1, 0, ...text('memory'), 2, 0, ...text('wideCall'), 0, 0]),
]);
const evidenceFor = source => ({
  schemaVersion: 1,
  contract: { id: 'zxing-reader-lifetime-noninterference', revision: 1 },
  association: { sourceSha256: digest(source), relativePath: './zxing_reader.wasm', route: 'adjacent' },
  resourceBytes: resource,
});
const base = await readFile(new URL('./fixtures/deferred-site-status.js.txt', import.meta.url), 'utf8');
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
const defaults = {};
const modules = new WeakMap;
function equalOptions(left, right) { return left === right; }
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
async function readerFactory(options = {}) {
  var binary = options.wasmBinary, filename;
  function decode(pointer) { return pointer; }
  function readBytes(name) { return new Uint8Array(binary); }
  async function instantiateBytes(name, imports) {
    try { var bytes = await readBytes(name); return await WebAssembly.instantiate(bytes,imports); }
    catch (error) { report(error); abort(error); }
  }
  async function selectRoute(input,name,imports) {
    if (!input && WebAssembly.instantiateStreaming) try {
      var response = fetch(name,{credentials:'same-origin'});
      return await WebAssembly.instantiateStreaming(response,imports);
    } catch (error) { report(error); }
    return instantiateBytes(name,imports);
  }
  function makeImports() { return {a:importFunctions}; }
  async function initialize() {
    function receive(instance,module) { return exports = instance.exports,assignExports(exports),ready(),exports; }
    function receiveResult(result) { return receive(result.instance); }
    var imports = makeImports();
    return options.instantiateWasm ? new Promise((resolve,reject) => {
      options.instantiateWasm(imports,(instance,module) => { resolve(receive(instance,module)); });
    }) : (filename != null || (filename = locate()),receiveResult(await selectRoute(binary,filename,imports)));
  }
  var wideCalls = {}, tableCache = [];
  var invokeWide = (signature,pointer,args) => {
    signature = signature.replace(/p/g,'i'); var callback = wideCalls[signature]; return callback(pointer,...args);
  };
  var tableFunction = pointer => { var callback = tableCache[pointer]; return callback || (tableCache[pointer] = callback = table.get(pointer)),callback; };
  var invoke = function(signature,pointer) {
    let args = arguments.length > 2 && arguments[2] !== void 0 ? arguments[2] : [];
    if (arguments.length > 3 && arguments[3] !== void 0 && arguments[3],signature.includes('j')) return invokeWide(signature,pointer,args);
    var result = tableFunction(pointer)(...args); function identity(value) { return value; } return result;
  };
  var wrap = function(signature,pointer) {
    let flag = arguments.length > 2 && arguments[2] !== void 0 && arguments[2];
    return function() { return invoke(signature,pointer,[...arguments],flag); };
  };
  var resolveCallback = function(signature,pointer) {
    arguments.length > 2 && arguments[2] !== void 0 && arguments[2],signature = decode(signature);
    function select() { return signature.includes('j') ? wrap(signature,pointer) : tableFunction(pointer); }
    var callback = select();
    return typeof callback != 'function' && fail('unknown callback'),callback;
  };
  function Metadata(name,constructor,prototype,destructor,base,actual,upcast,downcast) {
    this.name = name, this.constructor = constructor, this.instancePrototype = prototype,
    this.rawDestructor = destructor, this.baseClass = base, this.getActualType = actual,
    this.upcast = upcast, this.downcast = downcast, this.pureVirtualFunctions = [];
  }
  function schedule(types,dependencies,callback) { return callback(dependencies); }
  var registerClass = (type,pointerType,constType,baseType,actualSignature,actual,upSignature,up,downSignature,down,name,destroySignature,destroy) => {
    name = decode(name),actual = resolveCallback(actualSignature,actual),up && (up = resolveCallback(upSignature,up)),down && (down = resolveCallback(downSignature,down)),destroy = resolveCallback(destroySignature,destroy);
    schedule([type,pointerType,constType],baseType ? [baseType] : [],converters => {
      var metadata = new Metadata(name,null,null,destroy,null,actual,up,down);
      return [metadata];
    });
  };
  var table, memory;
  function assignExports(value) { wideCalls.viijii = value.wideCall,memory = value.memory,table = value.callbacks; }
  var importFunctions = {sa:registerClass};
  var exports = await initialize();
  return options;
}
`;

async function fixtureBuild(t) {
  const directory = await mkdtemp(join(tmpdir(), 'resource-provenance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'dist'));
  for (const file of ['analysis.js', 'deferred-analysis.js', 'dependency-analysis.js', 'dependency-source.js', 'resource-provenance.js', 'loader-configuration-proof.js']) {
    try { await copyFile(new URL(`../dist/${file}`, import.meta.url), join(directory, 'dist', file)); }
    catch (error) { if (error.code !== 'ENOENT' || file !== 'resource-provenance.js') throw error; }
  }
  await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  await symlink(new URL('../node_modules', import.meta.url).pathname, join(directory, 'node_modules'), 'dir');
  await writeFile(join(directory, 'dist/dependency-contracts.js'), `export const dependencyContracts = Object.freeze([Object.freeze(${JSON.stringify({ id: 'zxing-reader-lifetime-noninterference', revision: 1, size: resource.length, sha256: digest(resource), binaryVersion: 1, relativePath: './zxing_reader.wasm', imports: 'a.sa:iiiiiiiiiiiii>' })})]);`);
  return import(pathToFileURL(join(directory, 'dist/analysis.js')).href);
}
const callbacks = result => result.dependencyProof.evidence.filter(entry => /Resource callback origin: conditional/.test(entry.description));

test('resource callback values connect the full import, instance, export, cache and closed-wrapper origin chain to metadata stores', async t => {
  const api = await fixtureBuild(t);
  const result = api.transformSource(source, evidenceFor(source));
  assert.equal(callbacks(result.analysis).length, 4, JSON.stringify(result.analysis.dependencyProof));
  assert.deepEqual(callbacks(result.analysis).map(entry => source.slice(entry.range.start,entry.range.end)), [
    'this.rawDestructor = destructor', 'this.getActualType = actual', 'this.upcast = upcast', 'this.downcast = downcast',
  ]);
  for (const entry of callbacks(result.analysis)) {
    assert.match(entry.description, /conditional/);
    assert.match(entry.description, /hooks/);
    assert.match(entry.description, /later invocation/);
  }
  assert.equal(result.analysis.dependencyProof.acceptedContract, null);
  assert.equal(result.analysis.compatibility, 'incompatible');
  assert.equal(result.transformation, null);
  await t.test('foreign writes, import mismatch and escaped/directly called wrappers cannot retain connected callback evidence', () => {
    for (const [label,changed] of [
      ['table replacement', source.replace('var table, memory;', 'var table, memory; table = foreignTable;')],
      ['wide cache replacement', source.replace('var wideCalls = {}, tableCache = [];', 'var wideCalls = {}, tableCache = []; wideCalls.viijii = foreignCallback;')],
      ['import mismatch', source.replace('{sa:registerClass}', '{other:registerClass}')],
      ['import replacement', source.replace('var exports = await initialize();', 'importFunctions.sa = foreignCallback; var exports = await initialize();')],
      ['wrapper escape', source.replace('var exports = await initialize();', 'unknown(wrap); var exports = await initialize();')],
      ['wrapper direct caller', source.replace('var exports = await initialize();', 'wrap("j",1); var exports = await initialize();')],
      ['import direct caller', source.replace('var exports = await initialize();', 'registerClass(1,2,3,4,5,foreignCallback); var exports = await initialize();')],
      ['resolver direct caller', source.replace('var exports = await initialize();', 'resolveCallback("v",1); var exports = await initialize();')],
      ['signature overwrite', source.replace('name = decode(name),actual =', 'actualSignature = foreignSignature; name = decode(name),actual =')],
      ['constructor overwrite', source.replace('this.rawDestructor = destructor', 'this.rawDestructor = foreignCallback')],
      ['metadata argument overwrite', source.replace('destroy,null,actual,up,down', 'foreignCallback,null,actual,up,down')],
      ['extra table helper caller', source.replace('var exports = await initialize();', 'tableFunction(1); var exports = await initialize();')],
      ['table helper escape', source.replace('var exports = await initialize();', 'unknown(tableFunction); var exports = await initialize();')],
      ['unknown wrapper body', source.replace('return invoke(signature,pointer,[...arguments],flag);', 'unknown(); return invoke(signature,pointer,[...arguments],flag);')],
      ['export assignment caller', source.replace('var exports = await initialize();', 'assignExports(foreignExports); var exports = await initialize();')],
    ]) {
      const rejected = api.transformSource(changed,evidenceFor(changed));
      assert.equal(callbacks(rejected.analysis).length, 0,label);
      assert.equal(rejected.analysis.dependencyProof.acceptedContract, null,label);
      assert.equal(rejected.transformation, null,label);
    }
  });
  await t.test('binding renames and CRLF preserve connected resource origins', () => {
    const renamed = source.replace(/\btableCache\b/g,'privatePointers').replace(/\bresolveCallback\b/g,'findFunction').replace(/\bregisterClass\b/g,'defineClass').replace(/\bMetadata\b/g,'ClassRecord').replaceAll('\n','\r\n');
    const result = api.transformSource(renamed,evidenceFor(renamed));
    assert.equal(callbacks(result.analysis).length,4);
    assert.equal(result.analysis.dependencyProof.acceptedContract,null);
    assert.equal(result.transformation,null);
  });
  await t.test('passing the import formal to unknown JavaScript loses resource association', () => {
    const changed = source.replace('try { var bytes = await readBytes(name);', 'try { unknown(imports); var bytes = await readBytes(name);');
    const rejected = api.transformSource(changed,evidenceFor(changed));
    assert.equal(callbacks(rejected.analysis).length,0);
    assert.equal(rejected.transformation,null);
  });
  await t.test('changing the cached instance exports before assignment breaks provenance', () => {
    const changed = source.replace('assignExports(exports),ready()', 'assignExports(exports = foreignExports),ready()');
    const rejected = api.transformSource(changed,evidenceFor(changed));
    assert.equal(callbacks(rejected.analysis).length,0);
    assert.equal(rejected.transformation,null);
  });
  await t.test('dynamic scope cannot preserve binding-based callback proof', () => {
    const changed = source.replace('var exports = await initialize();', 'eval(code); var exports = await initialize();');
    const rejected = api.transformSource(changed,evidenceFor(changed));
    assert.equal(callbacks(rejected.analysis).length,0);
    assert.equal(rejected.transformation,null);
  });
  await t.test('rewriting an imports formal breaks the instantiate association', () => {
    const changed = source.replace('try { var bytes = await readBytes(name);', 'try { imports = foreignImports; var bytes = await readBytes(name);');
    const rejected = api.transformSource(changed,evidenceFor(changed));
    assert.equal(callbacks(rejected.analysis).length,0);
    assert.equal(rejected.transformation,null);
  });
  await t.test('raw callback publication before metadata construction breaks the closed origin path', () => {
    const changed = source.replace('schedule([type,pointerType,constType]', 'unknown(destroy); schedule([type,pointerType,constType]');
    const rejected = api.transformSource(changed,evidenceFor(changed));
    assert.equal(callbacks(rejected.analysis).length,0);
    assert.equal(rejected.transformation,null);
  });
  await t.test('a decoy instantiate call cannot certify a substituted result', () => {
    const changed = source.replace('return await WebAssembly.instantiate(bytes,imports);','await WebAssembly.instantiate(bytes,imports); return foreignResult;');
    const rejected = api.transformSource(changed,evidenceFor(changed));
    assert.equal(callbacks(rejected.analysis).length,0);
    assert.equal(rejected.transformation,null);
  });
  await t.test('a foreign initial table value is another callback origin, even when export assignment later replaces it', () => {
    const changed = source.replace('var table, memory;', 'var table = foreignTable, memory;');
    const rejected = api.transformSource(changed,evidenceFor(changed));
    assert.equal(callbacks(rejected.analysis).length, 0);
    assert.equal(rejected.transformation, null);
  });
  await t.test('table cache replacement cannot retain a resource callback origin', () => {
    const changed = source.replace('var wideCalls = {}, tableCache = [];', 'var wideCalls = {}, tableCache = []; tableCache[1] = foreignCallback;');
    const rejected = api.transformSource(changed,evidenceFor(changed));
    assert.equal(callbacks(rejected.analysis).length, 0);
    assert.ok(rejected.analysis.dependencyProof.evidence.some(entry => /Resource table cache: unknown/.test(entry.description)));
    assert.equal(rejected.transformation, null);
  });
});
