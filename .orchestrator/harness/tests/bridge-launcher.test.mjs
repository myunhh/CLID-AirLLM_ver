import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { discoverPython, selectedPythonEnvironment } from '../bridge-launcher.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const launcher = path.join(here, '..', 'bridge-launcher.mjs');
const fake = (name) => path.join(here, 'fixtures', name);
const tempRoot = fs.realpathSync.native(os.tmpdir());
const tempPrefixes = ['ecc-selected-python-', 'ecc-launcher-', 'ecc-launcher-reject-', 'ecc-launcher-admit-', 'ecc-launcher-shim-', 'ecc-contained-', 'ecc-job-probe-'];
const createdRoots = [];

function confinedTemp(candidate) {
  const resolved = path.resolve(candidate);
  const relative = path.relative(tempRoot, resolved);
  assert.equal(relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), true, `unsafe temp path: ${resolved}`);
  return resolved;
}

function cleanupPrefixes() {
  for (const name of fs.readdirSync(tempRoot)) {
    if (!tempPrefixes.some((prefix) => name.startsWith(prefix))) continue;
    const target = confinedTemp(path.join(tempRoot, name));
    if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  }
}

function temporary(prefix) {
  const root = confinedTemp(fs.mkdtempSync(path.join(tempRoot, prefix)));
  createdRoots.push(root);
  return root;
}

function budgetedRequest(root, fixtureName, childId = fixtureName) {
  return {
    runDir: path.join(root, 'run'), runId: `budgeted-${childId}`, workspaceRoot: root,
    capacity: { tokens: 20, toolCalls: 4, wallSeconds: 4, processes: 4 },
    childId, budget: { tokens: 10, toolCalls: 2, wallSeconds: 1, processes: 2 },
    metadata: { kind: 'implementation' }, owns: [], containment: { wall: true, processTree: true },
    runner: { command: process.execPath, args: [fake(fixtureName)] },
  };
}

function invokeBudgeted(root, request, env = process.env) {
  const requestPath = path.join(root, `${request.childId}.request.json`);
  fs.writeFileSync(requestPath, JSON.stringify(request));
  return spawnSync(process.execPath, [launcher, 'run-budgeted', '--request-file', requestPath], { encoding: 'utf8', env });
}

cleanupPrefixes();
after(() => {
  for (const root of createdRoots) if (fs.existsSync(root)) fs.rmSync(confinedTemp(root), { recursive: true, force: true });
  cleanupPrefixes();
  const leftovers = fs.readdirSync(tempRoot).filter((name) => tempPrefixes.some((prefix) => name.startsWith(prefix)));
  assert.deepEqual(leftovers, []);
});

test('interpreter discovery accepts valid fixture and rejects unsupported/missing dependencies', () => {
  assert.equal(discoverPython({ env: { ...process.env, ECC_HARNESS_PYTHON: fake('fake-python-valid.mjs') } }).candidate, fake('fake-python-valid.mjs'));
  assert.throws(() => discoverPython({ env: { ...process.env, ECC_HARNESS_PYTHON: fake('fake-python-wrong-version.mjs') } }), { code: 'PYTHON_VERSION_UNSUPPORTED' });
  assert.throws(() => discoverPython({ env: { ...process.env, ECC_HARNESS_PYTHON: fake('fake-python-missing-dependencies.mjs') } }), { code: 'PYTHON_DEPENDENCY_MISSING' });
  for (const [name, code] of [['fake-python-wrong-version.mjs', 'PYTHON_VERSION_UNSUPPORTED'], ['fake-python-missing-dependencies.mjs', 'PYTHON_DEPENDENCY_MISSING']]) {
    const result = spawnSync(process.execPath, [launcher, 'doctor'], { encoding: 'utf8', env: { ...process.env, ECC_HARNESS_PYTHON: fake(name) } });
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stderr.trim()).error, code);
  }
});

test('run-tests invokes only the launcher-selected interpreter', () => {
  const marker = path.join(temporary('ecc-selected-python-'), 'marker.json');
  const result = spawnSync(process.execPath, [launcher, 'run-tests'], { encoding: 'utf8', env: { ...process.env, ECC_HARNESS_PYTHON: fake('fake-python-valid.mjs'), ECC_FAKE_PYTHON_MARKER: marker } });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(marker), true);
  const args = JSON.parse(fs.readFileSync(marker, 'utf8'));
  assert.equal(path.basename(args[0]), 'kernel_bridge.py');
  assert.equal(args[1], 'run-tests');
});

test('launcher overrides ambient bytecode state and repeated Python/shim runs remain cache-free', () => {
  assert.equal(selectedPythonEnvironment({ PYTHONDONTWRITEBYTECODE: '0' }).PYTHONDONTWRITEBYTECODE, '1');
  const workspace = path.resolve(here, '..', '..', '..');
  const cacheRoots = [path.join(here, '..'), path.join(workspace, '.orchestrator', 'kernel-bridge')];
  const bytecodeArtifacts = () => {
    const found = [];
    for (const searchRoot of cacheRoots) {
      const pending = [searchRoot];
      while (pending.length) {
        const current = pending.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const target = path.join(current, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === '.venv') continue;
            if (entry.name === '__pycache__') found.push(target);
            else pending.push(target);
          } else if (entry.name.endsWith('.pyc')) found.push(target);
        }
      }
    }
    return found;
  };
  assert.deepEqual(bytecodeArtifacts(), []);
  const hostileAmbient = { ...process.env, PYTHONDONTWRITEBYTECODE: '0' };
  for (let iteration = 0; iteration < 2; iteration += 1) {
    const pythonTests = spawnSync(process.execPath, [launcher, 'run-tests'], { encoding: 'utf8', env: hostileAmbient });
    assert.equal(pythonTests.status, 0, pythonTests.stderr);
    const shimTests = spawnSync(process.execPath, [launcher, 'run-shim-tests'], { encoding: 'utf8', env: hostileAmbient });
    assert.equal(shimTests.status, 0, shimTests.stderr);
    assert.deepEqual(bytecodeArtifacts(), []);
  }
});

test('help is static and does not discover or import Jupyter', () => {
  const result = spawnSync(process.execPath, [launcher, '--help'], { encoding: 'utf8', env: { ...process.env, ECC_HARNESS_PYTHON: path.join(os.tmpdir(), 'absent-python') } });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /usage:/u);
  assert.doesNotMatch(fs.readFileSync(path.join(here, '..', 'kernel_bridge.py'), 'utf8').split('def _run_tests')[0], /jupyter/iu);
});

test('public containment probe is live and proves the Windows Job Object contract', () => {
  const result = spawnSync(process.execPath, [launcher, 'probe-containment'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.available, true);
  if (process.platform === 'win32') {
    assert.deepEqual({
      provider: report.provider, createdSuspended: report.createdSuspended,
      assignedBeforeResume: report.assignedBeforeResume, activeProcessLimit: report.activeProcessLimit,
      killOnClose: report.killOnClose,
    }, {
      provider: 'windows_job_object', createdSuspended: true,
      assignedBeforeResume: true, activeProcessLimit: true, killOnClose: true,
    });
  } else {
    assert.equal(report.processGroup, true);
  }
});

test('public run-budgeted executes an in-cap runner and records complete usage', () => {
  const root = temporary('ecc-launcher-budget-success-');
  const request = budgetedRequest(root, 'runner-success.mjs', 'success');
  const result = invokeBudgeted(root, request);
  assert.equal(result.status, 0, result.stderr);
  const reply = JSON.parse(result.stdout.trim());
  assert.equal(reply.launched, true);
  assert.deepEqual(reply.usage, { tokens: 10, toolCalls: 2, wallSeconds: 0, processes: 1 });
  const reservation = JSON.parse(fs.readFileSync(path.join(root, 'run', 'admission.json'))).reservations.success;
  assert.equal(reservation.status, 'released');
  assert.equal(reservation.usageComplete, true);
  assert.equal(reservation.outcome, 'completed');
});

test('public run-budgeted preserves optional content-free provider usage as a sidecar', () => {
  const root = temporary('ecc-launcher-budget-details-');
  const request = budgetedRequest(root, 'runner-success.mjs', 'details');
  request.runner = {
    command: process.execPath,
    args: ['-e', 'console.log(JSON.stringify({tokens:10,toolCalls:2,wallSeconds:0,processes:1,usageDetails:{provider:"codex",inputTokens:10,cachedInputTokens:8,uncachedInputTokens:2,outputTokens:1,requestedFast:true,observedFast:false}}))'],
  };
  const result = invokeBudgeted(root, request);
  assert.equal(result.status, 0, result.stderr);
  const reply = JSON.parse(result.stdout.trim());
  assert.deepEqual(reply.usage, { tokens: 10, toolCalls: 2, wallSeconds: 0, processes: 1 });
  assert.equal(reply.usageDetails.version, 1);
  assert.equal(reply.usageDetails.observedFast, false);
  const reservation = JSON.parse(fs.readFileSync(path.join(root, 'run', 'admission.json'))).reservations.details;
  assert.deepEqual(reservation.usageDetails, reply.usageDetails);
});

test('public run-budgeted returns stable token/tool/wall/process failures and kills every live descendant', async () => {
  const cases = [
    ['runner-token-overrun.mjs', 'tokens'], ['runner-tool-overrun.mjs', 'toolCalls'],
    ['runner-wall-overrun.mjs', 'wallSeconds'], ['runner-process-overrun.mjs', 'processes'],
  ];
  for (const [fixtureName, dimension] of cases) {
    const root = temporary(`ecc-launcher-budget-${dimension}-`);
    const pidFile = path.join(root, 'descendant.pid');
    const request = budgetedRequest(root, fixtureName, `over-${dimension}`);
    request.runner.env = { ECC_DESCENDANT_PID_FILE: pidFile };
    const result = invokeBudgeted(root, request);
    assert.equal(result.status, 1, `${dimension}: ${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stderr.trim()), { ok: false, error: 'BRIDGE_BUDGET_EXCEEDED', dimension });
    assert.equal(fs.existsSync(pidFile), true, `${dimension} did not create its within-cap descendant`);
    const descendantPid = Number(fs.readFileSync(pidFile, 'utf8'));
    for (let tries = 0; tries < 100; tries += 1) {
      try { process.kill(descendantPid, 0); await delay(10); } catch { break; }
    }
    assert.throws(() => process.kill(descendantPid, 0), undefined, `${dimension} descendant ${descendantPid} survived`);
    const reservation = JSON.parse(fs.readFileSync(path.join(root, 'run', 'admission.json'))).reservations[`over-${dimension}`];
    assert.equal(reservation.status, 'released');
    assert.equal(reservation.outcome, `bridge_budget_exceeded(${dimension})`);
  }
});

test('public run-budgeted rejects unavailable containment before untrusted execution and releases reservation', () => {
  const root = temporary('ecc-launcher-budget-unavailable-');
  const marker = path.join(root, 'untrusted.marker');
  const request = budgetedRequest(root, 'runner-success.mjs', 'unavailable');
  request.runner.env = { ECC_RUNNER_MARKER: marker };
  const result = invokeBudgeted(root, request, { ...process.env, ECC_CONTAINMENT_PROBE_FAIL: '1' });
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.stderr.trim()), { ok: false, error: 'CONTAINMENT_UNAVAILABLE' });
  assert.equal(fs.existsSync(marker), false);
  const reservation = JSON.parse(fs.readFileSync(path.join(root, 'run', 'admission.json'))).reservations.unavailable;
  assert.equal(reservation.status, 'released');
  assert.equal(reservation.outcome, 'containment_unavailable');
});

test('public run-budgeted preserves unknown missing usage and strict requests reject before execution', () => {
  const missingRoot = temporary('ecc-launcher-budget-missing-');
  const missing = budgetedRequest(missingRoot, 'runner-missing-usage.mjs', 'missing');
  const missingResult = invokeBudgeted(missingRoot, missing);
  assert.equal(missingResult.status, 1);
  assert.deepEqual(JSON.parse(missingResult.stderr.trim()), { ok: false, error: 'INCOMPLETE_USAGE_EVIDENCE' });
  const reservation = JSON.parse(fs.readFileSync(path.join(missingRoot, 'run', 'admission.json'))).reservations.missing;
  assert.equal(reservation.usageComplete, false);
  assert.deepEqual(reservation.usage, { tokens: 'unknown', toolCalls: 'unknown', wallSeconds: 'unknown', processes: 'unknown' });

  const strictRoot = temporary('ecc-launcher-budget-strict-');
  const marker = path.join(strictRoot, 'strict.marker');
  const strict = budgetedRequest(strictRoot, 'runner-success.mjs', 'strict');
  strict.strictPreConsumption = true;
  strict.runner.env = { ECC_RUNNER_MARKER: marker };
  const strictResult = invokeBudgeted(strictRoot, strict);
  assert.equal(strictResult.status, 1);
  assert.deepEqual(JSON.parse(strictResult.stderr.trim()), { ok: false, error: 'UNSUPPORTED_HARD_BUDGET' });
  assert.equal(fs.existsSync(marker), false);
});

test('launcher broker writes digest/ref-only prompt and reply events through Node', async () => {
  const root = temporary('ecc-launcher-');
  const runDir = path.join(root, 'run');
  fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
  const promptBytes = 'PROMPT_SENTINEL_PRIVATE';
  const replyBytes = 'REPLY_SENTINEL_PRIVATE';
  const crypto = await import('node:crypto');
  for (const [kind, bytes] of [['prompt', promptBytes], ['reply', replyBytes]]) {
    const ref = `artifacts/${kind}.txt`;
    fs.writeFileSync(path.join(runDir, ref), bytes);
    const request = { runDir, event: { runId: 'launcher-test', type: `bridge_${kind}`, producer: 'bridge', authority: 'workflow_assertion', data: { [`${kind}Digest`]: crypto.createHash('sha256').update(bytes).digest('hex'), [`${kind}ArtifactRef`]: ref } } };
    const requestPath = path.join(root, `${kind}.json`);
    fs.writeFileSync(requestPath, JSON.stringify(request));
    const result = spawnSync(process.execPath, [launcher, 'append-event', '--request', requestPath], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
  const serialized = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8') + fs.readFileSync(path.join(runDir, 'checkpoint.json'), 'utf8');
  assert.doesNotMatch(serialized, /PROMPT_SENTINEL_PRIVATE|REPLY_SENTINEL_PRIVATE/u);
  assert.match(serialized, /promptDigest/u);
  assert.match(serialized, /replyDigest/u);
});

test('raw and mismatched Bridge prompt/reply requests reject without appending', () => {
  const root = temporary('ecc-launcher-reject-');
  const runDir = path.join(root, 'run');
  fs.mkdirSync(path.join(runDir, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(runDir, 'artifacts', 'value.txt'), 'exact');
  const cases = [
    ['raw', 'RAW_PROMPT_EVENT_FORBIDDEN', { prompt: 'PRIVATE', promptDigest: '0'.repeat(64), promptArtifactRef: 'artifacts/value.txt' }],
    ['mismatch', 'REPLY_ARTIFACT_DIGEST_MISMATCH', { replyDigest: '0'.repeat(64), replyArtifactRef: 'artifacts/value.txt' }],
  ];
  for (const [name, code, data] of cases) {
    const request = { runDir, event: { runId: 'reject-test', type: name === 'raw' ? 'bridge_prompt' : 'bridge_reply', producer: 'bridge', authority: 'workflow_assertion', data } };
    const requestPath = path.join(root, `${name}.json`);
    fs.writeFileSync(requestPath, JSON.stringify(request));
    const result = spawnSync(process.execPath, [launcher, 'append-event', '--request', requestPath], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(code, 'u'));
    assert.equal(fs.existsSync(path.join(runDir, 'events.jsonl')), false);
    assert.equal(fs.existsSync(path.join(runDir, 'checkpoint.json')), false);
  }
});

test('admit request-file is a deterministic launcher dry run with canonical events and no process', () => {
  const root = temporary('ecc-launcher-admit-');
  const request = {
    runDir: path.join(root, 'run'), runId: 'dry-run', workspaceRoot: root,
    capacity: { tokens: 20, toolCalls: 4, wallSeconds: 10, processes: 2 },
    childId: 'child-1', budget: { tokens: 10, toolCalls: 2, wallSeconds: 5, processes: 1 },
    metadata: { kind: 'read_only_evidence' }, owns: [],
    containment: { wall: true, processTree: true },
  };
  const requestPath = path.join(root, 'request.json');
  fs.writeFileSync(requestPath, JSON.stringify(request));
  const result = spawnSync(process.execPath, [launcher, 'admit', '--request-file', requestPath], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const reply = JSON.parse(result.stdout.trim());
  assert.deepEqual({ dryRun: reply.dryRun, launched: reply.launched, model: reply.routing.model }, { dryRun: true, launched: false, model: 'gpt-5.6-luna' });
  const state = JSON.parse(fs.readFileSync(path.join(root, 'run', 'admission.json')));
  assert.equal(state.reservations['child-1'].status, 'released');
  const events = fs.readFileSync(path.join(root, 'run', 'events.jsonl'), 'utf8').trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => [event.seq, event.type]), [[1, 'bridge_admitted'], [2, 'bridge_reservation_released']]);

  request.childId = 'child-over';
  request.budget.tokens = 21;
  fs.writeFileSync(requestPath, JSON.stringify(request));
  const rejected = spawnSync(process.execPath, [launcher, 'admit', '--request-file', requestPath], { encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  assert.deepEqual(JSON.parse(rejected.stderr.trim()), { ok: false, error: 'BUDGET_ADMISSION_EXCEEDED', dimension: 'tokens' });
});

function shimFixture() {
  const fixtureRoot = temporary('ecc-launcher-shim-');
  const legacy = path.join(fixtureRoot, '.orchestrator', 'kernel-bridge');
  fs.mkdirSync(legacy, { recursive: true });
  const originals = new Map([
    ['kernel_bridge.py', Buffer.from('ORIGINAL_KERNEL_FIXTURE\n')],
    ['verify_events.py', Buffer.from('ORIGINAL_VERIFIER_FIXTURE\n')],
  ]);
  const shims = [];
  for (const [name, bytes] of originals) {
    const target = path.join(legacy, name);
    const backup = `${target}.pre-harness-v2`;
    fs.writeFileSync(target, 'BROKEN_INSTALLED_FIXTURE\n');
    fs.writeFileSync(backup, bytes);
    shims.push({
      name,
      targetPath: `.orchestrator/kernel-bridge/${name}`,
      backupPath: `.orchestrator/kernel-bridge/${name}.pre-harness-v2`,
      byteLength: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      shimSha256: crypto.createHash('sha256').update('BROKEN_INSTALLED_FIXTURE\n').digest('hex'),
    });
  }
  fs.writeFileSync(path.join(legacy, 'shim-cutover-manifest.json'), `${JSON.stringify({ version: 1, phase: 'installed', shims }, null, 2)}\n`);
  return { fixtureRoot, legacy, originals };
}

test('run-shim-tests invokes both live installed shims and preserves installed state', () => {
  const workspace = path.resolve(here, '..', '..', '..');
  const manifestPath = path.join(workspace, '.orchestrator', 'kernel-bridge', 'shim-cutover-manifest.json');
  const before = fs.readFileSync(manifestPath);
  const result = spawnSync(process.execPath, [launcher, 'run-shim-tests'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1));
  assert.deepEqual({ kernel: report.kernel, verifier: report.verifier, exitForwarding: report.exitForwarding }, { kernel: true, verifier: true, exitForwarding: true });
  assert.deepEqual(fs.readFileSync(manifestPath), before);
  const manifest = JSON.parse(before);
  assert.equal(manifest.phase, 'installed');
  for (const entry of manifest.shims) {
    const target = path.join(workspace, entry.targetPath);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'), entry.shimSha256);
  }
});

test('run-shim-tests failure restores exact fixture bytes before exit 1', () => {
  const fixtureState = shimFixture();
  const result = spawnSync(process.execPath, [launcher, 'run-shim-tests'], {
    encoding: 'utf8',
    env: { ...process.env, ECC_SHIM_CUTOVER_ROOT: fixtureState.fixtureRoot, ECC_SHIM_LAUNCHER_TEST_INJECT_FAILURE: '1' },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SHIM_TEST_INJECTED_FAILURE/u);
  for (const [name, bytes] of fixtureState.originals) assert.deepEqual(fs.readFileSync(path.join(fixtureState.legacy, name)), bytes);
});

test('run-shim-tests restore failure exits 3 with recovery-required evidence', () => {
  const fixtureState = shimFixture();
  fs.rmSync(path.join(fixtureState.legacy, 'verify_events.py.pre-harness-v2'));
  const result = spawnSync(process.execPath, [launcher, 'run-shim-tests'], {
    encoding: 'utf8',
    env: { ...process.env, ECC_SHIM_CUTOVER_ROOT: fixtureState.fixtureRoot, ECC_SHIM_LAUNCHER_TEST_INJECT_FAILURE: '1' },
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /SHIM_RECOVERY_REQUIRED/u);
});
