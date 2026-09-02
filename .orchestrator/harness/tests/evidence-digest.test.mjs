import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceDigest, validateEvidenceDigest } from '../lib/evidence-digest.mjs';
const evidence = { metric: 'tests', math: { numerator: 4, denominator: 4, formula: 'passed/total', rounding: 'none' }, unit: 'tests', sourceHash: 'a'.repeat(64), exitStatus: 0, anomalyFlags: [], rereadHandle: 'tests.log:1' };
test('typed evidence includes math, units, provenance, status, anomalies, and reread handle', () => {
  assert.match(evidenceDigest(evidence), /^[0-9a-f]{64}$/u);
  assert.throws(() => validateEvidenceDigest({ ...evidence, sourceHash: 'bad' }), { code: 'EVIDENCE_INVALID' });
  assert.throws(() => validateEvidenceDigest({ ...evidence, math: { ...evidence.math, denominator: 0 } }), { code: 'EVIDENCE_INVALID' });
});
