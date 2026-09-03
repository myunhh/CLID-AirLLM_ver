import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalHash, canonicalJson, sha256Bytes } from './canonical-json.mjs';
import { validateExecutionProfile } from './execution-profile.mjs';
import { EventStore } from './event-store.mjs';
import { createUsageRecord } from './usage-ledger.mjs';
import { runSupervisedProcess, fenceActiveLeases } from './process-supervisor.mjs';
import {
  blueprintDigest, policyDigest, compilePlan, writePlanDirectory, verifyPlanDirectory,
  materializeScaffold, compareScaffoldGraph, beginNodeAttempt, completeNodeAttempt,
  readAttemptLedger,
} from './blueprint-scaffold.mjs';
import { compileWorkerCommand } from '../command-worker.mjs';
import { dispatchCodex } from '../codex-dispatcher.mjs';

const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
const PROFILE = Object.freeze({
  standard: { version: 'standard-v1', fast: false, reasoning: 'low', model: null, constraints: { modelCallLimit: null, allowPlanning: false, allowDelegation: false } },
  fast: { version: 'fast-v1', fast: true, reasoning: 'low', model: null, constraints: { modelCallLimit: null, allowPlanning: false, allowDelegation: false } },
});

export class AutomationError extends Error {
  constructor(code, details = {}) { super(code); this.name = 'AutomationError'; this.code = code; this.details = details; }
}
const fail = (code, details) => { throw new AutomationError(code, details); };
const exactKeys = (value, allowed, required = allowed) => value && typeof value === 'object' && !Array.isArray(value)
  && required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.includes(key));

function validateToolConfig(value, kind) {
  const allowed = kind === 'graphify' ? ['executable', 'args', 'timeoutMs'] : ['executable', 'args'];
  if (!exactKeys(value, allowed, ['executable']) || typeof value.executable !== 'string' || !value.executable
    || (value.args !== undefined && (!Array.isArray(value.args) || !value.args.every((item) => typeof item === 'string')))
    || (value.timeoutMs !== undefined && (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 1))) fail('RUNTIME_CONFIG_INVALID');
  return Object.freeze({ executable: value.executable, args: Object.freeze([...(value.args ?? [])]), ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }) });
}

export function validateRuntimeConfig(value = {}) {
  if (!exactKeys(value, ['graphify', 'codex', 'dispatcher', 'model', 'reasoning'], []) || (value.codex !== undefined && value.dispatcher !== undefined)
    || (value.model !== undefined && (typeof value.model !== 'string' || !value.model)) || (value.reasoning !== undefined && (typeof value.reasoning !== 'string' || !value.reasoning))) fail('RUNTIME_CONFIG_INVALID');
  return Object.freeze({
    graphify: value.graphify === undefined ? Object.freeze({ executable: 'graphify', args: Object.freeze([]), timeoutMs: 120_000 }) : validateToolConfig(value.graphify, 'graphify'),
    ...(value.dispatcher === undefined ? { codex: value.codex === undefined ? Object.freeze({ executable: 'codex', args: Object.freeze([]) }) : validateToolConfig(value.codex, 'codex') } : { dispatcher: validateToolConfig(value.dispatcher, 'dispatcher') }),
    ...(value.model === undefined ? {} : { model: value.model }),
    ...(value.reasoning === undefined ? {} : { reasoning: value.reasoning }),
  });
}

function runProcess(executable, args, { cwd, input = '', timeoutMs, codePrefix, leaseDir }) {
  return runSupervisedProcess(executable, args, { cwd, input, timeoutMs, maxCaptureBytes: MAX_CAPTURE_BYTES, leaseDir }).then((result) => {
    if (result.outputTooLarge) fail(`${codePrefix}_OUTPUT_TOO_LARGE`);
    if (result.launchError) fail(`${codePrefix}_LAUNCH_FAILED`, { cause: result.launchError });
    return result;
  }).catch((error) => { if (error instanceof AutomationError) throw error; throw new AutomationError(`${codePrefix}_SUPERVISOR_FAILED`, { cause: error.code }); });
}

function processAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function acquireRunLock(runtimeDir, runId) {
  const lock = path.join(runtimeDir, '.run.lock'), ownerFile = path.join(lock, 'owner.json');
  fs.mkdirSync(runtimeDir, { recursive: true });
  try { fs.mkdirSync(lock); fs.writeFileSync(ownerFile, `${canonicalJson({ schemaVersion: 1, pid: process.pid, runId })}\n`, { flag: 'wx' }); return lock; }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    let owner;
    try { owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8')); } catch { fail('AUTOMATION_LOCK_IDENTITY_UNCERTAIN'); }
    if (!exactKeys(owner, ['schemaVersion', 'pid', 'runId']) || owner.schemaVersion !== 1 || owner.runId !== runId) fail('AUTOMATION_LOCK_IDENTITY_UNCERTAIN');
    if (processAlive(owner.pid)) fail('AUTOMATION_LOCKED');
    const recovered = `${lock}.stale-${process.pid}-${randomUUID()}`;
    try { fs.renameSync(lock, recovered); fs.rmSync(recovered, { recursive: true }); fs.mkdirSync(lock); fs.writeFileSync(ownerFile, `${canonicalJson({ schemaVersion: 1, pid: process.pid, runId })}\n`, { flag: 'wx' }); return lock; }
    catch { fail('AUTOMATION_LOCK_IDENTITY_UNCERTAIN'); }
  }
}

function releaseRunLock(lock) {
  try { fs.rmSync(lock, { recursive: true }); } catch {}
}

function relativeInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' ? '' : (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative) ? relative : null);
}

function resolvedMissingPath(target) {
  let cursor = path.resolve(target);
  const missing = [];
  while (!fs.existsSync(cursor)) {
    const parent = path.dirname(cursor);
    if (parent === cursor) fail('PLAN_DIRECTORY_INVALID');
    missing.unshift(path.basename(cursor)); cursor = parent;
  }
  let resolved;
  try { resolved = fs.realpathSync.native(cursor); } catch { fail('PLAN_DIRECTORY_INVALID'); }
  return path.resolve(resolved, ...missing);
}

function assertExternalPlanDirectory(workspaceRoot, planDir) {
  let workspace;
  try { workspace = fs.realpathSync.native(path.resolve(workspaceRoot)); } catch { fail('AUTOMATION_INPUT_INVALID'); }
  const resolvedPlan = resolvedMissingPath(planDir);
  if (relativeInside(workspace, resolvedPlan) !== null) fail('PLAN_DIRECTORY_INSIDE_WORKSPACE');
  return resolvedPlan;
}

function snapshotWorkspace(workspaceRoot, planDir) {
  const root = fs.realpathSync.native(path.resolve(workspaceRoot));
  const plan = fs.existsSync(planDir) ? fs.realpathSync.native(path.resolve(planDir)) : path.resolve(planDir);
  const excludedPlan = relativeInside(root, plan);
  const records = [];
  function walk(absolute, relative = '') {
    for (const name of fs.readdirSync(absolute).sort((a, b) => a.localeCompare(b))) {
      const childRelative = relative ? `${relative}/${name}` : name;
      if (childRelative === '.git' || childRelative.startsWith('.git/')) continue;
      if (excludedPlan !== null) {
        const portablePlan = excludedPlan.split(path.sep).join('/');
        if (childRelative === portablePlan || childRelative.startsWith(`${portablePlan}/`)) continue;
      }
      const child = path.join(absolute, name), stat = fs.lstatSync(child);
      if (stat.isSymbolicLink()) records.push([childRelative, 'link', sha256Bytes(fs.readlinkSync(child))]);
      else if (stat.isDirectory()) { records.push([childRelative, 'dir']); walk(child, childRelative); }
      else if (stat.isFile()) records.push([childRelative, 'file', sha256Bytes(fs.readFileSync(child))]);
      else records.push([childRelative, 'other']);
    }
  }
  walk(root);
  return Object.freeze({ records, digest: canonicalHash(records) });
}

function changedPaths(before, after) {
  const a = new Map(before.records.map((record) => [record[0], canonicalJson(record.slice(1))]));
  const b = new Map(after.records.map((record) => [record[0], canonicalJson(record.slice(1))]));
  return [...new Set([...a.keys(), ...b.keys()])].filter((key) => a.get(key) !== b.get(key)).sort();
}

function assertOwnedChanges(before, after, allowed) {
  const permitted = new Set(allowed.map((item) => item.split(path.sep).join('/')));
  const unexpected = changedPaths(before, after).filter((item) => !permitted.has(item));
  if (unexpected.length) fail('WORKSPACE_WRITE_VIOLATION', { paths: unexpected });
  const afterTypes = new Map(after.records.map((record) => [record[0], record[1]]));
  for (const item of permitted) if (afterTypes.get(item) !== 'file') fail('WORKSPACE_PRODUCT_INVALID', { path: item });
}

function assertInterruptedChanges(before, after, productPaths, resultPaths) {
  const products = new Set(productPaths.map((item) => item.split(path.sep).join('/')));
  const results = new Set(resultPaths.map((item) => item.split(path.sep).join('/')));
  const beforeTypes = new Map(before.records.map((record) => [record[0], record[1]]));
  const afterTypes = new Map(after.records.map((record) => [record[0], record[1]]));
  const resultAncestors = new Set();
  for (const result of [...results].filter((item) => afterTypes.get(item) === 'file')) {
    let ancestor = path.posix.dirname(result);
    while (ancestor !== '.') { resultAncestors.add(ancestor); ancestor = path.posix.dirname(ancestor); }
  }
  const unexpected = [];
  for (const changed of changedPaths(before, after)) {
    if (products.has(changed) || results.has(changed)) {
      if (afterTypes.get(changed) !== 'file') unexpected.push(changed);
    } else if (resultAncestors.has(changed)) {
      if (beforeTypes.has(changed) || afterTypes.get(changed) !== 'dir') unexpected.push(changed);
    } else unexpected.push(changed);
  }
  if (unexpected.length) fail('WORKSPACE_WRITE_VIOLATION', { paths: unexpected.sort() });
}

function validateTerminalResultArtifacts(state, plan, workspaceRoot) {
  for (const [nodeId, nodeState] of Object.entries(state.nodes ?? {})) {
    if (nodeState.status === 'RUNNING' || nodeState.attempts.length === 0) continue;
    const attempt = nodeState.attempts.at(-1), node = plan.nodes.find((item) => item.id === nodeId);
    const target = node && path.resolve(workspaceRoot, ...node.resultArtifactRef.split('/'));
    if (!target || !fs.existsSync(target) || !fs.lstatSync(target).isFile() || sha256Bytes(fs.readFileSync(target)) !== attempt.resultDigest) fail('RESULT_ARTIFACT_DIGEST_MISMATCH', { nodeId });
  }
}

function readJson(file, code) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail(code, { file }); }
}

async function runGraphify({ config, workspaceRoot, phaseDir, blueprint, policy, phase, leaseDir }) {
  const args = [...config.args, 'extract', workspaceRoot, '--code-only', '--no-cluster', '--force', '--out', phaseDir];
  const result = await runProcess(config.executable, args, { cwd: workspaceRoot, timeoutMs: config.timeoutMs ?? 120_000, codePrefix: 'GRAPHIFY', leaseDir });
  if (result.timedOut) fail('GRAPHIFY_TIMEOUT');
  if (result.exitCode !== 0) fail('GRAPHIFY_FAILED', { exitCode: result.exitCode, stderrDigest: sha256Bytes(result.stderr) });
  const graphPath = path.join(phaseDir, 'graphify-out', 'graph.json');
  const graph = readJson(graphPath, 'GRAPHIFY_OUTPUT_INVALID');
  let report;
  try { report = compareScaffoldGraph({ blueprint, policy, observedGraph: graph, phase }); }
  catch (error) { fail('GRAPHIFY_OUTPUT_INVALID', { cause: error.code }); }
  return { graph, graphDigest: sha256Bytes(fs.readFileSync(graphPath)), report };
}

function validateDispatchResponse(value) {
  const keys = ['schemaVersion', 'status', 'exitCode', 'usage', 'observedProfile', 'transportDigest'];
  if (!exactKeys(value, keys) || value.schemaVersion !== 1 || !['succeeded', 'failed', 'timeout'].includes(value.status)
    || !Number.isInteger(value.exitCode) || !Array.isArray(value.usage) || !value.usage.every((item) => item && typeof item === 'object' && !Array.isArray(item) && !Object.keys(item).some((key) => ['prompt', 'reply', 'content', 'text', 'message'].includes(key)))
    || !exactKeys(value.observedProfile, ['model', 'reasoning', 'fast'])
    || ![null, 'string'].includes(value.observedProfile.model === null ? null : typeof value.observedProfile.model)
    || ![null, 'string'].includes(value.observedProfile.reasoning === null ? null : typeof value.observedProfile.reasoning)
    || ![null, true, false].includes(value.observedProfile.fast) || !/^[0-9a-f]{64}$/u.test(value.transportDigest)) fail('DISPATCH_RESPONSE_INVALID');
  let usage;
  try {
    usage = value.usage.map((item) => {
      const normalized = createUsageRecord(item);
      if (canonicalJson(normalized) !== canonicalJson(item)) fail('DISPATCH_RESPONSE_INVALID');
      return normalized;
    });
  } catch (error) { if (error instanceof AutomationError) throw error; fail('DISPATCH_RESPONSE_INVALID'); }
  return Object.freeze({ ...value, usage: Object.freeze(usage), observedProfile: Object.freeze({ ...value.observedProfile }) });
}

function verifyTransportArtifact(request, response, runtimeDir) {
  const runtime = fs.realpathSync.native(runtimeDir), target = path.resolve(request.transportArtifactPath);
  if (relativeInside(runtime, target) === null || !fs.existsSync(target) || !fs.lstatSync(target).isFile()) fail('DISPATCH_TRANSPORT_INVALID');
  const realTarget = fs.realpathSync.native(target);
  if (relativeInside(runtime, realTarget) === null || sha256Bytes(fs.readFileSync(realTarget)) !== response.transportDigest) fail('DISPATCH_TRANSPORT_INVALID');
}

async function dispatchExternal(request, config) {
  const leaseDir = path.join(path.dirname(path.dirname(request.transportArtifactPath)), 'leases');
  const result = await runProcess(config.executable, config.args, { cwd: request.workspaceRoot, input: `${canonicalJson(request)}\n`, timeoutMs: Math.max(1, Math.floor(request.budget.wallSeconds * 1000)), codePrefix: 'DISPATCH', leaseDir });
  if (result.timedOut) return { schemaVersion: 1, status: 'timeout', exitCode: result.exitCode, usage: [], observedProfile: { model: null, reasoning: null, fast: null }, transportDigest: sha256Bytes(result.stdout) };
  if (result.exitCode !== 0) return { schemaVersion: 1, status: 'failed', exitCode: result.exitCode, usage: [], observedProfile: { model: null, reasoning: null, fast: null }, transportDigest: sha256Bytes(result.stdout) };
  let response;
  try { response = JSON.parse(result.stdout.toString('utf8')); } catch { fail('DISPATCH_RESPONSE_INVALID'); }
  return validateDispatchResponse(response);
}

async function runVerifier(command, workspaceRoot, timeoutMs, leaseDir) {
  const root = fs.realpathSync.native(path.resolve(workspaceRoot)), declared = path.resolve(root, ...(command.cwd ?? '').split('/').filter(Boolean));
  let cwd; try { cwd = fs.realpathSync.native(declared); } catch { fail('VERIFIER_CWD_INVALID'); }
  if (relativeInside(root, cwd) === null) fail('VERIFIER_CWD_INVALID');
  const result = await runProcess(command.command, command.args, { cwd, timeoutMs, codePrefix: 'VERIFIER', leaseDir });
  return { exitCode: result.exitCode, timedOut: result.timedOut, stdoutDigest: sha256Bytes(result.stdout), stderrDigest: sha256Bytes(result.stderr) };
}

function writeResult(workspaceRoot, node, evidence) {
  const target = path.resolve(workspaceRoot, ...node.resultArtifactRef.split('/'));
  if (relativeInside(path.resolve(workspaceRoot), target) === null) fail('RESULT_ARTIFACT_INVALID');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const bytes = `${canonicalJson(evidence)}\n`;
  fs.writeFileSync(target, bytes, { mode: 0o600 });
  return { target, digest: sha256Bytes(bytes) };
}

async function append(store, runId, type, data) {
  return store.append({ runId, type, producer: 'scaffold-automation', authority: 'orchestrator', data });
}

function bindingsFor({ blueprint, policy, gate, plan, workspaceRoot, runtimeConfig, fast }) {
  return {
    blueprintDigest: blueprintDigest(blueprint, policy), policyDigest: policyDigest(policy), gateDigest: gate.attestationDigest,
    planDigest: plan.planDigest, workspaceDigest: canonicalHash({ workspaceRoot: fs.realpathSync.native(path.resolve(workspaceRoot)) }),
    runtimeConfigDigest: canonicalHash(runtimeConfig), requestedFastDigest: canonicalHash({ fast }),
  };
}

export async function runScaffoldAutomation(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || typeof options.fast !== 'undefined' && typeof options.fast !== 'boolean') fail('AUTOMATION_INPUT_INVALID');
  const { blueprint, policy, gate, receipts, findingsRoot } = options;
  const workspaceRoot = path.resolve(options.workspaceRoot), planDir = path.resolve(options.planDir), fast = options.fast === true;
  assertExternalPlanDirectory(workspaceRoot, planDir);
  const runtimeConfig = validateRuntimeConfig(options.runtimeConfig);
  const requestedProfile = validateExecutionProfile({ ...(fast ? PROFILE.fast : PROFILE.standard), model: runtimeConfig.model ?? null, reasoning: runtimeConfig.reasoning ?? PROFILE.standard.reasoning });
  const planInputs = { blueprint, policy, gate, receipts, findingsRoot, workspaceRoot };
  const plan = compilePlan(planInputs);
  if (fs.existsSync(path.join(planDir, 'plan.json'))) verifyPlanDirectory(planDir, planInputs); else writePlanDirectory(planDir, plan, planInputs);
  assertExternalPlanDirectory(workspaceRoot, planDir);
  const runtimeDir = path.join(planDir, 'runtime'), bindings = bindingsFor({ blueprint, policy, gate, plan, workspaceRoot, runtimeConfig, fast });
  const runId = `scaffold-${plan.planDigest.slice(0, 32)}`, lock = acquireRunLock(runtimeDir, runId);
  const store = new EventStore({ runDir: runtimeDir, runId });
  try {
    await fenceActiveLeases(path.join(runtimeDir, 'leases'));
    const replay = store.replay(), bound = replay.events.find((event) => event.type === 'RUN_BOUND');
    if (bound && canonicalJson(bound.data) !== canonicalJson(bindings)) fail('RUN_BINDING_MISMATCH');
    if (!bound) await append(store, runId, 'RUN_BOUND', bindings);
    verifyPlanDirectory(planDir, planInputs);
    const complete = store.replay().events.findLast((event) => event.type === 'COMPLETE');
    if (complete) return Object.freeze({ status: 'COMPLETE', runId, planDigest: plan.planDigest, eventHash: complete.eventHash, ...complete.data });
    if (plan.nodes.some((node) => node.verificationCommands.length === 0)) fail('VERIFIER_REQUIRED');
    let events = store.replay().events;
    if (!events.some((event) => event.type === 'MATERIALIZED')) {
      const materialized = materializeScaffold({ ...planInputs, planDir });
      await append(store, runId, 'MATERIALIZED', { planDigest: plan.planDigest, statusDigest: canonicalHash(materialized) });
      events = store.replay().events;
    }
    const priorStructure = events.findLast((event) => event.type === 'STRUCTURE_GATED');
    if (!priorStructure) {
      const pre = await runGraphify({ config: runtimeConfig.graphify, workspaceRoot, phaseDir: path.join(runtimeDir, `pre-${randomUUID()}`), blueprint, policy, phase: 'structure', leaseDir: path.join(runtimeDir, 'leases') });
      await append(store, runId, 'STRUCTURE_GATED', { graphDigest: pre.graphDigest, reportDigest: pre.report.reportDigest, matches: pre.report.matches });
      if (!pre.report.matches) fail('STRUCTURE_GATE_MISMATCH', { reportDigest: pre.report.reportDigest });
    } else if (priorStructure.data.matches !== true) fail('STRUCTURE_GATE_MISMATCH', { reportDigest: priorStructure.data.reportDigest });

    const ledgerPath = path.join(runtimeDir, 'attempt-ledger.json');
    if (fs.existsSync(ledgerPath)) {
      const state = readAttemptLedger(ledgerPath, plan);
      validateTerminalResultArtifacts(state, plan, workspaceRoot);
      const running = Object.entries(state.nodes ?? {}).filter(([, value]) => value.status === 'RUNNING');
      if (running.length) {
        const interruptedWave = store.replay().events.findLast((event) => event.type === 'WAVE_STARTED');
        if (!interruptedWave || !Array.isArray(interruptedWave.data.snapshotRecords) || !Array.isArray(interruptedWave.data.allowedPaths) || !Array.isArray(interruptedWave.data.resultArtifactRefs)) fail('INTERRUPTED_SNAPSHOT_MISSING');
        const baseline = { records: interruptedWave.data.snapshotRecords, digest: canonicalHash(interruptedWave.data.snapshotRecords) };
        if (baseline.digest !== interruptedWave.data.snapshotDigest) fail('INTERRUPTED_SNAPSHOT_INVALID');
        assertInterruptedChanges(baseline, snapshotWorkspace(workspaceRoot, planDir), interruptedWave.data.allowedPaths, interruptedWave.data.resultArtifactRefs);
      }
      for (const [nodeId, nodeState] of running) {
        const attempt = nodeState.attempts.at(-1), node = plan.nodes.find((item) => item.id === nodeId);
        const artifact = writeResult(workspaceRoot, node, { schemaVersion: 1, nodeId, attemptId: attempt.attemptId, status: 'interrupted', process: { status: 'failed', exitCode: 1 }, verification: [] });
        completeNodeAttempt({ ledgerPath, plan, nodeId, attemptId: attempt.attemptId, resultDigest: artifact.digest, outcome: 'failed' });
        await append(store, runId, 'ATTEMPT_INTERRUPTED', { nodeId, attemptId: attempt.attemptId, resultDigest: artifact.digest });
      }
    }

    for (;;) {
      const state = fs.existsSync(ledgerPath) ? readAttemptLedger(ledgerPath, plan) : { nodes: {} };
      const succeeded = new Set(Object.entries(state.nodes ?? {}).filter(([, value]) => value.status === 'SUCCEEDED').map(([id]) => id));
      if (succeeded.size === plan.nodes.length) break;
      if (Object.values(state.nodes ?? {}).some((value) => value.status === 'ESCALATED')) fail('ATTEMPTS_EXHAUSTED');
      const ready = plan.nodes.filter((node) => !succeeded.has(node.id) && state.nodes?.[node.id]?.status !== 'RUNNING' && node.dependsOn.every((id) => succeeded.has(id))).sort((a, b) => a.id.localeCompare(b.id));
      if (!ready.length) fail('AUTOMATION_STALLED');
      const capsuleDirs = ready.map((node) => path.join(planDir, 'capsules', node.id));
      const prepared = ready.map((node, index) => {
        const peers = capsuleDirs.filter((_, peer) => peer !== index), manifest = plan.manifest.find((item) => item.path === node.path);
        if (!manifest) fail('PLAN_MANIFEST_INVALID');
        const resultPath = path.resolve(workspaceRoot, ...node.resultArtifactRef.split('/'));
        const requiredReads = [path.resolve(workspaceRoot, ...manifest.sidecarPath.split('/')), ...(fs.existsSync(resultPath) ? [resultPath] : [])];
        const compiledCommand = compileWorkerCommand({ capsuleDir: capsuleDirs[index], parallelCapsuleDirs: peers, reads: requiredReads, writes: node.writeSet, skillPaths: (node.skillPaths ?? []).map((item) => path.resolve(workspaceRoot, ...item.split('/'))), fast });
        return { node, capsuleDir: capsuleDirs[index], resultPath, compiledCommand };
      });
      const before = snapshotWorkspace(workspaceRoot, planDir);
      await append(store, runId, 'WAVE_STARTED', { nodeIds: ready.map((node) => node.id), snapshotDigest: before.digest, snapshotRecords: before.records, allowedPaths: ready.flatMap((node) => node.writeSet).sort(), resultArtifactRefs: ready.map((node) => node.resultArtifactRef).sort() });
      const attempts = prepared.map(({ node, capsuleDir, resultPath, compiledCommand }) => {
        const attemptId = `${node.id}-${randomUUID()}`, begun = beginNodeAttempt({ ledgerPath, plan, nodeId: node.id, attemptId });
        const request = {
          schemaVersion: 1, planDigest: plan.planDigest, nodeId: node.id, attemptId, workspaceRoot, capsuleDir,
          compiledCommand,
          budget: node.budgets, requestedProfile: { version: requestedProfile.version, model: requestedProfile.model, reasoning: requestedProfile.reasoning, fast: requestedProfile.fast },
          sandbox: 'workspace-write', fast, resultArtifactRef: node.resultArtifactRef,
          previousResultArtifactRef: fs.existsSync(resultPath) ? node.resultArtifactRef : null,
          transportArtifactPath: path.join(runtimeDir, 'transport', `${attemptId}.jsonl`),
        };
        return { node, attemptId, begun, request, startedAt: Date.now() };
      });
      for (const attempt of attempts) await append(store, runId, 'ATTEMPT_STARTED', { nodeId: attempt.node.id, attemptId: attempt.attemptId, ordinal: attempt.begun.ordinal });
      const responses = await Promise.all(attempts.map(async (attempt) => {
        const response = runtimeConfig.dispatcher ? await dispatchExternal(attempt.request, runtimeConfig.dispatcher) : await dispatchCodex(attempt.request, { ...runtimeConfig.codex, leaseDir: path.join(runtimeDir, 'leases') });
        const checked = validateDispatchResponse(response); verifyTransportArtifact(attempt.request, checked, runtimeDir); return checked;
      }));
      const after = snapshotWorkspace(workspaceRoot, planDir);
      assertOwnedChanges(before, after, ready.flatMap((node) => node.writeSet));

      for (let index = 0; index < attempts.length; index += 1) {
        const attempt = attempts[index], response = responses[index], verification = [];
        const profileMismatches = [];
        if (response.observedProfile.fast !== null && response.observedProfile.fast !== attempt.request.requestedProfile.fast) profileMismatches.push({ field: 'fast', requested: attempt.request.requestedProfile.fast, observed: response.observedProfile.fast });
        for (const field of ['model', 'reasoning']) {
          const requested = attempt.request.requestedProfile[field], observed = response.observedProfile[field];
          if (requested !== null && observed !== null && observed !== requested) profileMismatches.push({ field, requested, observed });
        }
        const observedTokens = response.usage.reduce((total, record) => total + (record.inputTokens ?? 0) + (record.outputTokens ?? 0), 0);
        const trustworthyUsage = response.usage.length > 0 && response.usage.every((record) => Number.isFinite(record.inputTokens) && record.inputTokens >= 0 && Number.isFinite(record.outputTokens) && record.outputTokens >= 0);
        const usageUnobserved = response.status === 'succeeded' && !trustworthyUsage;
        const admission = { profile: { matches: profileMismatches.length === 0, mismatches: profileMismatches }, tokens: { observed: observedTokens, limit: attempt.node.budgets.tokens, withinLimit: observedTokens <= attempt.node.budgets.tokens }, usage: { observed: trustworthyUsage, recordCount: response.usage.length } };
        let passed = response.status === 'succeeded' && admission.profile.matches && admission.tokens.withinLimit && !usageUnobserved;
        if (passed) {
          const product = path.resolve(workspaceRoot, ...attempt.node.path.split('/'));
          if (!fs.existsSync(product) || fs.readFileSync(product, 'utf8').includes('IMPLEMENTATION_REQUIRED')) passed = false;
        }
        if (passed) {
          for (const command of attempt.node.verificationCommands) {
            const remaining = Math.floor(attempt.node.budgets.wallSeconds * 1000 - (Date.now() - attempt.startedAt));
            if (remaining < 1) { verification.push({ exitCode: 1, timedOut: true }); passed = false; break; }
            const verifyBefore = snapshotWorkspace(workspaceRoot, planDir), result = await runVerifier(command, workspaceRoot, remaining, path.join(runtimeDir, 'leases')), verifyAfter = snapshotWorkspace(workspaceRoot, planDir);
            if (changedPaths(verifyBefore, verifyAfter).length) fail('VERIFIER_WRITE_VIOLATION', { paths: changedPaths(verifyBefore, verifyAfter) });
            verification.push(result); if (result.exitCode !== 0 || result.timedOut) { passed = false; break; }
          }
        }
        const budgetExceeded = !admission.tokens.withinLimit;
        const evidence = { schemaVersion: 1, nodeId: attempt.node.id, attemptId: attempt.attemptId, status: passed ? 'succeeded' : budgetExceeded ? 'budget_exceeded' : usageUnobserved ? 'usage_unobserved' : 'failed', process: response, admission, verification };
        const artifact = writeResult(workspaceRoot, attempt.node, evidence);
        const completed = completeNodeAttempt({ ledgerPath, plan, nodeId: attempt.node.id, attemptId: attempt.attemptId, resultDigest: artifact.digest, outcome: passed ? 'succeeded' : budgetExceeded ? 'budget_exceeded' : usageUnobserved ? 'usage_unobserved' : 'failed' });
        await append(store, runId, 'ATTEMPT_FINISHED', { nodeId: attempt.node.id, attemptId: attempt.attemptId, status: completed.status, resultDigest: artifact.digest, usageDigest: canonicalHash(response.usage) });
      }
    }

    const post = await runGraphify({ config: runtimeConfig.graphify, workspaceRoot, phaseDir: path.join(runtimeDir, `post-${randomUUID()}`), blueprint, policy, phase: 'dependencies', leaseDir: path.join(runtimeDir, 'leases') });
    await append(store, runId, 'DEPENDENCIES_GATED', { graphDigest: post.graphDigest, reportDigest: post.report.reportDigest, matches: post.report.matches });
    if (!post.report.matches) fail('DEPENDENCY_GATE_MISMATCH', { reportDigest: post.report.reportDigest });
    const terminal = { graphDigest: post.graphDigest, reportDigest: post.report.reportDigest };
    const event = await append(store, runId, 'COMPLETE', terminal);
    return Object.freeze({ status: 'COMPLETE', runId, planDigest: plan.planDigest, eventHash: event.eventHash, ...terminal });
  } finally { releaseRunLock(lock); }
}
