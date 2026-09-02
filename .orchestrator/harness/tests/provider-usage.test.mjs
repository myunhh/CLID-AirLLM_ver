import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexUsageJsonl } from '../lib/providers/codex-usage.mjs';
import { parseClaudeUsageResult } from '../lib/providers/claude-usage.mjs';

test('Codex nested cumulative token events avoid double-counting cached/reasoning subsets', () => {
  const source = [
    JSON.stringify({ type: 'event_msg', payload: { type: 'metadata', info: { run_id: 'not-usage' } } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 17827, cached_input_tokens: 0, output_tokens: 645, reasoning_output_tokens: 276, total_tokens: 18472 } } } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 17827, cached_input_tokens: 0, output_tokens: 645, reasoning_output_tokens: 276, total_tokens: 18472 } } } }),
    JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 17900, cached_input_tokens: 0, output_tokens: 672, reasoning_output_tokens: 290, total_tokens: 18572 } } } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'message', text: 'not-usage' } }),
  ].join('\n');
  const parsed = parseCodexUsageJsonl(source);
  assert.equal(parsed.records.length, 2);
  assert.deepEqual(parsed.anomalies, ['duplicate_zero_delta']);
  assert.equal(parsed.records[0].inputTokens, 17827);
  assert.equal(parsed.records[1].inputTokens, 73);
  assert.equal(parsed.records[1].outputTokens, 27);
  assert.doesNotMatch(JSON.stringify(parsed), /secret|content/u);
});

test('Claude CLI modelUsage aggregates and detects canonical claude-opus-5', () => {
  const record = parseClaudeUsageResult({ requestedModel: 'claude-opus-5', requestedFast: true, fast_mode_state: false, fast_mode_reason: 'provider', total_cost_usd: 0.03, modelUsage: { 'claude-opus-5': { inputTokens: 2, outputTokens: 4, cacheReadInputTokens: 57822, cacheCreationInputTokens: 9552, costUSD: 0.01, contextWindow: 200000 }, 'claude-sonnet-5': { inputTokens: 0, outputTokens: 1, cacheReadInputTokens: 0, costUSD: 0.02 } }, content: [{ text: 'secret' }] });
  assert.equal(record.inputTokens, 67376);
  assert.equal(record.cachedInputTokens, 57822);
  assert.equal(record.cacheCreationInputTokens, 9552);
  assert.equal(record.uncachedInputTokens, 9554);
  assert.equal(record.outputTokens, 5);
  assert.equal(record.costUsd, 0.03);
  assert.equal(record.requestedModel, 'claude-opus-5');
  assert.equal(record.observedModel, 'multiple');
  assert.equal(record.observedFast, false);
  assert.equal(record.fastModeReason, 'provider');
  assert.doesNotMatch(JSON.stringify(record), /secret/u);
});

test('Claude single modelUsage identifies canonical claude-opus-5 observed model', () => {
  const record = parseClaudeUsageResult({ modelUsage: { 'claude-opus-5': { inputTokens: 1, outputTokens: 1, costUSD: 0 } } });
  assert.equal(record.observedModel, 'claude-opus-5');
});

test('Claude source hash is stable across equivalent JSON key order', () => {
  const first = parseClaudeUsageResult({ modelUsage: { opus: { canonicalModel: 'claude-opus-5', inputTokens: 1, outputTokens: 1 } }, total_cost_usd: 0.1 });
  const reordered = parseClaudeUsageResult({ total_cost_usd: 0.1, modelUsage: { opus: { outputTokens: 1, inputTokens: 1, canonicalModel: 'claude-opus-5' } } });
  assert.equal(first.sourceHash, reordered.sourceHash);
});

test('Claude 2.1.258 preserves Opus canonical identity, thinking, and disabled fast reason', () => {
  const record = parseClaudeUsageResult({ fast_mode_state: 'off', fast_mode_disabled_reason: 'sdk_opt_in_required', total_cost_usd: 0.351953, modelUsage: { helper: { canonicalModel: 'claude-haiku-5', inputTokens: 0, outputTokens: 0, thinkingTokens: 0 }, opus: { canonicalModel: 'claude-opus-5', inputTokens: 2, cacheCreationInputTokens: 26071, outputTokens: 2917, thinkingTokens: 906 } }, usage: { output_tokens_details: { thinking_tokens: 999 } } });
  assert.deepEqual(record.observedModels, ['claude-haiku-5', 'claude-opus-5']);
  assert.equal(record.observedModel, 'multiple');
  assert.equal(record.inputTokens, 26073);
  assert.equal(record.uncachedInputTokens, 26073);
  assert.equal(record.reasoningTokens, 906);
  assert.equal(record.costUsd, 0.351953);
  assert.equal(record.observedFast, 'off');
  assert.equal(record.fastModeReason, 'sdk_opt_in_required');
});

test('Claude legacy usage treats documented input_tokens as raw input', () => {
  const record = parseClaudeUsageResult({ usage: { input_tokens: 10, cache_read_input_tokens: 3, output_tokens: 1 } });
  assert.equal(record.inputTokens, 10);
  assert.equal(record.cachedInputTokens, 3);
  assert.equal(record.uncachedInputTokens, 7);
});
