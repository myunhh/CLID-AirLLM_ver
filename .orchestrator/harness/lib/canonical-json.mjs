import { createHash } from 'node:crypto';

function normalize(value, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('CANONICAL_JSON_NON_FINITE_NUMBER');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') throw new TypeError('CANONICAL_JSON_UNSUPPORTED_VALUE');
  if (seen.has(value)) throw new TypeError('CANONICAL_JSON_CYCLE');
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((item) => normalize(item, seen));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('CANONICAL_JSON_NON_PLAIN_OBJECT');
    }
    result = {};
    for (const key of Object.keys(value).sort()) result[key] = normalize(value[key], seen);
  }
  seen.delete(value);
  return result;
}

export function canonicalJson(value) {
  return JSON.stringify(normalize(value, new Set()));
}

export function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function canonicalHash(value) {
  return sha256Bytes(canonicalJson(value));
}
