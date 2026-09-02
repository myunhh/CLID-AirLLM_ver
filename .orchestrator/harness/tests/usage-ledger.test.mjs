import test from 'node:test';
import assert from 'node:assert/strict';
import { UsageLedger, createUsageRecord } from '../lib/usage-ledger.mjs';

test('records are versioned, aggregate independently, and retain no arbitrary content fields', () => {
  const ledger = new UsageLedger();
  ledger.add({ provider: 'codex', inputTokens: 4, cachedInputTokens: 1, uncachedInputTokens: 3, outputTokens: 2, reasoningTokens: 1, costUsd: 0.2, requestedModel: 'asked', observedModel: 'seen', requestedFast: true, observedFast: false });
  assert.deepEqual(ledger.summary(), { modelCalls: 1, inputTokens: 4, cachedInputTokens: 1, uncachedInputTokens: 3, outputTokens: 2, reasoningTokens: 1, cacheCreationInputTokens: 0, costUsd: 0.2 });
  assert.equal(createUsageRecord({ provider: 'codex', prompt: 'secret' }).prompt, undefined);
});
