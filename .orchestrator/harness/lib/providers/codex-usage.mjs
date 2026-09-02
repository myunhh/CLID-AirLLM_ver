import { createHash } from 'node:crypto';
import { createUsageRecord } from '../usage-ledger.mjs';

function object(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function number(...values) { return values.find((value) => Number.isFinite(value) && value >= 0); }
function string(...values) { return values.find((value) => typeof value === 'string'); }
function bool(...values) { return values.find((value) => typeof value === 'boolean'); }
function hash(value) { return createHash('sha256').update(value).digest('hex'); }

function usageFrom(event) {
  const root = object(event);
  const payload = object(root.payload);
  const info = object(payload.info);
  const usage = object(info.total_token_usage);
  const fallback = object(root.usage);
  const recognized = (payload.type === 'token_count' && Object.keys(usage).length > 0)
    || Number.isFinite(fallback.input_tokens) || Number.isFinite(fallback.output_tokens);
  if (!recognized) return undefined;
  return {
    totalTokens: number(usage.total_tokens, usage.totalTokens),
    inputTokens: number(usage.input_tokens, fallback.input_tokens, fallback.inputTokens, root.input_tokens),
    cachedInputTokens: number(usage.cached_input_tokens, fallback.input_tokens_details?.cached_tokens, fallback.cached_input_tokens, fallback.cachedInputTokens),
    outputTokens: number(usage.output_tokens, fallback.output_tokens, fallback.outputTokens, root.output_tokens),
    reasoningTokens: number(usage.reasoning_output_tokens, fallback.output_tokens_details?.reasoning_tokens, fallback.reasoning_tokens, fallback.reasoningTokens),
    costUsd: number(usage.cost_usd, fallback.cost_usd, fallback.costUsd, root.cost_usd),
    requestedModel: string(root.requested_model, root.requestedModel),
    observedModel: string(root.model, root.observed_model, root.observedModel),
    requestedFast: bool(root.requested_fast, root.requestedFast),
    observedFast: bool(root.fast, root.observed_fast, root.observedFast),
  };
}

function cumulativeTotal(usage) {
  return usage.totalTokens ?? ((usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
}

/** Normalize JSONL cumulative token events. Content is hashed but never emitted. */
export function parseCodexUsageJsonl(jsonl) {
  if (typeof jsonl !== 'string') throw new TypeError('CODEX_JSONL_INVALID');
  let prior = 0;
  let priorUsage = {};
  const records = [];
  const anomalies = [];
  for (const line of jsonl.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { throw new TypeError('CODEX_JSONL_INVALID'); }
    const usage = usageFrom(event);
    if (!usage) continue;
    const total = cumulativeTotal(usage);
    const delta = total - prior;
    if (delta > 0) {
      const changed = {};
      for (const field of ['inputTokens', 'cachedInputTokens', 'outputTokens', 'reasoningTokens', 'costUsd']) {
        if (usage[field] !== undefined) changed[field] = Math.max(0, usage[field] - (priorUsage[field] ?? 0));
      }
      const rawInput = changed.inputTokens;
      const cached = changed.cachedInputTokens ?? 0;
      records.push(createUsageRecord({ provider: 'codex', ...changed, requestedModel: usage.requestedModel, observedModel: usage.observedModel, requestedFast: usage.requestedFast, observedFast: usage.observedFast, uncachedInputTokens: rawInput === undefined ? undefined : Math.max(0, rawInput - cached), sourceHash: hash(line) }));
    } else if (delta === 0) anomalies.push('duplicate_zero_delta');
    else anomalies.push('cumulative_decrease');
    if (total >= prior) {
      prior = total;
      priorUsage = usage;
    }
  }
  return Object.freeze({ records: Object.freeze(records), anomalies: Object.freeze(anomalies) });
}

export const normalizeCodexUsageJsonl = parseCodexUsageJsonl;
