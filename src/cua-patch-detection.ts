import { parse } from 'acorn';
import type * as E from 'estree';
import { deriveCua } from './cua-analysis.js';
import { wrapCuaBody } from './cua-recipe.js';
import { parseSourceContext } from './source-context.js';
import type { CuaDerivation, Range } from './cua-contract.js';

export interface DetectedCuaPatch {
  recipeVersion: 2;
  range: Range;
  derivation: CuaDerivation;
}

// 忽略排版及源码位置，逐项比较完整语法结构；字符串、注释不参与匹配。
function structure(node: unknown): string {
  return JSON.stringify(node, (key, value: unknown) => ['start', 'end', 'loc', 'range', 'raw'].includes(key) ? undefined : value);
}
const template = parse(wrapCuaBody('await response.json()'), { ecmaVersion: 2022, sourceType: 'module', allowAwaitOutsideFunction: true });
const expression = template.body[0] as E.ExpressionStatement;
const wrapper = structure((expression.expression as E.CallExpression).callee);

/** 只识别实际目标位置的完整已知包装器，不据此授权恢复或认领安装来源。 */
export function detectCuaPatch(source: string): DetectedCuaPatch | null {
  if (!/\bfunction\s+adaptBody\s*\(/.test(source)) return null;
  const { context } = parseSourceContext(source);
  if (!context) return null;
  const matches = context.nodes.filter((node): node is E.CallExpression => node.type === 'CallExpression' && node.callee.type === 'FunctionExpression' && node.callee.id?.name === 'adaptBody' && structure(node.callee) === wrapper);
  if (matches.length !== 1) return null;
  const call = matches[0]!;
  const argument = call.arguments[0];
  if (call.type !== 'CallExpression' || call.optional || call.arguments.length !== 1 || argument?.type !== 'AwaitExpression') return null;
  const located = call as E.CallExpression & { start: number; end: number };
  const inner = argument as E.AwaitExpression & { start: number; end: number };
  const original = source.slice(inner.start, inner.end);
  const restored = source.slice(0, located.start) + original + source.slice(located.end);
  const derivation = deriveCua(restored);
  const change = derivation.change;
  if (derivation.support !== 'supported' || !change || change.range.start !== located.start || change.range.end !== located.start + original.length) return null;
  return { recipeVersion: 2, range: { start: located.start, end: located.end, unit: 'utf16' }, derivation };
}
