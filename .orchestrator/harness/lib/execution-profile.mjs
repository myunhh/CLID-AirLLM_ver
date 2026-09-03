import fs from 'node:fs';

export class ExecutionProfileError extends Error {
  constructor(code, details = {}) { super(code); this.name = 'ExecutionProfileError'; this.code = code; this.details = details; }
}

export function validateExecutionProfile(profile) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile)) throw new ExecutionProfileError('PROFILE_INVALID');
  const expectedFast = profile.version === 'fast-v1' ? true : profile.version === 'standard-v1' ? false : undefined;
  if (expectedFast === undefined || profile.fast !== expectedFast || typeof profile.reasoning !== 'string') throw new ExecutionProfileError('PROFILE_INVALID');
  if (profile.model !== null && typeof profile.model !== 'string') throw new ExecutionProfileError('PROFILE_INVALID');
  if (!profile.constraints || profile.constraints.modelCallLimit !== null || profile.constraints.allowPlanning !== false || profile.constraints.allowDelegation !== false) throw new ExecutionProfileError('PROFILE_INVALID');
  return Object.freeze({ ...profile, constraints: Object.freeze({ ...profile.constraints }) });
}

export function validateFastProfile(profile) {
  const validated = validateExecutionProfile(profile);
  if (validated.version !== 'fast-v1' || validated.fast !== true) throw new ExecutionProfileError('PROFILE_INVALID');
  return validated;
}

export function loadExecutionProfile(file) { return validateExecutionProfile(JSON.parse(fs.readFileSync(file, 'utf8'))); }

export function compareRequestedProfile(profile, observed = {}) {
  const requested = validateExecutionProfile(profile);
  const mismatches = [];
  const fastState = observed.fast === true || observed.fast === 'on' || observed.fast === 'enabled';
  const expectedFields = [['reasoning', requested.reasoning], ['fast', requested.fast]];
  if (requested.model !== null) expectedFields.unshift(['model', requested.model]);
  for (const [field, expected] of expectedFields) {
    const actual = field === 'fast' ? fastState : observed[field];
    if (!Object.hasOwn(observed, field) || actual !== expected) mismatches.push({ field, requested: expected, observed: observed[field] ?? null });
  }
  return Object.freeze({ requested, observed: { ...observed }, active: mismatches.length === 0, mismatches: Object.freeze(mismatches) });
}
