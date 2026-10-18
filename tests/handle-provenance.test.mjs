import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const digest = value => createHash('sha256').update(value).digest('hex');
const text = value => [value.length, ...Buffer.from(value)];
const section = (id, bytes) => [id, bytes.length, ...bytes];
// Self-authored inert interface only; never compiled or instantiated.
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
      var reference = new Pointer(name,metadata,true,false,false), mutable = new Pointer(name,metadata,false,false,false), constant = new Pointer(name,metadata,false,true,false);
      return [reference,mutable,constant];
    });
  };
  function Pointer(name,registered,isReference,isConst,isSmart,pointee,sharing,get,construct,share,destroy) {
    this.name = name,this.registeredClass = registered,this.isReference = isReference,this.isConst = isConst,this.isSmartPointer = isSmart,
    this.pointeeType = pointee,this.sharingPolicy = sharing,this.rawGetPointee = get,this.rawConstructor = construct,this.rawShare = share,this.rawDestructor = destroy,
    !isSmart && registered.baseClass === void 0 ? isConst ? (this.toWireType = constWire,this.destructorFunction = null) : (this.toWireType = mutableWire,this.destructorFunction = null) : this.toWireType = derivedWire;
  }
  function constWire(stack,handle) { return handle.$$.ptr; }
  function mutableWire(stack,handle) { return handle.$$.ptr; }
  function derivedWire(stack,handle) { return handle.$$.ptr; }
  var makeHandle = (prototype,metadata) => {
    if (!metadata.ptrType || !metadata.ptr) fail('pointer');
    if (!metadata.smartPtrType != !metadata.smartPtr) fail('smart pointer');
    return metadata.count = {value:1}, registerHandle(Object.create(prototype,{$$:{value:metadata,writable:true}}));
  };
  function convertPointer(pointer) {
    var raw = this.getPointee(pointer);
    var fallback = () => this.isSmartPointer ? makeHandle(this.registeredClass.instancePrototype,{ptrType:this.pointeeType,ptr:raw,smartPtrType:this,smartPtr:pointer}) : makeHandle(this.registeredClass.instancePrototype,{ptrType:this,ptr:pointer});
    var type = this.registeredClass.getActualType(raw), derived = typeMap[type], adjusted = raw;
    return derived ? this.isSmartPointer ? makeHandle(derived.registeredClass.instancePrototype,{ptrType:derived,ptr:adjusted,smartPtrType:this,smartPtr:pointer}) : makeHandle(derived.registeredClass.instancePrototype,{ptrType:derived,ptr:adjusted}) : fallback();
  }
  function installPointers() { Object.assign(Pointer.prototype,{fromWireType:convertPointer}); }
  var copyMetadata = metadata => ({count:metadata.count,deleteScheduled:metadata.deleteScheduled,preservePointerOnDelete:metadata.preservePointerOnDelete,ptr:metadata.ptr,ptrType:metadata.ptrType,smartPtr:metadata.smartPtr,smartPtrType:metadata.smartPtrType});
  var registerHandle = handle => handle;
  var typeMap = {};
  installPointers();
  function Handle() {}
  var queue = [], flush = () => {
    while (queue.length) { var handle = queue.pop(); handle.$$.deleteScheduled = false; handle.delete(); }
  }, scheduler;
  var installHandles = () => {
    var prototype = Handle.prototype;
    Object.assign(prototype, {
      clone() {
        if (this.$$.ptr || fail(this), this.$$.preservePointerOnDelete) return this.$$.count.value += 1,this;
        var clone = registerHandle(Object.create(Object.getPrototypeOf(this),{$$:{value:copyMetadata(this.$$)}}));
        return clone.$$.count.value += 1,clone.$$.deleteScheduled = false,clone;
      },
      deleteLater() {
        return this.$$.ptr || fail(this), this.$$.deleteScheduled && !this.$$.preservePointerOnDelete && fail('scheduled'),
          queue.push(this), queue.length === 1 && scheduler && scheduler(flush), this.$$.deleteScheduled = true, this;
      }
    });
  };
  installHandles();
  var table, memory;
  function assignExports(value) { wideCalls.viijii = value.wideCall,memory = value.memory,table = value.callbacks; }
  var importFunctions = {sa:registerClass};
  var exports = await initialize();
  return options;
}
`;

async function fixtureBuild(t) {
  const directory = await mkdtemp(join(tmpdir(), 'handle-provenance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'dist'));
  for (const file of ['analysis.js', 'deferred-analysis.js', 'dependency-analysis.js', 'dependency-source.js', 'resource-provenance.js', 'handle-provenance.js']) {
    try { await copyFile(new URL(`../dist/${file}`, import.meta.url), join(directory, 'dist', file)); }
    catch (error) { if (error.code !== 'ENOENT' || file !== 'handle-provenance.js') throw error; }
  }
  await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  await symlink(new URL('../node_modules', import.meta.url).pathname, join(directory, 'node_modules'), 'dir');
  await writeFile(join(directory, 'dist/dependency-contracts.js'), `export const dependencyContracts = Object.freeze([Object.freeze(${JSON.stringify({ id: 'zxing-reader-lifetime-noninterference', revision: 1, size: resource.length, sha256: digest(resource), binaryVersion: 1, relativePath: './zxing_reader.wasm', imports: 'a.sa:iiiiiiiiiiiii>' })})]);`);
  return import(pathToFileURL(join(directory, 'dist/analysis.js')).href);
}
const records = (result, role) => result.dependencyProof.evidence.filter(entry => entry.description.startsWith(`Handle ${role}:`));
const slices = (input, entries) => entries.map(entry => input.slice(entry.range.start, entry.range.end));
function refuses(result) {
  assert.equal(result.analysis.dependencyProof.acceptedContract, null);
  assert.equal(result.analysis.compatibility, 'incompatible');
  assert.equal(result.analysis.target, null);
  assert.equal(result.transformation, null);
}

test('class allocation retains all four resource callback identities and incoming requirements without proving invocation', async t => {
  const api = await fixtureBuild(t);
  const result = api.transformSource(source, evidenceFor(source));
  const classes = records(result.analysis, 'class allocation');
  assert.deepEqual(slices(source, classes), ['new Metadata(name,null,null,destroy,null,actual,up,down)']);
  assert.match(classes[0].description, /conditional.*4 exact resource callback stores/);
  for (const id of ['source-bytes', 'hooks-absent', 'callback-invocation', 'callback-receiver', 'callback-lifetime', 'writer-closure', 'publication-closure']) assert.ok(classes[0].description.includes(id), id);
  refuses(result);
});

test('three pointer descriptors link the same class allocation and preserve omitted callback writer conditions', async t => {
  const api = await fixtureBuild(t);
  const result = api.transformSource(source, evidenceFor(source));
  const pointers = records(result.analysis, 'pointer allocation');
  assert.deepEqual(slices(source, pointers), [
    'new Pointer(name,metadata,true,false,false)', 'new Pointer(name,metadata,false,false,false)', 'new Pointer(name,metadata,false,true,false)',
  ]);
  for (const entry of pointers) {
    assert.match(entry.description, /conditional.*same class allocation/);
    assert.match(entry.description, /6 omitted formals.*initially undefined.*writer-closure/);
    assert.match(entry.description, /callback-lifetime/);
  }
  refuses(result);
});

test('four handle creation sites retain fresh metadata, writable $$, count allocation and conditional descriptor receivers', async t => {
  const api = await fixtureBuild(t);
  const result = api.transformSource(source, evidenceFor(source));
  const creations = records(result.analysis, 'metadata allocation');
  assert.equal(creations.length, 4);
  assert.deepEqual(slices(source, creations), [
    'makeHandle(this.registeredClass.instancePrototype,{ptrType:this.pointeeType,ptr:raw,smartPtrType:this,smartPtr:pointer})',
    'makeHandle(this.registeredClass.instancePrototype,{ptrType:this,ptr:pointer})',
    'makeHandle(derived.registeredClass.instancePrototype,{ptrType:derived,ptr:adjusted,smartPtrType:this,smartPtr:pointer})',
    'makeHandle(derived.registeredClass.instancePrototype,{ptrType:derived,ptr:adjusted})',
  ]);
  for (const entry of creations) {
    assert.match(entry.description, /conditional.*fresh metadata.*shared helper count allocation/);
    assert.match(entry.description, /writable \$\$/);
    for (const id of ['receiver-identity','writer-closure','publication-closure','callback-lifetime']) assert.ok(entry.description.includes(id), id);
  }
  refuses(result);
});

test('clone copies metadata while sharing the original count and retaining registration-before-increment lifetime conditions', async t => {
  const api = await fixtureBuild(t);
  const result = api.transformSource(source, evidenceFor(source));
  const clones = records(result.analysis, 'clone count sharing');
  assert.deepEqual(slices(source, clones), ['Object.create(Object.getPrototypeOf(this),{$$:{value:copyMetadata(this.$$)}})']);
  assert.match(clones[0].description, /conditional.*same count cell.*nonwritable/);
  assert.match(clones[0].description, /registration precedes.*increment/);
  assert.match(clones[0].description, /retained-invocation.*arbitrary later.*exceptions.*reentrancy/);
  refuses(result);
});

test('a scheduler writer prevents pruning while queue and flag requirements remain visible', async t => {
  const api = await fixtureBuild(t);
  for (const [label, changed] of [
    ['scheduler writer', source.replace('  installHandles();', '  scheduler = foreignScheduler; installHandles();')],
    ['scheduler initializer', source.replace('}, scheduler;', '}, scheduler = foreignScheduler;')],
  ]) {
    const result = api.transformSource(changed,evidenceFor(changed));
    assert.equal(records(result.analysis,'scheduler call').length,0,label);
    assert.equal(records(result.analysis,'queue retention').length,1,label);
    assert.equal(records(result.analysis,'scheduled flag').length,1,label);
    refuses(result);
  }
});

test('foreign class identity cannot supply any of the three associated pointer descriptors', async t => {
  const api = await fixtureBuild(t);
  for (const [label, changed] of [
    ['foreign class', source.replace('new Pointer(name,metadata,true,false,false)', 'new Pointer(name,foreignClass,true,false,false)')],
    ['class binding replacement', source.replace('      var reference =', '      metadata = foreignClass; var reference =')],
    ['descriptor constructor escape', source.replace('  installPointers();', '  unknown(Pointer); installPointers();')],
  ]) {
    const result = api.transformSource(changed,evidenceFor(changed));
    assert.equal(records(result.analysis,'pointer allocation').length,0,label);
    assert.equal(records(result.analysis,'metadata allocation').length,0,label);
    refuses(result);
  }
});

test('proved callback store syntax remains distinct from conditional property and lifetime semantics', async t => {
  const api = await fixtureBuild(t);
  const result = api.transformSource(source,evidenceFor(source));
  const syntax = records(result.analysis,'callback store syntax');
  assert.deepEqual(slices(source,syntax), ['this.rawDestructor = destructor','this.getActualType = actual','this.upcast = upcast','this.downcast = downcast']);
  for (const entry of syntax) {
    assert.match(entry.description,/proved; Syntax only/);
    assert.match(entry.description,/callback-lifetime/);
  }
  assert.equal(records(result.analysis,'class allocation').filter(entry => entry.description.includes(': conditional;')).length,1);
  refuses(result);
});

test('metadata escape, foreign descriptor installation and count replacement cannot retain connected allocation records', async t => {
  const api = await fixtureBuild(t);
  for (const [label, changed] of [
    ['helper escape', source.replace('  installPointers();','  unknown(makeHandle); installPointers();')],
    ['foreign receiver', source.replace('Object.assign(Pointer.prototype,{fromWireType:convertPointer})','Object.assign(foreignPrototype,{fromWireType:convertPointer})')],
    ['foreign count', source.replace('metadata.count = {value:1}','metadata.count = foreignCount')],
    ['foreign metadata', source.replace('{$$:{value:metadata,writable:true}}','{$$:{value:foreignMetadata,writable:true}}')],
  ]) {
    const result = api.transformSource(changed,evidenceFor(changed));
    assert.equal(records(result.analysis,'metadata allocation').length,0,label);
    assert.equal(records(result.analysis,'clone count sharing').length,0,label);
    refuses(result);
  }
});

test('clone count replacement and changed registration ordering lose the shared-count summary', async t => {
  const api = await fixtureBuild(t);
  for (const [label, changed] of [
    ['fresh count', source.replace('({count:metadata.count,','({count:{value:1},')],
    ['copier escape', source.replace('  installHandles();','  unknown(copyMetadata); installHandles();')],
    ['foreign registration', source.replace('var clone = registerHandle(', 'var clone = foreignRegister(')],
    ['foreign increment receiver', source.replace('return clone.$$.count.value += 1,','return foreignHandle.$$.count.value += 1,')],
    ['foreign metadata input', source.replace('value:copyMetadata(this.$$)', 'value:copyMetadata(foreignMetadata)')],
  ]) {
    const result = api.transformSource(changed,evidenceFor(changed));
    assert.equal(records(result.analysis,'clone count sharing').length,0,label);
    refuses(result);
  }
});

test('flush escape, scheduler publication and eval cannot justify local scheduler pruning', async t => {
  const api = await fixtureBuild(t);
  for (const [label, changed] of [
    ['flush retained elsewhere', source.replace('  installHandles();','  unknown(flush); installHandles();')],
    ['scheduler escape', source.replace('  installHandles();','  unknown(scheduler); installHandles();')],
    ['eval', source.replace('  installHandles();','  eval(code); installHandles();')],
    ['nested eval', source.replace('  installHandles();','  function later() { eval(code); } installHandles();')],
  ]) {
    const result = api.transformSource(changed,evidenceFor(changed));
    assert.equal(records(result.analysis,'scheduler call').length,0,label);
    assert.equal(records(result.analysis,'flush publication').length,0,label);
    refuses(result);
  }
});

test('binding renames and CRLF preserve graph associations through both public analysis and transformation', async t => {
  const api = await fixtureBuild(t);
  const renamed = source.replace(/\bMetadata\b/g,'ClassRecord').replace(/\bPointer\b/g,'ConverterRecord').replace(/\bmakeHandle\b/g,'createInstance').replace(/\bcopyMetadata\b/g,'copyRecord').replace(/\bscheduler\b/g,'delayCallback').replace(/\bqueue\b/g,'pendingHandles').replaceAll('\n','\r\n');
  const analysis = api.analyzeSource(renamed,evidenceFor(renamed));
  const result = api.transformSource(renamed,evidenceFor(renamed));
  assert.deepEqual(result.analysis.dependencyProof,analysis.dependencyProof);
  for (const [role,count] of [['class allocation',1],['pointer allocation',3],['metadata allocation',4],['clone count sharing',1],['scheduler call',1],['queue retention',1]]) assert.equal(records(analysis,role).length,count,role);
  refuses(result);
});

test('queue syntax records do not claim reachability or enqueue ordering for reordered or unreachable statements', async t => {
  const api = await fixtureBuild(t);
  for (const changed of [
    source.replace('queue.push(this), queue.length === 1 && scheduler && scheduler(flush), this.$$.deleteScheduled = true', 'this.$$.deleteScheduled = true, queue.push(this), queue.length === 1 && scheduler && scheduler(flush)'),
    source.replace('      deleteLater() {', '      deleteLater() { return;'),
  ]) {
    const result = api.transformSource(changed,evidenceFor(changed));
    for (const entry of [...records(result.analysis,'queue retention'),...records(result.analysis,'scheduled flag')]) {
      assert.match(entry.description,/conditional; Syntax only/);
      assert.doesNotMatch(entry.description,/remains reachable|after enqueue/);
    }
    refuses(result);
  }
});

test('an undefined closed scheduler prunes only its call and flush publication, retaining queue lifetime effects', async t => {
  const api = await fixtureBuild(t);
  const result = api.transformSource(source, evidenceFor(source));
  assert.deepEqual(slices(source, records(result.analysis, 'scheduler call')), ['scheduler(flush)']);
  assert.match(records(result.analysis, 'scheduler call')[0].description, /pruned.*undefined/);
  assert.match(records(result.analysis, 'flush publication')[0].description, /pruned/);
  assert.deepEqual(slices(source, records(result.analysis, 'queue retention')), ['queue.push(this)']);
  assert.match(records(result.analysis, 'queue retention')[0].description, /conditional.*retained.*lifetime/);
  assert.deepEqual(slices(source, records(result.analysis, 'scheduled flag')), ['this.$$.deleteScheduled = true']);
  refuses(result);
});
