import { canonicalHash } from './canonical-json.mjs';

export const USAGE_LEDGER_VERSION = 1;

const numericFields = Object.freeze([
  'inputTokens', 'cachedInputTokens', 'uncachedInputTokens', 'outputTokens',
  'reasoningTokens', 'cacheCreationInputTokens', 'costUsd',
]);

function nonNegative(value, field) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isFinite(value) || value < 0) throw new TypeError(`USAGE_${field.toUpperCase()}_INVALID`);
  return value;
}

function optionalString(value, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new TypeError(`USAGE_${field.toUpperCase()}_INVALID`);
  return value;
}

/** Creates a serializable, deliberately content-free usage record. */
export function createUsageRecord(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('USAGE_RECORD_INVALID');
  const record = { version: USAGE_LEDGER_VERSION, provider: optionalString(value.provider, 'provider') ?? 'unknown' };
  for (const field of numericFields) {
    const number = nonNegative(value[field], field);
    if (number !== undefined) record[field] = number;
  }
  for (const field of ['requestedModel', 'observedModel']) {
    const string = optionalString(value[field], field);
    if (string !== undefined) record[field] = string;
  }
  if (value.observedModels !== undefined) {
    if (!Array.isArray(value.observedModels) || value.observedModels.some((item) => typeof item !== 'string')) throw new TypeError('USAGE_OBSERVED_MODELS_INVALID');
    record.observedModels = [...new Set(value.observedModels)].sort();
  }
  for (const field of ['requestedFast', 'observedFast']) {
    if (value[field] !== undefined && typeof value[field] !== 'boolean' && typeof value[field] !== 'string') throw new TypeError(`USAGE_${field.toUpperCase()}_INVALID`);
    if (value[field] !== undefined) record[field] = value[field];
  }
  if (value.fastModeReason !== undefined) record.fastModeReason = optionalString(value.fastModeReason, 'fastModeReason');
  if (value.sourceHash !== undefined) record.sourceHash = optionalString(value.sourceHash, 'sourceHash');
  if (value.anomalies !== undefined) {
    if (!Array.isArray(value.anomalies) || value.anomalies.some((item) => typeof item !== 'string')) throw new TypeError('USAGE_ANOMALIES_INVALID');
    record.anomalies = [...value.anomalies];
  }
  return Object.freeze(record);
}

/** Hashes raw transport input without retaining it in the ledger. */
export function sourceHash(source) {
  if (typeof source !== 'string' && !Buffer.isBuffer(source)) throw new TypeError('USAGE_SOURCE_INVALID');
  return canonicalHash({ bytes: Buffer.from(source).toString('base64') });
}

export class UsageLedger {
  #records = [];

  add(record) {
    const normalized = createUsageRecord(record);
    this.#records.push(normalized);
    return normalized;
  }

  records() { return this.#records.slice(); }

  summary() {
    const totals = { modelCalls: this.#records.length };
    for (const field of numericFields) totals[field] = this.#records.reduce((sum, record) => sum + (record[field] ?? 0), 0);
    return Object.freeze(totals);
  }
}
