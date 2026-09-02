import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { EventStore } from './event-store.mjs';
import { canonicalPathIdentity, assertPathIdentityUnchanged } from './path-identity.mjs';
import { createUsageRecord } from './usage-ledger.mjs';

export const DIMENSIONS = Object.freeze(['tokens', 'toolCalls', 'wallSeconds', 'processes']);
export const ROUTES = Object.freeze({
  read_only_evidence: 'gpt-5.6-luna',
  implementation: 'gpt-5.6-terra',
  architecture: 'gpt-5.6-sol',
  security: 'gpt-5.6-sol',
  migration: 'gpt-5.6-sol',
  independent_judgment: 'gpt-5.6-sol',
});
const MODELS = new Set(Object.values(ROUTES));

export function hardContainmentCapability(platform = process.platform) {
  return Object.freeze({
    available: true,
    verified: false,
    requiresLiveProbe: true,
    platform,
    provider: platform === 'win32' ? 'windows_job_object' : 'posix_process_group',
  });
}

export class AdmissionError extends Error {
  constructor(code, dimension) {
    super(code);
    this.name = 'AdmissionError';
    this.code = code;
    this.dimension = dimension;
  }
}

function fail(code, dimension) { throw new AdmissionError(code, dimension); }

export function validateBudget(value, label = 'budget') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('BUDGET_INVALID');
  const result = {};
  for (const dimension of DIMENSIONS) {
    if (!Number.isSafeInteger(value[dimension]) || value[dimension] <= 0) fail('BUDGET_INVALID', dimension);
    result[dimension] = value[dimension];
  }
  if (Object.keys(value).some((key) => !DIMENSIONS.includes(key))) fail('BUDGET_INVALID');
  return Object.freeze({ ...result, label });
}

export function routeModel(metadata, userOverride) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) fail('ROUTING_METADATA_MISSING');
  if (metadata.bridgeJudge === true || metadata.role === 'judge' || metadata.kind === 'independent_judgment' && metadata.launchedByBridge === true) {
    fail('BRIDGE_JUDGE_FORBIDDEN');
  }
  const declared = [metadata.kind, metadata.taskKind].filter((item) => item !== undefined);
  if (declared.length === 0) fail('ROUTING_METADATA_MISSING');
  if (declared.length > 1 && declared[0] !== declared[1]) fail('ROUTING_METADATA_CONTRADICTORY');
  if (!Object.hasOwn(ROUTES, declared[0])) fail('ROUTING_METADATA_INVALID');
  if (userOverride !== undefined && !MODELS.has(userOverride)) fail('MODEL_INVALID');
  return Object.freeze({
    model: userOverride ?? ROUTES[declared[0]],
    provenance: userOverride === undefined ? 'policy' : 'explicit_user_override',
    taskKind: declared[0],
  });
}

function usageShape(value) {
  if (!value || typeof value !== 'object') fail('INCOMPLETE_USAGE_EVIDENCE');
  const usage = {};
  for (const dimension of DIMENSIONS) {
    if (!Number.isFinite(value[dimension]) || value[dimension] < 0) fail('INCOMPLETE_USAGE_EVIDENCE', dimension);
    usage[dimension] = value[dimension];
  }
  return usage;
}

async function acquire(lockPath, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try { fs.mkdirSync(lockPath); return; } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) fail('ADMISSION_LOCK_TIMEOUT');
      await delay(10);
    }
  }
}

function readState(file, capacity) {
  if (!fs.existsSync(file)) return { capacity, reservations: {} };
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const dimension of DIMENSIONS) {
    if (state.capacity?.[dimension] !== capacity[dimension]) fail('BUDGET_CAPACITY_MISMATCH', dimension);
  }
  return state;
}

function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { flag: 'wx' });
  fs.renameSync(temporary, file);
}

function totals(state) {
  const result = Object.fromEntries(DIMENSIONS.map((key) => [key, 0]));
  for (const reservation of Object.values(state.reservations)) {
    if (reservation.status !== 'reserved') continue;
    for (const dimension of DIMENSIONS) result[dimension] += reservation.budget[dimension];
  }
  return result;
}

export class AdmissionLedger {
  constructor({ runDir, runId, capacity, workspaceRoot }) {
    this.runDir = path.resolve(runDir);
    this.runId = runId;
    this.capacity = validateBudget(capacity, 'capacity');
    this.workspaceRoot = workspaceRoot;
    this.statePath = path.join(this.runDir, 'admission.json');
    this.lockPath = path.join(this.runDir, '.admission.lock');
    this.store = new EventStore({ runDir: this.runDir, runId });
  }

  async reserve({ childId, budget, metadata, userModel, owns = [], strictPreConsumption = false, containment = {} }) {
    const requested = validateBudget(budget, 'reservation');
    if (strictPreConsumption) fail('UNSUPPORTED_HARD_BUDGET');
    if (containment.wall !== true || containment.processTree !== true) fail('CONTAINMENT_UNAVAILABLE');
    const routing = routeModel(metadata, userModel);
    if (typeof childId !== 'string' || childId.length === 0) fail('CHILD_ID_INVALID');
    const identities = owns.map((item) => canonicalPathIdentity(item, this.workspaceRoot));
    fs.mkdirSync(this.runDir, { recursive: true });
    await acquire(this.lockPath);
    try {
      const state = readState(this.statePath, this.capacity);
      if (state.reservations[childId]) fail('CHILD_ID_CONFLICT');
      const used = totals(state);
      for (const dimension of DIMENSIONS) {
        if (used[dimension] + requested[dimension] > this.capacity[dimension]) fail('BUDGET_ADMISSION_EXCEEDED', dimension);
      }
      for (const identity of identities) assertPathIdentityUnchanged(identity, this.workspaceRoot);
      state.reservations[childId] = { budget: Object.fromEntries(DIMENSIONS.map((d) => [d, requested[d]])), status: 'reserved', routing, identities };
      atomicJson(this.statePath, state);
      await this.store.append({ runId: this.runId, type: 'bridge_admitted', producer: 'bridge', authority: 'workflow_assertion', data: { childId, budget: state.reservations[childId].budget, routing, owns: identities.map((i) => ({ declaredPath: i.declaredPath, canonicalAbsolutePath: i.canonicalAbsolutePath, lockHash: i.lockHash })) } });
      return state.reservations[childId];
    } catch (error) {
      if (error instanceof AdmissionError && error.code === 'BUDGET_ADMISSION_EXCEEDED') {
        await this.store.append({ runId: this.runId, type: 'bridge_admission_rejected', producer: 'bridge', authority: 'workflow_assertion', data: { childId, reason: error.code, dimension: error.dimension } });
      }
      throw error;
    } finally { fs.rmdirSync(this.lockPath); }
  }

  async release(childId, usage, outcome = 'completed', usageDetails) {
    const observed = usageShape(usage);
    const details = usageDetails === undefined ? undefined : createUsageRecord(usageDetails);
    await acquire(this.lockPath);
    try {
      const state = readState(this.statePath, this.capacity);
      const reservation = state.reservations[childId];
      if (!reservation || reservation.status !== 'reserved') fail('RESERVATION_NOT_ACTIVE');
      reservation.status = 'released';
      reservation.usage = observed;
      reservation.usageComplete = true;
      if (details !== undefined) reservation.usageDetails = details;
      reservation.outcome = outcome;
      atomicJson(this.statePath, state);
      await this.store.append({ runId: this.runId, type: 'bridge_reservation_released', producer: 'bridge', authority: 'workflow_assertion', data: { childId, usage: observed, ...(details === undefined ? {} : { usageDetails: details }), outcome } });
    } finally { fs.rmdirSync(this.lockPath); }
  }

  async releaseIncomplete(childId, outcome = 'incomplete_usage') {
    const unknown = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, 'unknown']));
    return this.releasePartial(childId, unknown, outcome);
  }

  async releaseWallTimeout(childId, wallSeconds) {
    const usage = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, 'unknown']));
    usage.wallSeconds = wallSeconds;
    return this.releasePartial(childId, usage, 'bridge_budget_exceeded(wallSeconds)');
  }

  async releasePartial(childId, usage, outcome) {
    if (!usage || typeof usage !== 'object' || DIMENSIONS.some((dimension) => usage[dimension] !== 'unknown' && (!Number.isFinite(usage[dimension]) || usage[dimension] < 0))) {
      fail('INCOMPLETE_USAGE_EVIDENCE');
    }
    await acquire(this.lockPath);
    try {
      const state = readState(this.statePath, this.capacity);
      const reservation = state.reservations[childId];
      if (!reservation || reservation.status !== 'reserved') fail('RESERVATION_NOT_ACTIVE');
      reservation.status = 'released';
      reservation.usage = { ...usage };
      reservation.usageComplete = false;
      reservation.outcome = outcome;
      atomicJson(this.statePath, state);
      await this.store.append({ runId: this.runId, type: 'bridge_reservation_released', producer: 'bridge', authority: 'workflow_assertion', data: { childId, usage: { ...usage }, usageComplete: false, outcome } });
    } finally { fs.rmdirSync(this.lockPath); }
  }
}

export function terminateProcessTree(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-child.pid, 'SIGKILL');
  } catch { try { child.kill('SIGKILL'); } catch {} }
}

export async function launchBudgetedRunner({ ledger, reservation }) {
  const { childId, budget } = reservation;
  await ledger.release(childId, Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, 0])), 'public_request_file_required');
  fail('PUBLIC_REQUEST_FILE_REQUIRED', budget?.processes === undefined ? 'processes' : undefined);
}
