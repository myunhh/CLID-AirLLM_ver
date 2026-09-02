import { createUsageRecord } from '../usage-ledger.mjs';
import { canonicalHash } from '../canonical-json.mjs';

const get = (value, ...keys) => keys.map((key) => value?.[key]).find((item) => Number.isFinite(item) && item >= 0);
const sum = (values) => values.reduce((total, value) => total + value, 0);

function aggregateModelUsage(map) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return undefined;
  const entries = Object.entries(map).filter(([, usage]) => usage && typeof usage === 'object' && !Array.isArray(usage));
  if (entries.length === 0) return undefined;
  const values = (keys) => entries.map(([, usage]) => get(usage, ...keys)).filter((value) => value !== undefined);
  const baseInputTokens = sum(values(['inputTokens', 'input_tokens']));
  const cachedInputTokens = sum(values(['cacheReadInputTokens', 'cache_read_input_tokens']));
  const cacheCreationInputTokens = sum(values(['cacheCreationInputTokens', 'cache_creation_input_tokens']));
  const observedModels = entries.map(([name, usage]) => typeof usage.canonicalModel === 'string' ? usage.canonicalModel : name).sort();
  return {
    inputTokens: baseInputTokens + cachedInputTokens + cacheCreationInputTokens,
    cachedInputTokens, cacheCreationInputTokens,
    outputTokens: sum(values(['outputTokens', 'output_tokens'])),
    reasoningTokens: sum(values(['thinkingTokens', 'thinking_tokens', 'reasoningTokens', 'reasoning_tokens'])),
    costUsd: sum(values(['costUSD', 'costUsd', 'cost_usd'])),
    observedModel: observedModels.length === 1 ? observedModels[0] : 'multiple', observedModels,
  };
}

/** Normalize a Claude JSON result without exposing its messages or content blocks. */
export function parseClaudeUsageResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new TypeError('CLAUDE_RESULT_INVALID');
  const usage = result.usage && typeof result.usage === 'object' ? result.usage : result;
  const mapped = aggregateModelUsage(result.modelUsage);
  const inputTokens = mapped?.inputTokens ?? get(usage, 'input_tokens', 'inputTokens');
  const cachedInputTokens = mapped?.cachedInputTokens ?? get(usage, 'cache_read_input_tokens', 'cached_input_tokens', 'cachedInputTokens') ?? 0;
  const record = createUsageRecord({
    provider: 'claude', inputTokens, cachedInputTokens,
    cacheCreationInputTokens: mapped?.cacheCreationInputTokens,
    uncachedInputTokens: inputTokens === undefined ? undefined : Math.max(0, inputTokens - cachedInputTokens),
    outputTokens: mapped?.outputTokens ?? get(usage, 'output_tokens', 'outputTokens'),
    reasoningTokens: mapped?.reasoningTokens ?? get(usage.output_tokens_details, 'thinking_tokens', 'thinkingTokens') ?? get(usage, 'reasoning_tokens', 'reasoningTokens'),
    costUsd: get(result, 'total_cost_usd', 'totalCostUsd') ?? mapped?.costUsd ?? get(usage, 'cost_usd', 'costUsd'),
    requestedModel: result.requested_model ?? result.requestedModel,
    observedModel: result.model ?? result.observed_model ?? result.observedModel ?? mapped?.observedModel,
    observedModels: mapped?.observedModels,
    requestedFast: result.requested_fast ?? result.requestedFast,
    observedFast: result.fast ?? result.observed_fast ?? result.observedFast ?? result.fast_mode_state,
    fastModeReason: result.fast_mode_disabled_reason ?? result.fast_mode_reason ?? result.fastModeReason,
    sourceHash: canonicalHash(result),
  });
  return record;
}

export const normalizeClaudeUsageResult = parseClaudeUsageResult;
