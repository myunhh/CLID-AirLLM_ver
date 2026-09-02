import test from 'node:test';
import assert from 'node:assert/strict';
import { ROUTES, routeModel } from '../lib/admission.mjs';

test('policy routes every task kind to the binding model table', () => {
  for (const [kind, model] of Object.entries(ROUTES)) {
    assert.deepEqual(routeModel({ kind }), { model, provenance: 'policy', taskKind: kind });
  }
});

test('valid explicit user override wins and records provenance', () => {
  assert.deepEqual(routeModel({ kind: 'implementation' }, 'gpt-5.6-sol'), {
    model: 'gpt-5.6-sol', provenance: 'explicit_user_override', taskKind: 'implementation',
  });
});

test('missing, contradictory, invalid model, and Bridge Judge routing reject', () => {
  assert.throws(() => routeModel({}), { code: 'ROUTING_METADATA_MISSING' });
  assert.throws(() => routeModel({ kind: 'implementation', taskKind: 'security' }), { code: 'ROUTING_METADATA_CONTRADICTORY' });
  assert.throws(() => routeModel({ kind: 'implementation' }, 'gpt-5.5'), { code: 'MODEL_INVALID' });
  assert.throws(() => routeModel({ kind: 'independent_judgment', launchedByBridge: true }), { code: 'BRIDGE_JUDGE_FORBIDDEN' });
  assert.throws(() => routeModel({ kind: 'security', role: 'judge' }), { code: 'BRIDGE_JUDGE_FORBIDDEN' });
});
