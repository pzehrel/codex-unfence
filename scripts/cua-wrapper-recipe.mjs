import { parse, parseExpressionAt } from 'acorn';
import { createHash } from 'node:crypto';

export const profile = Object.freeze({
  id: 'cua-request-wrapper-26.1013.40934-build20770',
  appVersion: '26.1013.40934', build: '20770', pluginVersion: '0.1.1',
  size: 1938669, sha256: '44594ea0a8238c09dfb46e28acdd610e5053a05011047e1c78fb98f210195a4e',
  start: 1084567, end: 1084585,
});
export const patchedSha256 = '705bfdb0d8e1793a5c3760a97d9c3eaf2bf6959cc5cbbfe31914bb24cbcf1940';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// This adapter is serialized into one explicitly reviewed transport expression.
// Supported JSON records have Object.prototype/null prototypes and only own,
// enumerable string data properties. Accessors, symbols and exotic objects pass
// through unchanged; this is not a general Response/Proxy transparency contract.
function adaptResponse(response) {
  function isRecord(value) {
    if (value === null || typeof value !== 'object') return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) return false;
    return Reflect.ownKeys(value).every((key) => {
      const property = Object.getOwnPropertyDescriptor(value, key);
      return typeof key === 'string' && property.enumerable && Object.hasOwn(property, 'value');
    });
  }
  return {
    get ok() { return response.ok; },
    async json() {
      const body = await response.json();
      if (!isRecord(body) || !Object.hasOwn(body, 'feature_status')) return body;
      const status = body.feature_status;
      if (!isRecord(status) || !Object.hasOwn(status, 'agent') || status.agent !== true) return body;
      return { ...body, feature_status: { ...status, agent: false } };
    },
  };
}

/** Mechanical UTF-16 edit at a caller-reviewed expression, not compatibility proof. */
export function transformRequestTransport(source, { start, end, expected }) {
  if (typeof source !== 'string' || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 0 || end <= start || end > source.length || typeof expected !== 'string'
    || source.slice(start, end) !== expected) throw new Error('Reviewed expression does not match source.');
  parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const expression = parseExpressionAt(expected, 0, { ecmaVersion: 'latest', allowAwaitOutsideFunction: true });
  if (expression.type !== 'AwaitExpression' || expression.end !== expected.length
    || expression.argument.type !== 'CallExpression' || expression.argument.callee.type !== 'MemberExpression') {
    throw new Error('Reviewed expression must await the original member call.');
  }
  const replacement = `((${adaptResponse.toString()})(${expected}))`;
  const patched = source.slice(0, start) + replacement + source.slice(end);
  parse(patched, { ecmaVersion: 'latest', sourceType: 'module' });
  return {
    source: patched,
    range: { start, end, unit: 'utf16' },
    replacement,
    assessment: 'version-scoped-reviewed-pattern',
    operation: 'mechanical-edit',
    runtime: 'not-verified',
  };
}

/** Recompute only the pinned original and require the reviewed output identity. */
export function derivePinned(bytes) {
  if (bytes.length !== profile.size || digest(bytes) !== profile.sha256) {
    throw new Error('Pinned source identity mismatch: exact size and SHA-256 required.');
  }
  const source = bytes.toString('utf8');
  if (!Buffer.from(source).equals(bytes)) throw new Error('Source is not round-trip UTF-8.');
  const expected = source.slice(profile.start, profile.end);
  const transformed = transformRequestTransport(source, { start: profile.start, end: profile.end, expected });
  const patched = Buffer.from(transformed.source);
  const originalPrefix = Buffer.from(source.slice(0, profile.start));
  const originalSuffix = Buffer.from(source.slice(profile.end));
  if (!patched.subarray(0, originalPrefix.length).equals(originalPrefix)
    || !patched.subarray(patched.length - originalSuffix.length).equals(originalSuffix)) {
    throw new Error('Bytes outside reviewed expression changed.');
  }
  if (digest(patched) !== patchedSha256) throw new Error('Derived patch does not match reviewed SHA-256.');
  return { expected, transformed, patched };
}

export function preparationManifest(bytes, { transformed, patched }, origin) {
  return {
    kind: 'cua-request-wrapper-local-preparation',
    profile: { id: profile.id, appVersion: profile.appVersion, build: profile.build, pluginVersion: profile.pluginVersion },
    assessment: transformed.assessment, operation: transformed.operation, runtime: transformed.runtime,
    origin,
    original: { file: 'source.original.mjs', size: bytes.length, sha256: digest(bytes) },
    patched: { file: 'source.patched.mjs', size: patched.length, sha256: digest(patched) },
    range: transformed.range,
    patchedRange: { start: profile.start, end: profile.start + transformed.replacement.length, unit: 'utf16' },
    scope: 'reviewed dedicated site-status transport; original fetch guard, member call and consumer retained',
    jsonPolicy: 'Object.prototype/null records with own enumerable string data properties; own feature_status.agent strictly true only',
    outsideRange: 'byte-identical', syntax: 'parsed-before-and-after',
  };
}

export function preparationDiff({ expected, transformed }) {
  return `Mechanical expression replacement; UTF-16 [${profile.start},${profile.end})\n--- source.original.mjs\n+++ source.patched.mjs\n-${expected}\n+${transformed.replacement}\n`;
}
