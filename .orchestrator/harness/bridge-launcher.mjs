#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EventStore } from './lib/event-store.mjs';
import { AdmissionLedger, DIMENSIONS } from './lib/admission.mjs';
import { createUsageRecord } from './lib/usage-ledger.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const bridge = path.join(root, 'kernel_bridge.py');
const PROBE = 'import importlib.util,json,sys;print(json.dumps({"version":list(sys.version_info[:3]),"missingDependencies":[n for n in ["json"] if importlib.util.find_spec(n) is None]}))';

export function selectedPythonEnvironment(env = process.env) {
  return { ...env, PYTHONDONTWRITEBYTECODE: '1' };
}

function invocation(candidate, args) {
  if (candidate.endsWith('.mjs')) return { command: process.execPath, args: [candidate, ...args] };
  const parts = candidate === 'py -3' ? ['py', '-3'] : [candidate];
  return { command: parts[0], args: [...parts.slice(1), ...args] };
}

function candidates(env = process.env) {
  const result = [];
  if (env.ECC_HARNESS_PYTHON) result.push(env.ECC_HARNESS_PYTHON);
  result.push(path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'));
  if (process.platform === 'win32') result.push('py -3');
  result.push('python3', 'python');
  return [...new Set(result)];
}

export function discoverPython(options = {}) {
  const env = selectedPythonEnvironment(options.env ?? process.env);
  let specificFailure;
  for (const candidate of candidates(env)) {
    const call = invocation(candidate, ['-c', PROBE]);
    const result = spawnSync(call.command, call.args, { encoding: 'utf8', windowsHide: true, timeout: 10_000, env });
    if (result.error || result.status !== 0) continue;
    let report;
    try { report = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1)); } catch { continue; }
    if (!Array.isArray(report.version) || report.version[0] !== 3 || report.version[1] < 10) {
      specificFailure ??= { code: 'PYTHON_VERSION_UNSUPPORTED', candidate };
      if (env.ECC_HARNESS_PYTHON) break;
      continue;
    }
    if (Array.isArray(report.missingDependencies) && report.missingDependencies.length > 0) {
      specificFailure ??= { code: 'PYTHON_DEPENDENCY_MISSING', candidate, missing: report.missingDependencies };
      if (env.ECC_HARNESS_PYTHON) break;
      continue;
    }
    return { candidate, version: report.version, command: call.command, prefix: invocation(candidate, []).args };
  }
  const error = new Error(specificFailure?.code ?? 'PYTHON_NOT_FOUND');
  error.code = specificFailure?.code ?? 'PYTHON_NOT_FOUND';
  error.details = specificFailure;
  throw error;
}

function launchPython(args, env = process.env) {
  const pythonEnv = selectedPythonEnvironment(env);
  const selected = discoverPython({ env: pythonEnv });
  return spawnSync(selected.command, [...selected.prefix, bridge, ...args], { stdio: 'inherit', windowsHide: true, env: pythonEnv });
}

function shimWorkspace(env = process.env) {
  return path.resolve(env.ECC_SHIM_CUTOVER_ROOT ?? path.join(root, '..', '..'));
}

function invokeSelectedPython(selected, entry, args, env) {
  return spawnSync(selected.command, [...selected.prefix, entry, ...args], { encoding: 'utf8', windowsHide: true, env: selectedPythonEnvironment(env) });
}

function shimFailure(code) {
  return Object.assign(new Error(code), { code });
}

function assertShimResult(result, expectedStatus, outputPattern) {
  if (result.error || result.status !== expectedStatus || (outputPattern && !outputPattern.test(result.stdout ?? ''))) {
    throw shimFailure('SHIM_DELEGATION_OR_EXIT_FORWARDING_FAILED');
  }
}

function restoreShims(workspace, env) {
  const cutover = path.join(root, 'shim-cutover.mjs');
  const restored = spawnSync(process.execPath, [cutover, 'restore'], {
    encoding: 'utf8', windowsHide: true, env: { ...env, ECC_SHIM_CUTOVER_ROOT: workspace },
  });
  return restored.status === 0 && !restored.error;
}

function runShimTests(env = process.env) {
  const workspace = shimWorkspace(env);
  try {
    if (env.ECC_SHIM_LAUNCHER_TEST_INJECT_FAILURE === '1') throw shimFailure('SHIM_TEST_INJECTED_FAILURE');
    const selected = discoverPython({ env });
    const legacy = path.join(workspace, '.orchestrator', 'kernel-bridge');
    const kernel = path.join(legacy, 'kernel_bridge.py');
    const verifier = path.join(legacy, 'verify_events.py');
    assertShimResult(invokeSelectedPython(selected, kernel, ['--help'], env), 0, /usage:/iu);
    assertShimResult(invokeSelectedPython(selected, verifier, ['--help'], env), 0, /Usage: verify-events/u);
    assertShimResult(invokeSelectedPython(selected, kernel, ['invalid-command'], env), 2);
    assertShimResult(invokeSelectedPython(selected, verifier, [path.join(legacy, 'missing.events.jsonl')], env), 1);
    console.log(JSON.stringify({ ok: true, interpreter: selected.candidate, kernel: true, verifier: true, exitForwarding: true }));
    return 0;
  } catch (error) {
    if (!restoreShims(workspace, env)) {
      console.error('SHIM_RECOVERY_REQUIRED');
      return 3;
    }
    console.error(error.code ?? 'SHIM_LAUNCHER_TEST_FAILED');
    return 1;
  }
}

function value(args, name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

async function appendEvent(args) {
  const requestPath = value(args, '--request');
  if (!requestPath) throw Object.assign(new Error('REQUEST_MISSING'), { code: 'REQUEST_MISSING' });
  const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
  const store = new EventStore({ runDir: request.runDir, runId: request.event?.runId });
  const event = await store.append(request.event);
  process.stdout.write(`${JSON.stringify({ seq: event.seq, eventHash: event.eventHash })}\n`);
}

async function dryRunAdmission(args) {
  const requestPath = value(args, '--request-file');
  if (!requestPath) throw Object.assign(new Error('REQUEST_FILE_MISSING'), { code: 'REQUEST_FILE_MISSING' });
  const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
  const ledger = new AdmissionLedger({
    runDir: request.runDir,
    runId: request.runId,
    capacity: request.capacity,
    workspaceRoot: request.workspaceRoot,
  });
  const admission = await ledger.reserve({
    childId: request.childId,
    budget: request.budget,
    metadata: request.metadata,
    userModel: request.userModel,
    owns: request.owns ?? [],
    strictPreConsumption: request.strictPreConsumption ?? false,
    containment: request.containment,
  });
  const zeroUsage = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, 0]));
  await ledger.release(request.childId, zeroUsage, 'dry_run');
  console.log(JSON.stringify({ ok: true, dryRun: true, childId: request.childId, budget: admission.budget, routing: admission.routing, launched: false }));
}

function completeUsage(stdout) {
  try {
    const value = JSON.parse(stdout.trim().split(/\r?\n/u).at(-1));
    if (!value || typeof value !== 'object' || DIMENSIONS.some((dimension) => !Number.isFinite(value[dimension]) || value[dimension] < 0)) return undefined;
    return {
      usage: Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, value[dimension]])),
      usageDetails: value.usageDetails === undefined ? undefined : createUsageRecord(value.usageDetails),
    };
  } catch { return undefined; }
}

function containmentInvocation(requestPath, env = process.env) {
  const selected = discoverPython({ env });
  return spawnSync(selected.command, [...selected.prefix, bridge, 'run-contained', '--request', requestPath], {
    encoding: 'utf8', windowsHide: true, env: selectedPythonEnvironment(env), maxBuffer: 16 * 1024 * 1024,
  });
}

async function runBudgeted(args) {
  const requestPath = value(args, '--request-file');
  if (!requestPath) throw Object.assign(new Error('REQUEST_FILE_MISSING'), { code: 'REQUEST_FILE_MISSING' });
  const request = JSON.parse(fs.readFileSync(requestPath, 'utf8'));
  const ledger = new AdmissionLedger({
    runDir: request.runDir, runId: request.runId, capacity: request.capacity, workspaceRoot: request.workspaceRoot,
  });
  const admission = await ledger.reserve({
    childId: request.childId, budget: request.budget, metadata: request.metadata,
    userModel: request.userModel, owns: request.owns ?? [],
    strictPreConsumption: request.strictPreConsumption ?? false,
    containment: request.containment,
  });
  const zeroUsage = Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, 0]));
  let invocationResult;
  try {
    invocationResult = containmentInvocation(requestPath);
  } catch (error) {
    await ledger.release(request.childId, zeroUsage, 'containment_unavailable');
    throw error;
  }
  let report;
  try { report = JSON.parse(invocationResult.stdout.trim().split(/\r?\n/u).at(-1)); } catch {
    await ledger.release(request.childId, zeroUsage, 'containment_unavailable');
    throw Object.assign(new Error('CONTAINMENT_UNAVAILABLE'), { code: 'CONTAINMENT_UNAVAILABLE' });
  }
  if (invocationResult.error || invocationResult.status !== 0 || report.containmentAvailable !== true) {
    await ledger.release(request.childId, zeroUsage, 'containment_unavailable');
    throw Object.assign(new Error('CONTAINMENT_UNAVAILABLE'), { code: 'CONTAINMENT_UNAVAILABLE', containment: report.capability ?? report });
  }
  if (report.launched !== true) {
    await ledger.release(request.childId, zeroUsage, 'launch_failed');
    throw Object.assign(new Error('RUNNER_LAUNCH_FAILED'), { code: 'RUNNER_LAUNCH_FAILED' });
  }
  const completedUsage = completeUsage(report.stdout ?? '');
  if (!completedUsage) {
    if (report.wallExceeded === true) {
      await ledger.releaseWallTimeout(request.childId, admission.budget.wallSeconds + 1);
      throw Object.assign(new Error('BRIDGE_BUDGET_EXCEEDED'), { code: 'BRIDGE_BUDGET_EXCEEDED', dimension: 'wallSeconds' });
    }
    await ledger.releaseIncomplete(request.childId);
    throw Object.assign(new Error('INCOMPLETE_USAGE_EVIDENCE'), { code: 'INCOMPLETE_USAGE_EVIDENCE' });
  }
  const { usage, usageDetails } = completedUsage;
  if (report.wallExceeded === true) usage.wallSeconds = Math.max(usage.wallSeconds, admission.budget.wallSeconds + 1);
  const exceeded = report.observedOverrun ?? DIMENSIONS.find((dimension) => usage[dimension] > admission.budget[dimension]);
  if (exceeded) {
    await ledger.release(request.childId, usage, `bridge_budget_exceeded(${exceeded})`, usageDetails);
    throw Object.assign(new Error('BRIDGE_BUDGET_EXCEEDED'), { code: 'BRIDGE_BUDGET_EXCEEDED', dimension: exceeded });
  }
  const outcome = report.exitCode === 0 ? 'completed' : 'runner_failed';
  await ledger.release(request.childId, usage, outcome, usageDetails);
  if (report.exitCode !== 0) throw Object.assign(new Error('RUNNER_FAILED'), { code: 'RUNNER_FAILED' });
  console.log(JSON.stringify({ ok: true, childId: request.childId, usage, ...(usageDetails === undefined ? {} : { usageDetails }), routing: admission.routing, containment: report.capability, provider: report.provider, launched: true }));
}

function probeContainment(env = process.env) {
  const selected = discoverPython({ env });
  const result = spawnSync(selected.command, [...selected.prefix, bridge, 'probe-containment'], {
    encoding: 'utf8', windowsHide: true, env: selectedPythonEnvironment(env),
  });
  if (result.error || result.status !== 0) throw Object.assign(new Error('CONTAINMENT_UNAVAILABLE'), { code: 'CONTAINMENT_UNAVAILABLE' });
  const report = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1));
  if (report.available !== true) throw Object.assign(new Error('CONTAINMENT_UNAVAILABLE'), { code: 'CONTAINMENT_UNAVAILABLE' });
  console.log(JSON.stringify(report));
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0] ?? '--help';
  if (command === '--help' || command === '-h' || command === 'help') {
    console.log('usage: bridge-launcher.mjs <doctor|probe-containment|run-budgeted|run-tests|run-shim-tests|python|append-event|admit>');
    return 0;
  }
  if (command === 'doctor') {
    const selected = discoverPython();
    console.log(JSON.stringify({ ok: true, interpreter: selected.candidate, version: selected.version }));
    return 0;
  }
  if (command === 'probe-containment') { probeContainment(); return 0; }
  if (command === 'run-budgeted') { await runBudgeted(argv.slice(1)); return 0; }
  if (command === 'run-tests') return launchPython(['run-tests']).status ?? 2;
  if (command === 'run-shim-tests') return runShimTests();
  if (command === 'python') return launchPython(argv.slice(1)).status ?? 2;
  if (command === 'append-event') { await appendEvent(argv.slice(1)); return 0; }
  if (command === 'admit') { await dryRunAdmission(argv.slice(1)); return 0; }
  throw Object.assign(new Error('COMMAND_INVALID'), { code: 'COMMAND_INVALID' });
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.code ?? error.message, dimension: error.dimension }));
    process.exitCode = ['PYTHON_VERSION_UNSUPPORTED', 'PYTHON_DEPENDENCY_MISSING', 'PYTHON_NOT_FOUND'].includes(error.code) ? 2 : 1;
  });
}
