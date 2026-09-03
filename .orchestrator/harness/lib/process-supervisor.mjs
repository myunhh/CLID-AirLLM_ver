import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from './canonical-json.mjs';
import { terminateProcessTree } from './admission.mjs';
import { discoverPython, selectedPythonEnvironment } from '../bridge-launcher.mjs';

const SELF = fileURLToPath(import.meta.url);
const BRIDGE = fileURLToPath(new URL('../kernel_bridge.py', import.meta.url));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let cachedPython;
const containmentPython = () => cachedPython ??= discoverPython();
const captureFiles = (leaseFile) => [`${leaseFile}.capture-stdout`, `${leaseFile}.capture-stderr`];
const captureHeader = (nonce, stream) => Buffer.from(`${canonicalJson({ kind: 'scaffold-supervisor-capture', nonce, schemaVersion: 1, stream })}\n`);
function reserveCaptureFiles(leaseFile, nonce) {
  const files = captureFiles(leaseFile);
  try {
    for (const [index, file] of files.entries()) {
      const descriptor = fs.openSync(file, 'wx', 0o600);
      try { fs.writeFileSync(descriptor, captureHeader(nonce, index === 0 ? 'stdout' : 'stderr')); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    }
  } catch (error) {
    for (const [index, file] of files.entries()) {
      if (!fs.existsSync(file)) continue;
      const expected = captureHeader(nonce, index === 0 ? 'stdout' : 'stderr');
      try { if (fs.readFileSync(file).subarray(0, expected.length).equals(expected)) fs.unlinkSync(file); } catch {}
    }
    fail('SUPERVISOR_CAPTURE_RESERVATION_FAILED', { cause: error.code });
  }
}
async function cleanupCaptureFiles(leaseFile, nonce, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  const files = captureFiles(leaseFile);
  for (const [index, file] of files.entries()) {
    if (!fs.existsSync(file)) continue;
    const expected = captureHeader(nonce, index === 0 ? 'stdout' : 'stderr');
    let actual; try { actual = fs.readFileSync(file).subarray(0, expected.length); } catch (error) { fail('SUPERVISOR_CAPTURE_OWNERSHIP_UNCERTAIN', { file, cause: error.code }); }
    if (!actual.equals(expected)) fail('SUPERVISOR_CAPTURE_OWNERSHIP_INVALID', { file });
  }
  for (const file of files) {
    while (fs.existsSync(file)) {
      try { fs.unlinkSync(file); break; }
      catch (error) { if (Date.now() >= deadline) fail('SUPERVISOR_CAPTURE_CLEANUP_FAILED', { file, cause: error.code }); await delay(20); }
    }
  }
}

export class ProcessSupervisorError extends Error {
  constructor(code, details = {}) { super(code); this.name = 'ProcessSupervisorError'; this.code = code; this.details = details; }
}
const fail = (code, details) => { throw new ProcessSupervisorError(code, details); };

function durableJson(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, `${canonicalJson(value)}\n`); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, file);
}
function exactLease(value) {
  const keys = ['schemaVersion', 'nonce', 'supervisorPid', 'targetPid', 'status', 'outcome'];
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every((key) => keys.includes(key))
    && value.schemaVersion === 1 && typeof value.nonce === 'string' && value.nonce.length > 0
    && Number.isSafeInteger(value.supervisorPid) && value.supervisorPid > 0
    && (value.targetPid === null || Number.isSafeInteger(value.targetPid) && value.targetPid > 0)
    && ['reserved', 'preparing', 'active', 'settled'].includes(value.status)
    && (value.status === 'settled' ? typeof value.outcome === 'string' : value.outcome === null);
}
function readLease(file) { let value; try { value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail('SUPERVISOR_LEASE_UNCERTAIN', { file }); } if (!exactLease(value)) fail('SUPERVISOR_LEASE_UNCERTAIN', { file }); return value; }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } }

export async function fenceActiveLeases(leaseDir, timeoutMs = 5000) {
  if (!fs.existsSync(leaseDir)) return;
  const files = fs.readdirSync(leaseDir).filter((name) => name.endsWith('.json')).map((name) => path.join(leaseDir, name)).sort();
  for (const file of files) {
    let lease = readLease(file);
    if (lease.status === 'settled') { await cleanupCaptureFiles(file, lease.nonce); try { fs.unlinkSync(`${file}.request`); } catch (error) { if (error.code !== 'ENOENT') fail('SUPERVISOR_LEASE_UNCERTAIN', { file }); } continue; }
    if (!alive(lease.supervisorPid)) {
      await delay(20); lease = readLease(file);
      if (lease.status === 'settled') { await cleanupCaptureFiles(file, lease.nonce); continue; }
      if (alive(lease.supervisorPid) || lease.targetPid !== null && alive(lease.targetPid)) fail('SUPERVISOR_LEASE_UNCERTAIN', { file });
      await cleanupCaptureFiles(file, lease.nonce); durableJson(file, { ...lease, status: 'settled', outcome: 'process_tree_gone' });
      try { fs.unlinkSync(`${file}.request`); } catch (error) { if (error.code !== 'ENOENT') fail('SUPERVISOR_LEASE_UNCERTAIN', { file }); }
      continue;
    }
    const stopFile = `${file}.stop`;
    if (fs.existsSync(stopFile)) {
      let stop; try { stop = JSON.parse(fs.readFileSync(stopFile, 'utf8')); } catch { fail('SUPERVISOR_LEASE_UNCERTAIN', { file }); }
      if (stop?.nonce !== lease.nonce) fail('SUPERVISOR_LEASE_UNCERTAIN', { file });
    } else durableJson(stopFile, { nonce: lease.nonce });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await delay(20); lease = readLease(file);
      if (lease.status === 'settled') break;
      if (!alive(lease.supervisorPid)) {
        await delay(20); lease = readLease(file);
        if (lease.status === 'settled') break;
        if (alive(lease.supervisorPid) || lease.targetPid !== null && alive(lease.targetPid)) fail('SUPERVISOR_LEASE_UNCERTAIN', { file });
        durableJson(file, { ...lease, status: 'settled', outcome: 'process_tree_gone' }); lease = readLease(file); break;
      }
    }
    if (lease.status !== 'settled') fail('SUPERVISOR_FENCE_TIMEOUT', { file });
    await cleanupCaptureFiles(file, lease.nonce);
    try { fs.unlinkSync(`${file}.request`); } catch (error) { if (error.code !== 'ENOENT') fail('SUPERVISOR_LEASE_UNCERTAIN', { file }); }
  }
}

export function runSupervisedProcess(executable, args, { cwd, input = '', timeoutMs, maxCaptureBytes, leaseDir, launchDelayMs = 0 }) {
  if (typeof leaseDir !== 'string' || !leaseDir) return Promise.reject(new ProcessSupervisorError('SUPERVISOR_LEASE_DIR_REQUIRED'));
  fs.mkdirSync(leaseDir, { recursive: true });
  const leaseFile = path.join(leaseDir, `${randomUUID()}.json`), resultFile = `${leaseFile}.result`, nonce = randomUUID();
  let python;
  try { const selected = containmentPython(); python = { command: selected.command, prefix: selected.prefix }; }
  catch (error) { return Promise.reject(new ProcessSupervisorError('SUPERVISOR_CONTAINMENT_UNAVAILABLE', { cause: error.code })); }
  const request = { executable, args, cwd, input: Buffer.from(input).toString('base64'), timeoutMs, maxCaptureBytes, launchDelayMs, python };
  return new Promise((resolve, reject) => {
    const supervisor = spawn(process.execPath, [SELF, '--run', leaseFile, nonce, resultFile], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    let done = false, poll, deadline;
    const finish = (error, result) => {
      if (done) return; done = true; clearInterval(poll); clearTimeout(deadline); supervisor.stdio[3]?.destroy();
      if (!error) { resolve({ ...result, stdout: Buffer.from(result.stdout, 'base64'), stderr: Buffer.from(result.stderr, 'base64') }); return; }
      (async () => {
        const graceDeadline = Date.now() + 5000;
        while (Date.now() < graceDeadline) {
          try { if (fs.existsSync(leaseFile) && readLease(leaseFile).status === 'settled') break; } catch {}
          if (!alive(supervisor.pid)) break;
          await delay(20);
        }
        if (alive(supervisor.pid)) try { supervisor.kill('SIGKILL'); } catch {}
        reject(error);
      })();
    };
    supervisor.once('error', (error) => finish(new ProcessSupervisorError('SUPERVISOR_LAUNCH_FAILED', { cause: error.code })));
    supervisor.once('close', (code) => { if (!fs.existsSync(resultFile)) finish(new ProcessSupervisorError('SUPERVISOR_FAILED', { exitCode: code })); });
    poll = setInterval(() => {
      if (!fs.existsSync(resultFile)) return;
      let result; try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch { finish(new ProcessSupervisorError('SUPERVISOR_RESPONSE_INVALID')); return; }
      finish(null, result);
    }, 10);
    deadline = setTimeout(() => finish(new ProcessSupervisorError('SUPERVISOR_RESPONSE_TIMEOUT')), timeoutMs + launchDelayMs + 10_000);
    if (!supervisor.pid) { finish(new ProcessSupervisorError('SUPERVISOR_LAUNCH_FAILED')); return; }
    try { durableJson(leaseFile, { schemaVersion: 1, nonce, supervisorPid: supervisor.pid, targetPid: null, status: 'reserved', outcome: null }); }
    catch { finish(new ProcessSupervisorError('SUPERVISOR_LEASE_RESERVATION_FAILED')); return; }
    supervisor.stdin.end(`${canonicalJson(request)}\n`);
  });
}

async function supervise() {
  const leaseFile = process.argv[3], nonce = process.argv[4], resultFile = process.argv[5];
  let parentDead = false, settled = false, child = null, stopWatchdog;
  const requestContainedStop = () => {
    try { if (!fs.existsSync(`${leaseFile}.stop`)) durableJson(`${leaseFile}.stop`, { nonce }); } catch {}
    if (child && !stopWatchdog) stopWatchdog = setTimeout(() => terminateProcessTree(child), 5000);
  };
  const parentChannel = fs.createReadStream('', { fd: 3, autoClose: true });
  const parentGone = () => {
    parentDead = true;
    if (!settled && child) requestContainedStop();
  };
  parentChannel.on('end', parentGone); parentChannel.on('close', parentGone); parentChannel.on('error', parentGone); parentChannel.resume();

  let reserved = null;
  const reservationDeadline = Date.now() + 5000;
  while (!parentDead && Date.now() < reservationDeadline) {
    if (fs.existsSync(leaseFile)) {
      reserved = readLease(leaseFile);
      if (reserved.nonce !== nonce || reserved.supervisorPid !== process.pid || reserved.status !== 'reserved') fail('SUPERVISOR_LEASE_UNCERTAIN', { file: leaseFile });
      break;
    }
    await delay(5);
  }
  if (!reserved) { parentChannel.destroy(); process.exit(parentDead ? 0 : 1); return; }
  const preparing = { ...reserved, status: 'preparing' };
  const settleWithoutTarget = (outcome) => durableJson(leaseFile, { ...preparing, status: 'settled', outcome });
  if (parentDead) { settleWithoutTarget('parent_dead'); parentChannel.destroy(); process.exit(0); return; }

  let input = ''; process.stdin.setEncoding('utf8');
  try { for await (const chunk of process.stdin) input += chunk; }
  catch { settleWithoutTarget(parentDead ? 'parent_dead' : 'preparing_failed'); parentChannel.destroy(); process.exit(parentDead ? 0 : 1); return; }
  let request;
  try { request = JSON.parse(input); }
  catch { settleWithoutTarget(parentDead ? 'parent_dead' : 'preparing_failed'); parentChannel.destroy(); process.exit(parentDead ? 0 : 1); return; }
  durableJson(leaseFile, preparing);
  const stopRequested = () => {
    const stopFile = `${leaseFile}.stop`;
    if (!fs.existsSync(stopFile)) return false;
    try { return JSON.parse(fs.readFileSync(stopFile, 'utf8'))?.nonce === nonce; } catch { return false; }
  };
  const launchAt = Date.now() + (Number.isFinite(request.launchDelayMs) && request.launchDelayMs > 0 ? request.launchDelayMs : 0);
  while (!parentDead && !stopRequested() && Date.now() < launchAt) await delay(Math.min(20, launchAt - Date.now()));
  if (parentDead || stopRequested()) {
    settleWithoutTarget(parentDead ? 'parent_dead' : 'fenced'); parentChannel.destroy(); process.exit(0); return;
  }
  const current = readLease(leaseFile);
  if (current.nonce !== nonce || current.supervisorPid !== process.pid || current.status !== 'preparing') fail('SUPERVISOR_LEASE_UNCERTAIN', { file: leaseFile });
  const containedRequest = `${leaseFile}.request`;
  try {
    if (typeof request.python?.command !== 'string' || !Array.isArray(request.python.prefix) || request.python.prefix.some((item) => typeof item !== 'string')) fail('SUPERVISOR_CONTAINMENT_UNAVAILABLE');
    reserveCaptureFiles(leaseFile, nonce);
    durableJson(containedRequest, {
      runner: { command: request.executable, args: request.args, cwd: request.cwd },
      stdinBase64: request.input,
      maxCaptureBytes: request.maxCaptureBytes,
      control: { supervisorPid: process.pid, stopFile: `${leaseFile}.stop`, nonce, stdoutPath: `${leaseFile}.capture-stdout`, stderrPath: `${leaseFile}.capture-stderr` },
      budget: { tokens: Number.MAX_SAFE_INTEGER, toolCalls: Number.MAX_SAFE_INTEGER, wallSeconds: Math.max(1, Math.ceil(request.timeoutMs / 1000) + 1), processes: 64 },
    });
    child = spawn(request.python.command, [...request.python.prefix, BRIDGE, 'run-contained', '--request', containedRequest, '--skip-probe'], {
      cwd: request.cwd, env: selectedPythonEnvironment(), shell: false, windowsHide: true,
      detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    try { fs.unlinkSync(containedRequest); } catch {}
    try { await cleanupCaptureFiles(leaseFile, nonce); } catch {}
    settleWithoutTarget('launch_failed'); parentChannel.destroy();
    if (!parentDead) durableJson(resultFile, { exitCode: 1, signal: null, launchError: error.code, timedOut: false, outputTooLarge: false, stdout: '', stderr: '' });
    process.exit(parentDead ? 0 : 1); return;
  }
  if (child.pid) durableJson(leaseFile, { ...preparing, targetPid: child.pid, status: 'active' });
  let captured = 0, timedOut = false, fenced = false, outputTooLarge = false;
  const stdout = [], stderr = [];
  const stop = (reason) => {
    if (settled) return;
    if (reason === 'timeout') timedOut = true; if (reason === 'parent_dead') parentDead = true; if (reason === 'fenced') fenced = true; if (reason === 'output_cap') outputTooLarge = true;
    const stopFile = `${leaseFile}.stop`;
    requestContainedStop();
  };
  const collect = (target) => (chunk) => { captured += chunk.length; target.push(chunk); if (captured > request.maxCaptureBytes + 65_536) stop('output_cap'); };
  child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
  if (parentDead) stop('parent_dead');
  const timer = setTimeout(() => stop('timeout'), request.timeoutMs);
  const poll = setInterval(() => {
    const stopFile = `${leaseFile}.stop`;
    if (!fs.existsSync(stopFile)) return;
    try { const value = JSON.parse(fs.readFileSync(stopFile, 'utf8')); if (value.nonce === nonce) stop('fenced'); } catch {}
  }, 20);
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolve({ exitCode: Number.isInteger(exitCode) ? exitCode : 1, signal }));
  }).catch((error) => ({ exitCode: 1, signal: null, launchError: error.code }));
  terminateProcessTree(child);
  settled = true; clearTimeout(timer); clearTimeout(stopWatchdog); clearInterval(poll); parentChannel.destroy();
  await cleanupCaptureFiles(leaseFile, nonce);
  try { fs.unlinkSync(containedRequest); } catch (error) { if (error.code !== 'ENOENT') result.launchError = 'CONTAINED_REQUEST_CLEANUP_FAILED'; }
  if (!timedOut && !outputTooLarge && !result.launchError) {
    try {
      const report = JSON.parse(Buffer.concat(stdout).toString('utf8').trim().split(/\r?\n/u).at(-1));
      if (report.containmentAvailable !== true || report.launched !== true || !Number.isInteger(report.exitCode)) result.launchError = report.launchError ?? 'CONTAINMENT_UNAVAILABLE';
      else {
        result.exitCode = report.exitCode; result.signal = null;
        stdout.splice(0, stdout.length, Buffer.from(report.stdout ?? '', 'utf8'));
        stderr.splice(0, stderr.length, Buffer.from(report.stderr ?? '', 'utf8'));
        if (report.wallExceeded === true) timedOut = true;
        if (report.outputExceeded === true) outputTooLarge = true;
      }
    } catch { result.launchError = 'CONTAINMENT_RESPONSE_INVALID'; }
  }
  const outcome = parentDead ? 'parent_dead' : fenced ? 'fenced' : timedOut ? 'timeout' : outputTooLarge ? 'output_cap' : result.launchError ? 'launch_failed' : 'exited';
  durableJson(leaseFile, { ...preparing, targetPid: child.pid ?? null, status: 'settled', outcome });
  if (parentDead) { process.exit(0); return; }
  durableJson(resultFile, { ...result, timedOut, outputTooLarge, stdout: Buffer.concat(stdout).toString('base64'), stderr: Buffer.concat(stderr).toString('base64') });
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF && process.argv[2] === '--run') supervise().catch(() => { process.exitCode = 1; });
