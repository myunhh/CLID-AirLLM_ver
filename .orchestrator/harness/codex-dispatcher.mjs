#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Bytes } from './lib/canonical-json.mjs';
import { parseCodexUsageJsonl } from './lib/providers/codex-usage.mjs';
import { runSupervisedProcess } from './lib/process-supervisor.mjs';

const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

export class CodexDispatcherError extends Error {
  constructor(code, details = {}) { super(code); this.name = 'CodexDispatcherError'; this.code = code; this.details = details; }
}

function fail(code, details) { throw new CodexDispatcherError(code, details); }
function validRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || request.schemaVersion !== 1) return false;
  const strings = ['planDigest', 'nodeId', 'attemptId', 'workspaceRoot', 'capsuleDir', 'compiledCommand', 'transportArtifactPath'];
  return strings.every((key) => typeof request[key] === 'string' && request[key].length > 0)
    && request.sandbox === 'workspace-write' && typeof request.fast === 'boolean'
    && request.budget && Number.isFinite(request.budget.wallSeconds)
    && request.requestedProfile && typeof request.requestedProfile.reasoning === 'string';
}

export async function dispatchCodex(request, config = {}) {
  if (!validRequest(request)) fail('DISPATCH_REQUEST_INVALID');
  const executable = config.executable ?? 'codex';
  const prefix = config.args ?? [];
  if (typeof executable !== 'string' || !executable || !Array.isArray(prefix) || !prefix.every((item) => typeof item === 'string')) fail('DISPATCH_CONFIG_INVALID');
  const args = [...prefix, 'exec', '--ephemeral', '--json', '--skip-git-repo-check', '-s', 'workspace-write', '-C', request.workspaceRoot];
  if (request.requestedProfile.model !== null) args.push('--model', request.requestedProfile.model);
  if (request.requestedProfile.reasoning) args.push('-c', `model_reasoning_effort=${JSON.stringify(request.requestedProfile.reasoning)}`);
  const leaseDir = config.leaseDir ?? path.join(path.dirname(path.dirname(request.transportArtifactPath)), 'leases');
  let result;
  try { result = await runSupervisedProcess(executable, args, { cwd: request.workspaceRoot, input: request.compiledCommand, timeoutMs: Math.max(1, Math.floor(request.budget.wallSeconds * 1000)), maxCaptureBytes: MAX_CAPTURE_BYTES, leaseDir }); }
  catch (error) { fail('DISPATCH_SUPERVISOR_FAILED', { cause: error.code }); }
  if (result.outputTooLarge) fail('DISPATCH_OUTPUT_TOO_LARGE');
  if (result.launchError) fail('DISPATCH_LAUNCH_FAILED', { cause: result.launchError });
  fs.mkdirSync(path.dirname(request.transportArtifactPath), { recursive: true });
  fs.writeFileSync(request.transportArtifactPath, result.stdout, { flag: 'wx', mode: 0o600 });
  let normalized = { records: [], anomalies: [] };
  if (result.stdout.length) {
    try { normalized = parseCodexUsageJsonl(result.stdout.toString('utf8')); }
    catch { if (!result.timedOut && result.exitCode === 0) fail('DISPATCH_RESPONSE_INVALID'); }
  }
  const last = normalized.records.at(-1) ?? {};
  return Object.freeze({
    schemaVersion: 1,
    status: result.timedOut ? 'timeout' : result.exitCode === 0 ? 'succeeded' : 'failed',
    exitCode: result.exitCode,
    usage: [...normalized.records],
    observedProfile: { model: last.observedModel ?? null, reasoning: null, fast: last.observedFast ?? null },
    transportDigest: sha256Bytes(result.stdout),
  });
}

async function main() {
  let request;
  try { request = JSON.parse(await new Promise((resolve) => { let value = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', (chunk) => { value += chunk; }); process.stdin.on('end', () => resolve(value)); })); }
  catch { fail('DISPATCH_REQUEST_INVALID'); }
  const config = process.env.CODEX_DISPATCHER_CONFIG ? JSON.parse(process.env.CODEX_DISPATCHER_CONFIG) : {};
  process.stdout.write(`${JSON.stringify(await dispatchCodex(request, config))}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { process.stderr.write(`${JSON.stringify({ error: { code: error.code ?? 'INTERNAL_ERROR', details: error.details } })}\n`); process.exitCode = 1; });
}
