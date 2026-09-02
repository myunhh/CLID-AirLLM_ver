import { canonicalHash } from './canonical-json.mjs';

export class EvidenceDigestError extends Error {
  constructor(code, details = {}) { super(code); this.name = 'EvidenceDigestError'; this.code = code; this.details = details; }
}
const hash = /^[0-9a-f]{64}$/u;
export function validateEvidenceDigest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EvidenceDigestError('EVIDENCE_INVALID');
  const required = ['metric', 'math', 'unit', 'sourceHash', 'exitStatus', 'anomalyFlags', 'rereadHandle'];
  if (required.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !required.includes(key))) throw new EvidenceDigestError('EVIDENCE_INVALID');
  const math = value.math;
  if (typeof value.metric !== 'string' || !value.metric || !math || typeof math !== 'object' || Array.isArray(math) || Object.keys(math).some((key) => !['numerator', 'denominator', 'formula', 'rounding'].includes(key)) || !Number.isFinite(math.numerator) || !Number.isFinite(math.denominator) || math.denominator === 0 || typeof math.formula !== 'string' || !math.formula || typeof math.rounding !== 'string' || !math.rounding || typeof value.unit !== 'string' || !value.unit || !hash.test(value.sourceHash) || !Number.isSafeInteger(value.exitStatus) || !Array.isArray(value.anomalyFlags) || value.anomalyFlags.some((flag) => typeof flag !== 'string') || typeof value.rereadHandle !== 'string' || !value.rereadHandle) throw new EvidenceDigestError('EVIDENCE_INVALID');
  return Object.freeze({ ...value, math: Object.freeze({ ...math }), anomalyFlags: Object.freeze([...value.anomalyFlags]) });
}
export function evidenceDigest(value) { return canonicalHash(validateEvidenceDigest(value)); }
