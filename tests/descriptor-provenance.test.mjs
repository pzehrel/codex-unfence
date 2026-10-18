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
  ...section(1, [2, 96, 13, ...Array(13).fill(127), 0, 96, 4, 127, 127, 127, 127, 0]),
  ...section(2, [2, ...text('a'), ...text('sa'), 0, 0, ...text('a'), ...text('sb'), 0, 1]),
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
  function fail(message) { throw Error(message); }
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
  var waiting = {}, registered = {}, dependenciesByType = {};
  var schedule = (outputs,dependencies,callback) => {
    outputs.forEach(type => dependenciesByType[type] = dependencies);
    function complete(values) {
      var result = callback(values);
      result.length !== outputs.length && fail('descriptor arity');
      for(var index=0; index<outputs.length; ++index) register(outputs[index], result[index]);
    }
    var values = Array(dependencies.length), missing = [], count = 0;
    { let vector = dependencies;
      for(let index=0; index<vector.length; ++index) {
        let type=vector[index];
        registered.hasOwnProperty(type) ? values[index]=registered[type] :
          (missing.push(type), waiting.hasOwnProperty(type) || (waiting[type]=[]), waiting[type].push(() => {
            values[index]=registered[type], ++count, count===missing.length && complete(values);
          }));
      }
    }
    missing.length===0 && complete(values);
  };
  function commitRegistration(type,descriptor) {
    let config=arguments.length>2 && arguments[2]!==void 0 ? arguments[2] : {};
    var name=descriptor.name;
    if(type || fail(name), registered.hasOwnProperty(type)) {
      if(config.ignoreDuplicateRegistrations) return;
      fail(name);
    }
    if(registered[type]=descriptor, delete dependenciesByType[type], waiting.hasOwnProperty(type)) {
      var pending=waiting[type];
      delete waiting[type], pending.forEach(wake=>wake());
    }
  }
  function register(type,descriptor) { return commitRegistration(type,descriptor,arguments.length>2 && arguments[2]!==void 0 ? arguments[2] : {}); }
  function extraSchedules(type,pointerType,constType,baseType) {
    schedule([type],[baseType], converters => [{name:'aggregate',fromWireType:value=>value,toWireType:value=>value,readValueFromPointer:value=>value,destructorFunction:null}]);
    schedule([],[type], converters => { schedule([],[pointerType], inner => []); return []; });
    schedule([],[type], converters => { schedule([],[constType], inner => []); return []; });
    schedule([],[baseType], converters => []);
    schedule([],[type,pointerType], converters => []);
    register(type,{isVoid:true,name:'void',fromWireType:value=>value,toWireType:value=>value});
    register(pointerType,{name:'view',fromWireType:value=>value,readValueFromPointer:value=>value},{ignoreDuplicateRegistrations:true});
  }
  var registerClass = (type,pointerType,constType,baseType,actualSignature,actual,upSignature,up,downSignature,down,name,destroySignature,destroy) => {
    name = decode(name),actual = resolveCallback(actualSignature,actual),up && (up = resolveCallback(upSignature,up)),down && (down = resolveCallback(downSignature,down)),destroy = resolveCallback(destroySignature,destroy);
    schedule([type,pointerType,constType],baseType ? [baseType] : [],converters => {
      var metadata = new Metadata(name,null,null,destroy,null,actual,up,down);
      return [metadata];
    });
  };
  var table, memory;
  function assignExports(value) { wideCalls.viijii = value.wideCall,memory = value.memory,table = value.callbacks; }
  var importFunctions = {sa:registerClass,sb:extraSchedules};
  var exports = await initialize();
  return options;
}
`;

async function fixtureBuild(t, fixtureResource=resource, fixtureImports='a.sa:iiiiiiiiiiiii> a.sb:iiii>') {
  const directory = await mkdtemp(join(tmpdir(), 'descriptor-provenance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, 'dist'));
  for (const file of ['analysis.js', 'deferred-analysis.js', 'dependency-analysis.js', 'dependency-source.js', 'resource-provenance.js', 'descriptor-provenance.js']) {
    try { await copyFile(new URL(`../dist/${file}`, import.meta.url), join(directory, 'dist', file)); }
    catch (error) { if (error.code !== 'ENOENT' || !['resource-provenance.js','descriptor-provenance.js'].includes(file)) throw error; }
  }
  await writeFile(join(directory, 'package.json'), JSON.stringify({ type: 'module' }));
  await symlink(new URL('../node_modules', import.meta.url).pathname, join(directory, 'node_modules'), 'dir');
  await writeFile(join(directory, 'dist/dependency-contracts.js'), `export const dependencyContracts = Object.freeze([Object.freeze(${JSON.stringify({ id: 'zxing-reader-lifetime-noninterference', revision: 1, size: fixtureResource.length, sha256: digest(fixtureResource), binaryVersion: 1, relativePath: './zxing_reader.wasm', imports: fixtureImports })})]);`);
  return import(pathToFileURL(join(directory, 'dist/analysis.js')).href);
}
const records = result => result.dependencyProof.evidence.filter(entry => entry.description.startsWith('Descriptor '));
const find = (result, role) => records(result).filter(entry => entry.description.startsWith('Descriptor '+role+':'));

test('public analysis connects resource callbacks to activation-local scheduler and registry prefix records', async t => {
  const api=await fixtureBuild(t);
  const transformed=api.transformSource(source,evidenceFor(source));
  const result=transformed.analysis;
  assert.equal(find(result,'scheduler').length,1,JSON.stringify(result.dependencyProof));
  assert.equal(find(result,'scheduled callback').length,8);
  assert.equal(find(result,'resource field').length,4);
  assert.equal(find(result,'registry allocation').length,3);
  assert.equal(find(result,'registry writer').length,5);
  assert.equal(find(result,'activation allocation').length,3);
  assert.ok(find(result,'scheduled callback').every(entry=>!/Output keys: unknown/.test(entry.description)));
  assert.ok(find(result,'scheduled callback').some(entry=>/signed-i32 \(closed measured import formal\)/.test(entry.description)));
  assert.match(find(result,'scheduler')[0].description,/per-position/);
  assert.match(find(result,'registration transition')[0].description,/register-before-detach-before-wake/);
  assert.match(find(result,'registration transition')[0].description,/throw/);
  for(const entry of find(result,'resource field')) {
    assert.match(entry.description,/16 incoming requirements retained/);
    assert.match(entry.description,/unsatisfied/);
  }
  assert.equal(result.dependencyProof.acceptedContract,null);
  assert.equal(result.compatibility,'incompatible');
  assert.equal(result.target,null);
  assert.equal(transformed.transformation,null);
});

test('semantic mutations break connected descriptor records and preserve public refusal', async t => {
  const api=await fixtureBuild(t);
  for(const [label,changed] of [
    ['wake before detach',source.replace('delete waiting[type], pending.forEach(wake=>wake());','pending.forEach(wake=>wake()), delete waiting[type];')],
    ['wake before registration',source.replace('registered[type]=descriptor, delete dependenciesByType[type]','delete dependenciesByType[type]').replace('delete waiting[type], pending.forEach(wake=>wake());','delete waiting[type], pending.forEach(wake=>wake()), registered[type]=descriptor;')],
    ['wrong waiter slot',source.replace('values[index]=registered[type], ++count','values[0]=registered[type], ++count')],
    ['shared completion state',source.replace('var values = Array(dependencies.length), missing = [], count = 0;','var values = sharedValues, missing = sharedMissing, count = 0;')],
    ['missing eighth callback',source.replace('schedule([],[baseType], converters => []);','')],
    ['ninth callback',source.replace('schedule([],[baseType], converters => []);','schedule([],[baseType], converters => []); schedule([],[baseType], converters => []);')],
    ['registry alias publication',source.replace('var table, memory;','unknown(registered); var table, memory;')],
    ['foreign registry writer',source.replace('var table, memory;','registered[1]=foreignDescriptor; var table, memory;')],
    ['destructuring registry writer',source.replace('var table, memory;','([registered[1]]=[foreignDescriptor]); var table, memory;')],
    ['loop registry writer',source.replace('var table, memory;','for(registered[1] of foreignValues) {} var table, memory;')],
    ['registry binding replacement',source.replace('var table, memory;','registered=foreignRegistry; var table, memory;')],
    ['transition direct caller',source.replace('var table, memory;','commitRegistration(1,foreignDescriptor); var table, memory;')],
    ['resource callback replacement',source.replace('this.rawDestructor = destructor','this.rawDestructor = foreignCallback')],
    ['dynamic scope',source.replace('var table, memory;','eval(code); var table, memory;')],
  ]) {
    assert.notEqual(changed,source,label);
    const transformed=api.transformSource(changed,evidenceFor(changed));
    assert.equal(find(transformed.analysis,'scheduler').length,0,label);
    assert.equal(transformed.analysis.dependencyProof.acceptedContract,null,label);
    assert.equal(transformed.analysis.compatibility,'incompatible',label);
    assert.equal(transformed.analysis.target,null,label);
    assert.equal(transformed.transformation,null,label);
  }
});

test('descriptor union distinguishes own syntax fields from absent own fields without inventing inherited absence', async t => {
  const api=await fixtureBuild(t);
  const result=api.analyzeSource(source,evidenceFor(source));
  const fields=find(result,'union member');
  assert.equal(fields.length,3);
  const view=fields.find(entry=>source.slice(entry.range.start,entry.range.end).includes("name:'view'"));
  const empty=fields.find(entry=>source.slice(entry.range.start,entry.range.end).includes("name:'void'"));
  assert.match(view.description,/own: name, fromWireType, readValueFromPointer/);
  assert.match(view.description,/missing-own: toWireType, destructorFunction/);
  assert.match(empty.description,/missing-own: readValueFromPointer, destructorFunction/);
  assert.match(view.description,/inherited values remain unknown/);
  assert.equal(result.dependencyProof.acceptedContract,null);
});

test('unsigned-view uncertainty and unknown direct importer callers cannot turn key categories into acceptance', async t => {
  const api=await fixtureBuild(t);
  const changed=source.replace('var table, memory;','extraSchedules("__proto__",1,2,3); var table, memory;');
  const result=api.analyzeSource(changed,evidenceFor(changed));
  assert.equal(find(result,'scheduled callback').length,8);
  assert.ok(find(result,'scheduled callback').some(entry=>/keys: unknown/.test(entry.description)));
  assert.ok(find(result,'scheduled callback').every(entry=>/uint32 4294967295/.test(entry.description)));
  assert.equal(result.dependencyProof.acceptedContract,null);
});

test('one importer exposed under mixed measured signatures retains unknown scalar keys', async t => {
  const mixed=Uint8Array.from([
    0,97,115,109,1,0,0,0,
    ...section(1,[3,96,13,...Array(13).fill(127),0,96,4,127,127,127,127,0,96,4,124,124,124,124,0]),
    ...section(2,[3,...text('a'),...text('sa'),0,0,...text('a'),...text('sb'),0,1,...text('a'),...text('sc'),0,2]),
    ...section(7,[3,...text('callbacks'),1,0,...text('memory'),2,0,...text('wideCall'),0,0]),
  ]);
  const api=await fixtureBuild(t,mixed,'a.sa:iiiiiiiiiiiii> a.sb:iiii> a.sc:dddd>');
  const changed=source.replace('{sa:registerClass,sb:extraSchedules}','{sa:registerClass,sb:extraSchedules,sc:extraSchedules}');
  const result=api.analyzeSource(changed,{...evidenceFor(changed),resourceBytes:mixed});
  assert.equal(find(result,'scheduled callback').length,8);
  const aggregate=find(result,'scheduled callback').find(entry=>changed.slice(entry.range.start,entry.range.end).includes("name:'aggregate'"));
  assert.match(aggregate.description,/Output keys: unknown/);
  assert.equal(result.dependencyProof.acceptedContract,null);
});

test('binding renames, CRLF and dynamic name text preserve syntax while retaining collision and reentry conditions', async t => {
  const api=await fixtureBuild(t);
  const renamed=source.replace(/\bwaiting\b/g,'pendingTypes').replace(/\bregistered\b/g,'typeSlots').replace(/\bschedule\b/g,'queueTypes').replace(/\bcommitRegistration\b/g,'saveType').replaceAll('fail(name)','fail(`duplicate ${name}`)').replaceAll('\n','\r\n');
  const result=api.analyzeSource(renamed,evidenceFor(renamed));
  assert.equal(find(result,'scheduled callback').length,8);
  assert.equal(find(result,'resource field').length,4);
  assert.match(find(result,'registration transition')[0].description,/dynamic-strings-__proto__-hasOwnProperty-hooks-then/);
  assert.match(find(result,'registration transition')[0].description,/shared-array-reentry/);
  assert.equal(result.dependencyProof.acceptedContract,null);
});
