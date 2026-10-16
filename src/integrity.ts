import { createHash } from 'node:crypto';

export function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Canonical object keys make integrity independent of JSON presentation. Not authentication. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
