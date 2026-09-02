import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareRequestedProfile, loadExecutionProfile, validateFastProfile } from '../lib/execution-profile.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const profile = loadExecutionProfile(path.join(here, '..', 'profiles', 'fast-v1.json'));
test('fast profile is versioned and does not cap model calls', () => {
  assert.equal(profile.version, 'fast-v1');
  assert.equal(profile.constraints.modelCallLimit, null);
  assert.throws(() => validateFastProfile({ ...profile, constraints: { ...profile.constraints, modelCallLimit: 1 } }), { code: 'PROFILE_INVALID' });
});
test('profile comparison reports requested versus observed fast-state mismatches', () => {
  const comparison = compareRequestedProfile(profile, { model: 'any-model', reasoning: 'high', fast: false });
  assert.equal(comparison.active, false);
  assert.deepEqual(comparison.mismatches.map((item) => item.field), ['reasoning', 'fast']);
  assert.deepEqual(compareRequestedProfile({ ...profile, model: 'requested-model' }, { model: 'actual-model', reasoning: 'low', fast: true }).mismatches.map((item) => item.field), ['model']);
  assert.equal(compareRequestedProfile(profile, { reasoning: 'low', fast: 'on' }).active, true);
  const off = compareRequestedProfile(profile, { reasoning: 'low', fast: 'off' });
  assert.equal(off.active, false);
  assert.deepEqual(off.mismatches, [{ field: 'fast', requested: true, observed: 'off' }]);
});
