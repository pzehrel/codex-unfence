// Serialized into the selected expression. Keep this contract independent of the
// historical pinned recipe, whose serialized bytes are part of its identity.
function adaptResponse(response: { readonly ok: unknown; json(): unknown }): object {
  function isRecord(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object') return false;
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) return false;
    return Reflect.ownKeys(value).every(key => {
      const property = Object.getOwnPropertyDescriptor(value, key)!;
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

// 在已解析的数据上仅替换目标字段，不包装或修改 Response 对象。
function adaptBody(body: unknown): unknown {
  function isRecord(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object') return false;
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== null && prototype !== Object.prototype) return false;
    return Reflect.ownKeys(value).every(key => {
      const property = Object.getOwnPropertyDescriptor(value, key)!;
      return typeof key === 'string' && property.enumerable && Object.hasOwn(property, 'value');
    });
  }
  if (!isRecord(body) || !Object.hasOwn(body, 'feature_status')) return body;
  const status = body.feature_status;
  if (!isRecord(status) || !Object.hasOwn(status, 'agent') || status.agent !== true) return body;
  return { ...body, feature_status: { ...status, agent: false } };
}

/** 只接收已定位的 JSON 解析表达式，原始请求和响应接口保持不变。 */
export function wrapCuaBody(expression: string): string {
  return `((${adaptBody.toString()})(${expression}))`;
}

/** Only the analysis-owned, awaited member expression is passed to this recipe. */
export function wrapCuaResponse(expression: string): string {
  return `((${adaptResponse.toString()})(${expression}))`;
}
