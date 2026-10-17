import { createHash } from 'node:crypto';
import { dependencyContracts } from './dependency-contracts.js';
import { proveDependencySource } from './dependency-source.js';
import type { AnalysisDiagnostic, StructuralEvidence } from './analysis.js';

/** Explicit snapshots only. Paths describe association; they are never opened. */
export interface DependencyEvidenceInput {
  schemaVersion: 1;
  contract: { id: string; revision: number };
  association: { sourceSha256: string; relativePath: string; route: 'adjacent' };
  resourceBytes: Uint8Array;
}

interface WasmImport { module: string; name: string; parameters: string[]; results: string[] }
interface WasmExport { name: string; kind: number; index: number }
export interface MeasuredDependencyResource {
  size: number;
  sha256: string;
  binaryVersion: number;
  imports: WasmImport[];
  exports: WasmExport[];
  hasStart: boolean;
}
export interface DependencyProof {
  status: 'rejected' | 'incomplete';
  resource: MeasuredDependencyResource | null;
  registeredContract: { id: string; revision: number; assumption: string } | null;
  acceptedContract: null;
  association: { sourceSha256: string; relativePath: string; route: 'adjacent' } | null;
  evidence: StructuralEvidence[];
  diagnostics: AnalysisDiagnostic[];
  runtime: 'not-verified';
}

class InvalidBinary extends Error {}

// This is an inert interface decoder, not a WebAssembly validator or engine.
// Sections outside the interface are length-bounded and skipped. Contract digest
// matching is still required; a decoded interface alone never grants approval.
class Decoder {
  offset = 0;
  constructor(readonly bytes: Uint8Array, readonly end = bytes.length) {}
  byte(): number {
    if (this.offset >= this.end) throw new InvalidBinary('Truncated binary interface.');
    return this.bytes[this.offset++]!;
  }
  uint(): number {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const byte = this.byte();
      if (shift === 28 && byte > 15) throw new InvalidBinary('Invalid unsigned LEB128.');
      value += (byte & 127) * 2 ** shift;
      if (!(byte & 128)) return value;
    }
    throw new InvalidBinary('Invalid unsigned LEB128.');
  }
  text(): string {
    const length = this.uint(), end = this.offset + length;
    if (end > this.end) throw new InvalidBinary('Truncated name.');
    let value: string;
    try { value = new TextDecoder('utf-8', { fatal: true }).decode(this.bytes.subarray(this.offset, end)); }
    catch { throw new InvalidBinary('Invalid UTF-8 name.'); }
    this.offset = end;
    return value;
  }
  vector<T>(read: () => T): T[] {
    const count = this.uint();
    if (count > this.end - this.offset) throw new InvalidBinary('Invalid vector length.');
    return Array.from({ length: count }, read);
  }
  valueType(): string {
    const value = this.byte();
    const name = new Map([[127, 'i32'], [126, 'i64'], [125, 'f32'], [124, 'f64'], [123, 'v128'], [112, 'funcref'], [111, 'externref']]).get(value);
    if (!name) throw new InvalidBinary('Unsupported binary value type.');
    return name;
  }
}

function measure(bytes: Uint8Array): MeasuredDependencyResource {
  const decoder = new Decoder(bytes);
  for (const byte of [0, 97, 115, 109]) if (decoder.byte() !== byte) throw new InvalidBinary('Invalid Wasm magic.');
  const binaryVersion = decoder.byte() + decoder.byte() * 256 + decoder.byte() * 65536 + decoder.byte() * 16777216;
  if (binaryVersion !== 1) throw new InvalidBinary('Unsupported binary version.');
  const types: { parameters: string[]; results: string[] }[] = [];
  const imports: WasmImport[] = [], exports: WasmExport[] = [];
  const seen = new Set<number>();
  let previous = 0, hasStart = false;
  // Data count (12) precedes code (10) in the binary ordering.
  const order = [1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 10, 11];
  while (decoder.offset < bytes.length) {
    const id = decoder.byte(), size = decoder.uint(), end = decoder.offset + size;
    if (end > bytes.length) throw new InvalidBinary('Section extends beyond resource.');
    if (id !== 0) {
      const position = order.indexOf(id) + 1;
      if (!position || position < previous || seen.has(id)) throw new InvalidBinary('Unsupported, repeated or unordered section.');
      previous = position;
      seen.add(id);
    }
    const section = new Decoder(bytes, end);
    section.offset = decoder.offset;
    if (id === 1) types.push(...section.vector(() => {
      if (section.byte() !== 96) throw new InvalidBinary('Unsupported type definition.');
      return { parameters: section.vector(() => section.valueType()), results: section.vector(() => section.valueType()) };
    }));
    if (id === 2) imports.push(...section.vector(() => {
      const module = section.text(), name = section.text(), kind = section.byte();
      if (kind !== 0) throw new InvalidBinary('Only function imports are supported.');
      const type = types[section.uint()];
      if (!type) throw new InvalidBinary('Import references a missing function type.');
      return { module, name, parameters: [...type.parameters], results: [...type.results] };
    }));
    if (id === 7) exports.push(...section.vector(() => {
      const name = section.text(), kind = section.byte(), index = section.uint();
      if (kind > 3) throw new InvalidBinary('Unsupported export kind.');
      return { name, kind, index };
    }));
    if (id === 8) { section.uint(); hasStart = true; }
    if ([1, 2, 7, 8].includes(id) && section.offset !== end) throw new InvalidBinary('Trailing interface section bytes.');
    decoder.offset = end;
  }
  const names = imports.map(item => `${item.module}\0${item.name}`);
  if (new Set(names).size !== names.length || new Set(exports.map(item => item.name)).size !== exports.length) throw new InvalidBinary('Duplicate interface names.');
  return { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), binaryVersion, imports, exports, hasStart };
}

/** Verify bytes and approval independently; no caller claim can approve a resource. */
export function inspectDependency(source: string, input: DependencyEvidenceInput): DependencyProof {
  const proof: DependencyProof = { status: 'rejected', resource: null, registeredContract: null, acceptedContract: null, association: null, evidence: [], diagnostics: [], runtime: 'not-verified' };
  const fail = (code: string, message: string): DependencyProof => { proof.diagnostics.push({ code, severity: 'error', message }); return proof; };
  const fields = (value: unknown, names: string[]): boolean => !!value && typeof value === 'object' && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
  if (!fields(input, ['schemaVersion', 'contract', 'association', 'resourceBytes']) || input.schemaVersion !== 1 || !fields(input.contract, ['id', 'revision']) || !fields(input.association, ['sourceSha256', 'relativePath', 'route']) || !(input.resourceBytes instanceof Uint8Array)) return fail('DEPENDENCY_EVIDENCE_FORMAT', 'Expected version 1 evidence with explicit resource bytes, contract and association; unknown fields cannot confer trust.');
  const contract = dependencyContracts.find(item => item.id === input.contract.id && item.revision === input.contract.revision);
  if (!contract) return fail('DEPENDENCY_CONTRACT_UNKNOWN', 'Contract identity or revision is not in the compiled approval registry.');
  const sourceSha256 = createHash('sha256').update(source, 'utf8').digest('hex');
  if (input.association.sourceSha256 !== sourceSha256 || input.association.relativePath !== contract.relativePath || input.association.route !== 'adjacent') return fail('DEPENDENCY_ASSOCIATION', 'Evidence must bind these source bytes to the explicit adjacent resource; fallback is unsupported.');
  proof.association = { sourceSha256, relativePath: contract.relativePath, route: 'adjacent' };
  try { proof.resource = measure(Uint8Array.from(input.resourceBytes)); }
  catch (error) {
    if (!(error instanceof InvalidBinary)) throw error;
    return fail('DEPENDENCY_BINARY_INTERFACE', error.message);
  }
  if (proof.resource.sha256 !== contract.sha256 || proof.resource.size !== contract.size || proof.resource.binaryVersion !== contract.binaryVersion) return fail('DEPENDENCY_RESOURCE_IDENTITY', 'Measured bytes do not match the resource approved for this contract.');
  const signature = (types: string[]): string => types.map(type => ({ i32: 'i', i64: 'j', f32: 'f', f64: 'd' })[type] ?? '?').join('');
  const imports = proof.resource.imports.map(item => `${item.module}.${item.name}:${signature(item.parameters)}>${signature(item.results)}`).join(' ');
  if (imports !== contract.imports) return fail('DEPENDENCY_IMPORT_INTERFACE', 'Measured import names and signatures do not match the approved resource interface.');
  proof.registeredContract = { id: contract.id, revision: contract.revision, assumption: 'The approved resource preserves relevant host capabilities, prototypes, site-status bindings and configuration throughout verified initialization and decoding, including delayed effects.' };
  proof.status = 'incomplete';
  const structural = proveDependencySource(source);
  proof.evidence = structural.evidence;
  proof.diagnostics.push(...structural.diagnostics);
  return proof;
}
