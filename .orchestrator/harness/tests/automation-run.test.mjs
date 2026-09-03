import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runScaffoldAutomation, validateRuntimeConfig, AutomationError } from '../lib/automation-run.mjs';
import { dispatchCodex } from '../codex-dispatcher.mjs';
import { blueprintDigest, policyDigest, deriveReviewQuorum, createGateAttestation, compilePlan } from '../lib/blueprint-scaffold.mjs';
import { fenceActiveLeases, runSupervisedProcess } from '../lib/process-supervisor.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'fixtures', 'fake-scaffold-tool.mjs');
const CLI = path.join(HERE, '..', 'scaffold-pipeline.mjs');
const budget = { tokens: 100, toolCalls: 2, wallSeconds: 8, processes: 1 };
const digest = (value) => createHash('sha256').update(value).digest('hex');
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'automation-run-'));
const readLog = (file) => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const containedTempNames = () => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('ecc-contained-stdout-') || name.startsWith('ecc-contained-stderr-')).sort();
const errorCode = (code) => (error) => (error instanceof AutomationError || typeof error?.code === 'string') && error.code === code;
function firstResultEvidence(input, targetPath) {
  const plan = JSON.parse(fs.readFileSync(path.join(input.planDir, 'plan.json'), 'utf8'));
  const node = targetPath === undefined ? plan.nodes[0] : plan.nodes.find((item) => item.path === targetPath);
  return JSON.parse(fs.readFileSync(path.join(input.workspaceRoot, ...node.resultArtifactRef.split('/')), 'utf8'));
}

function fixture(fileSpecs, controlOverrides = {}, names = {}) {
  const root = temp(), workspaceRoot = path.join(root, names.workspace ?? 'work & $(no-shell)'), findingsRoot = path.join(root, 'findings'), planDir = path.join(root, names.plan ?? 'plan ; safe');
  const controlFile = path.join(root, 'control $().json'), logFile = path.join(root, 'invocations &.jsonl');
  fs.mkdirSync(workspaceRoot, { recursive: true }); fs.mkdirSync(findingsRoot);
  for (const skillPath of fileSpecs.flatMap((spec) => spec.skillPaths ?? [])) { const target = path.join(workspaceRoot, ...skillPath.split('/')); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, `# ${skillPath}\n`); }
  const policy = { schemaVersion: 1, policyVersion: 'policy-1', classification: 'M', ambiguitySignals: [], standardApprovals: 2, elevatedApprovals: 2, maxRetryCap: 2, reservedRoots: ['.git'] };
  const files = fileSpecs.map((spec) => ({
    path: spec.path, dependsOn: spec.dependsOn ?? [], builderId: 'builder-a', retryCap: spec.retryCap ?? 0, budget,
    contract: { purpose: `implement ${spec.path}`, exports: ['implemented'], acceptance: [`${spec.path} passes`] }, instructions: `implement ${spec.path}`,
    stub: '/* IMPLEMENTATION_REQUIRED */\nexport const implemented = false;\n',
    ...(spec.noVerifier ? {} : { verificationCommands: [{ command: process.execPath, args: [FAKE, 'verify', controlFile, logFile, spec.path] }] }),
    ...(spec.skillPaths ? { skillPaths: spec.skillPaths } : {}),
  }));
  const blueprint = { schemaVersion: 1, blueprintId: 'demo', classification: 'M', ambiguitySignals: [], builders: ['builder-a'], judges: ['judge-a', 'judge-b'], defaultBudget: budget, graphPolicy: { directed: true, edgeDirection: 'source-depends-on-target' }, files };
  const quorum = deriveReviewQuorum(policy), receipts = ['judge-a', 'judge-b'].map((judgeId, index) => {
    const ref = `finding-${index}.md`, bytes = `finding ${judgeId}\n`; fs.writeFileSync(path.join(findingsRoot, ref), bytes);
    return { schemaVersion: 1, blueprintDigest: blueprintDigest(blueprint, policy), policyDigest: policyDigest(policy), quorumDigest: quorum.quorumDigest, judgeId, nonce: `nonce-${index}`, outcome: 'approve', findingsArtifactRef: ref, findingsDigest: digest(bytes) };
  });
  const gate = createGateAttestation({ blueprint, policy, receipts, findingsRoot });
  fs.writeFileSync(controlFile, JSON.stringify({ files: fileSpecs.map(({ path: filePath, dependsOn = [] }) => ({ path: filePath, dependsOn })), ...controlOverrides }));
  const runtimeConfig = { graphify: { executable: process.execPath, args: [FAKE, 'graphify', controlFile, logFile], timeoutMs: 3000 }, dispatcher: { executable: process.execPath, args: [FAKE, 'dispatch', controlFile, logFile] }, model: 'fixture-model', reasoning: 'low' };
  return { root, workspaceRoot, findingsRoot, planDir, controlFile, logFile, blueprint, policy, receipts, gate, runtimeConfig };
}

async function crashSameWaveDuringLaterVerifier(input) {
  const preview = compilePlan(input), earlier = preview.nodes[0].path, later = preview.nodes[1].path;
  const control = JSON.parse(fs.readFileSync(input.controlFile, 'utf8')); control.verificationDelays = { [later]: 1000 }; fs.writeFileSync(input.controlFile, JSON.stringify(control));
  const files = { blueprint: path.join(input.root, 'blueprint.json'), policy: path.join(input.root, 'policy.json'), bundle: path.join(input.root, 'bundle.json'), runtime: path.join(input.root, 'runtime.json') };
  fs.writeFileSync(files.blueprint, JSON.stringify(input.blueprint)); fs.writeFileSync(files.policy, JSON.stringify(input.policy)); fs.writeFileSync(files.bundle, JSON.stringify({ gate: input.gate, receipts: input.receipts, findingsRoot: input.findingsRoot })); fs.writeFileSync(files.runtime, JSON.stringify(input.runtimeConfig));
  const child = spawn(process.execPath, [CLI, 'orchestrate', files.blueprint, files.policy, files.bundle, input.workspaceRoot, input.planDir, '--runtime-config', files.runtime], { stdio: 'ignore', windowsHide: true });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !readLog(input.logFile).some((entry) => entry.tool === 'verify' && entry.target === later)) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(readLog(input.logFile).some((entry) => entry.tool === 'verify' && entry.target === later), true);
  const firstResult = preview.nodes.find((node) => node.path === earlier).resultArtifactRef;
  assert.equal(fs.existsSync(path.join(input.workspaceRoot, ...firstResult.split('/'))), true);
  child.kill('SIGKILL'); await new Promise((resolve) => child.once('close', resolve)); await new Promise((resolve) => setTimeout(resolve, 1200));
  return { preview, earlier, later, firstResult };
}

test('wide ready waves run concurrently, dependents wait, and default mode stays ordinary', async () => {
  const input = fixture([
    { path: 'src/a.mjs' }, { path: 'src/b.mjs' }, { path: 'src/c.mjs' },
    { path: 'src/d.mjs', dependsOn: ['src/a.mjs', 'src/b.mjs', 'src/c.mjs'] },
  ], { delays: { 'src/a.mjs': 500, 'src/b.mjs': 500, 'src/c.mjs': 500 } });
  const result = await runScaffoldAutomation(input);
  assert.equal(result.status, 'COMPLETE');
  const log = readLog(input.logFile), starts = log.filter((entry) => entry.tool === 'dispatch-start'), ends = log.filter((entry) => entry.tool === 'dispatch-end');
  assert.deepEqual(starts.slice(0, 3).map((entry) => entry.target).sort(), ['src/a.mjs', 'src/b.mjs', 'src/c.mjs']);
  assert.equal(Math.max(...starts.slice(0, 3).map((entry) => entry.started)) <= Math.min(...ends.filter((entry) => ['src/a.mjs', 'src/b.mjs', 'src/c.mjs'].includes(entry.target)).map((entry) => entry.ended)), true);
  assert.equal(starts.find((entry) => entry.target === 'src/d.mjs').started >= Math.max(...ends.filter((entry) => ['src/a.mjs', 'src/b.mjs', 'src/c.mjs'].includes(entry.target)).map((entry) => entry.ended)), true);
  assert.equal(starts.every((entry) => entry.fast === false && entry.fastDirectives === 0), true);
  const graphCalls = log.filter((entry) => entry.tool === 'graphify');
  assert.equal(graphCalls.length, 2);
  assert.deepEqual(graphCalls[0].argv.slice(0, 6), ['extract', input.workspaceRoot, '--code-only', '--no-cluster', '--force', '--out']);
  const rawGraph = JSON.parse(fs.readFileSync(path.join(graphCalls[1].argv.at(-1), 'graphify-out', 'graph.json'), 'utf8'));
  assert.deepEqual(Object.keys(rawGraph).sort(), ['edges', 'hyperedges', 'input_tokens', 'nodes', 'output_tokens']);
  assert.equal(Number.isFinite(rawGraph.input_tokens) && rawGraph.input_tokens >= 0, true);
  assert.equal(Number.isFinite(rawGraph.output_tokens) && rawGraph.output_tokens >= 0, true);
  assert.deepEqual([...new Set(rawGraph.edges.map((edge) => edge.relation))].sort(), ['contains', 'imports', 'imports_from']);
});

test('structural mismatch fails before any dispatcher launch', async () => {
  const input = fixture([{ path: 'src/a.mjs' }], { structureMismatch: true });
  await assert.rejects(runScaffoldAutomation(input), errorCode('STRUCTURE_GATE_MISMATCH'));
  assert.equal(readLog(input.logFile).some((entry) => entry.tool.startsWith('dispatch')), false);
});

test('Graphify nonzero and malformed output both fail before dispatcher launch', async (t) => {
  for (const [name, control, code] of [['nonzero', { graphifyExit: 9 }, 'GRAPHIFY_FAILED'], ['malformed', { graphifyMalformed: true }, 'GRAPHIFY_OUTPUT_INVALID']]) {
    await t.test(name, async () => {
      const input = fixture([{ path: 'src/a.mjs' }], control);
      await assert.rejects(runScaffoldAutomation(input), errorCode(code));
      assert.equal(readLog(input.logFile).some((entry) => entry.tool.startsWith('dispatch')), false);
    });
  }
});

test('explicit fast is the sole acceleration opt-in and runtime config cannot enable it', async () => {
  assert.throws(() => validateRuntimeConfig({ fast: true }), errorCode('RUNTIME_CONFIG_INVALID'));
  const input = fixture([{ path: 'src/a.mjs' }]);
  assert.equal((await runScaffoldAutomation({ ...input, fast: true })).status, 'COMPLETE');
  const start = readLog(input.logFile).find((entry) => entry.tool === 'dispatch-start');
  assert.equal(start.fast, true); assert.equal(start.fastDirectives, 1);
});

test('worker and verifier writes outside the authorized surface fail closed', async (t) => {
  await t.test('worker write', async () => {
    const input = fixture([{ path: 'src/a.mjs' }], { unownedWrite: 'outside.txt' });
    await assert.rejects(runScaffoldAutomation(input), errorCode('WORKSPACE_WRITE_VIOLATION'));
    assert.equal(readLog(input.logFile).some((entry) => entry.tool === 'verify'), false);
  });
  await t.test('verifier write', async () => {
    const input = fixture([{ path: 'src/a.mjs' }], { verifierWrite: 'verifier-write.txt' });
    await assert.rejects(runScaffoldAutomation(input), errorCode('VERIFIER_WRITE_VIOLATION'));
    assert.equal(readLog(input.logFile).filter((entry) => entry.tool === 'graphify').length, 1);
  });
});

test('failed verification retries within cap and receives prior evidence', async () => {
  const input = fixture([{ path: 'src/a.mjs', retryCap: 1 }], { failVerificationOnce: 'src/a.mjs' });
  assert.equal((await runScaffoldAutomation(input)).status, 'COMPLETE');
  const starts = readLog(input.logFile).filter((entry) => entry.tool === 'dispatch-start');
  assert.equal(starts.length, 2); assert.equal(starts[0].previous, null); assert.equal(typeof starts[1].previous, 'string'); assert.equal(starts[1].previous.includes('/results/'), true);
  assert.equal(starts.every((entry) => entry.contractReadSeen), true); assert.equal(starts[1].priorEvidenceReadSeen, true);
});

test('retry exhaustion escalates and never reaches the post graph gate', async () => {
  const input = fixture([{ path: 'src/a.mjs', retryCap: 1 }], { failVerificationAlways: 'src/a.mjs' });
  await assert.rejects(runScaffoldAutomation(input), errorCode('ATTEMPTS_EXHAUSTED'));
  assert.equal(readLog(input.logFile).filter((entry) => entry.tool === 'dispatch-start').length, 2);
  assert.equal(readLog(input.logFile).filter((entry) => entry.tool === 'graphify').length, 1);
});

test('nodes without a verifier are rejected before Graphify or dispatch', async () => {
  const input = fixture([{ path: 'src/a.mjs', noVerifier: true }]);
  await assert.rejects(runScaffoldAutomation(input), errorCode('VERIFIER_REQUIRED'));
  assert.equal(readLog(input.logFile).length, 0);
});

test('forged succeeded attempt ledger is plan-validated and cannot bypass dispatch', async () => {
  const input = fixture([{ path: 'src/a.mjs' }], { badTransportDigest: true });
  await assert.rejects(runScaffoldAutomation(input), errorCode('DISPATCH_TRANSPORT_INVALID'));
  const plan = JSON.parse(fs.readFileSync(path.join(input.planDir, 'plan.json'), 'utf8')), node = plan.nodes[0], ledger = path.join(input.planDir, 'runtime', 'attempt-ledger.json');
  fs.writeFileSync(ledger, JSON.stringify({ schemaVersion: 1, planDigest: plan.planDigest, nodes: { [node.id]: { retryCap: node.retryCap, status: 'SUCCEEDED', attempts: [] } } }));
  const control = JSON.parse(fs.readFileSync(input.controlFile, 'utf8')); control.badTransportDigest = false; fs.writeFileSync(input.controlFile, JSON.stringify(control));
  await assert.rejects(runScaffoldAutomation(input), errorCode('ATTEMPT_LEDGER_INVALID'));
  assert.equal(readLog(input.logFile).filter((entry) => entry.tool === 'dispatch-start').length, 1);
  assert.equal(readLog(input.logFile).some((entry) => entry.tool === 'verify'), false);
});

test('observed execution-profile contradictions fail before verifier while null remains evidentiary', async (t) => {
  for (const [name, control, field] of [
    ['standard-fast', { observedFast: true }, 'fast'],
    ['model', { observedModel: 'other-model' }, 'model'],
    ['reasoning', { observedReasoning: 'high' }, 'reasoning'],
  ]) {
    await t.test(name, async () => {
      const input = fixture([{ path: 'src/a.mjs' }], control);
      await assert.rejects(runScaffoldAutomation(input), errorCode('ATTEMPTS_EXHAUSTED'));
      assert.equal(readLog(input.logFile).some((entry) => entry.tool === 'verify'), false);
      const evidence = firstResultEvidence(input);
      assert.equal(evidence.admission.profile.matches, false); assert.equal(evidence.admission.profile.mismatches[0].field, field);
    });
  }
  await t.test('null-observed', async () => {
    const input = fixture([{ path: 'src/a.mjs' }]);
    assert.equal((await runScaffoldAutomation(input)).status, 'COMPLETE');
    const evidence = firstResultEvidence(input);
    assert.deepEqual(evidence.process.observedProfile, { fast: null, model: null, reasoning: null }); assert.equal(evidence.admission.profile.matches, true);
  });
  await t.test('requested-fast-observed-false', async () => {
    const input = fixture([{ path: 'src/a.mjs' }], { observedFast: false });
    await assert.rejects(runScaffoldAutomation({ ...input, fast: true }), errorCode('ATTEMPTS_EXHAUSTED'));
    const evidence = firstResultEvidence(input);
    assert.deepEqual(evidence.admission.profile.mismatches, [{ field: 'fast', observed: false, requested: true }]);
    const log = readLog(input.logFile);
    assert.equal(log.some((entry) => entry.tool === 'verify'), false); assert.equal(log.filter((entry) => entry.tool === 'graphify').length, 1);
  });
});

test('summed normalized token usage over budget fails before verifier with bounded evidence', async () => {
  const input = fixture([{ path: 'src/a.mjs' }], { usageRecords: [{ inputTokens: 40, outputTokens: 20 }, { inputTokens: 30, outputTokens: 11 }] });
  await assert.rejects(runScaffoldAutomation(input), errorCode('ATTEMPTS_EXHAUSTED'));
  assert.equal(readLog(input.logFile).some((entry) => entry.tool === 'verify'), false);
  const evidence = firstResultEvidence(input, 'src/a.mjs');
  assert.deepEqual(evidence.admission.tokens, { limit: 100, observed: 101, withinLimit: false });
});

test('token budget overage is terminal despite retry capacity and remains terminal on resume', async () => {
  const input = fixture([{ path: 'src/a.mjs', retryCap: 2 }, { path: 'src/b.mjs', dependsOn: ['src/a.mjs'] }], { usageRecords: [{ inputTokens: 60, outputTokens: 41 }] });
  await assert.rejects(runScaffoldAutomation(input), errorCode('ATTEMPTS_EXHAUSTED'));
  await assert.rejects(runScaffoldAutomation(input), errorCode('ATTEMPTS_EXHAUSTED'));
  const starts = readLog(input.logFile).filter((entry) => entry.tool === 'dispatch-start');
  assert.equal(starts.length, 1); assert.equal(starts[0].target, 'src/a.mjs');
  assert.equal(readLog(input.logFile).some((entry) => entry.tool === 'verify'), false);
  const evidence = firstResultEvidence(input, 'src/a.mjs');
  assert.equal(evidence.status, 'budget_exceeded'); assert.deepEqual(evidence.admission.tokens, { limit: 100, observed: 101, withinLimit: false });
  const plan = JSON.parse(fs.readFileSync(path.join(input.planDir, 'plan.json'), 'utf8')), ledger = JSON.parse(fs.readFileSync(path.join(input.planDir, 'runtime', 'attempt-ledger.json'), 'utf8'));
  assert.equal(ledger.nodes[plan.nodes.find((node) => node.path === 'src/a.mjs').id].status, 'ESCALATED');
});

test('succeeded response without usage is terminal and remains terminal on resume', async () => {
  const input = fixture([{ path: 'src/a.mjs', retryCap: 2 }, { path: 'src/b.mjs', dependsOn: ['src/a.mjs'] }], { emptyUsage: true });
  await assert.rejects(runScaffoldAutomation(input), errorCode('ATTEMPTS_EXHAUSTED'));
  await assert.rejects(runScaffoldAutomation(input), errorCode('ATTEMPTS_EXHAUSTED'));
  const starts = readLog(input.logFile).filter((entry) => entry.tool === 'dispatch-start');
  assert.equal(starts.length, 1); assert.equal(starts[0].target, 'src/a.mjs'); assert.equal(readLog(input.logFile).some((entry) => entry.tool === 'verify'), false);
  const plan = JSON.parse(fs.readFileSync(path.join(input.planDir, 'plan.json'), 'utf8')), node = plan.nodes.find((item) => item.path === 'src/a.mjs'), ledger = JSON.parse(fs.readFileSync(path.join(input.planDir, 'runtime', 'attempt-ledger.json'), 'utf8'));
  assert.equal(ledger.nodes[node.id].status, 'ESCALATED'); assert.equal(ledger.nodes[node.id].attempts[0].failureReason, 'usage_unobserved');
});

test('metadata-only usage record is terminal usage_unobserved before verifier', async () => {
  const input = fixture([{ path: 'src/a.mjs', retryCap: 1 }], { usageRecords: [{ requestedModel: 'fixture-model' }] });
  await assert.rejects(runScaffoldAutomation(input), errorCode('ATTEMPTS_EXHAUSTED'));
  await assert.rejects(runScaffoldAutomation(input), errorCode('ATTEMPTS_EXHAUSTED'));
  const plan = JSON.parse(fs.readFileSync(path.join(input.planDir, 'plan.json'), 'utf8')), ledger = JSON.parse(fs.readFileSync(path.join(input.planDir, 'runtime', 'attempt-ledger.json'), 'utf8'));
  assert.equal(ledger.nodes[plan.nodes[0].id].attempts[0].failureReason, 'usage_unobserved');
  assert.equal(readLog(input.logFile).filter((entry) => entry.tool === 'dispatch-start').length, 1); assert.equal(readLog(input.logFile).some((entry) => entry.tool === 'verify'), false);
});

test('automated plan directory must resolve outside the workspace before mutation', async (t) => {
  const input = fixture([{ path: 'src/a.mjs' }]), inside = path.join(input.workspaceRoot, 'missing', 'plan');
  await assert.rejects(runScaffoldAutomation({ ...input, planDir: inside }), errorCode('PLAN_DIRECTORY_INSIDE_WORKSPACE'));
  assert.equal(fs.existsSync(inside), false); assert.equal(readLog(input.logFile).length, 0);
  const alias = path.join(input.root, 'alias-to-workspace');
  try { fs.symlinkSync(input.workspaceRoot, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.diagnostic(`symlink case unavailable: ${error.code}`); return; } throw error; }
  await assert.rejects(runScaffoldAutomation({ ...input, planDir: path.join(alias, 'nested-plan') }), errorCode('PLAN_DIRECTORY_INSIDE_WORKSPACE'));
  assert.equal(fs.existsSync(path.join(input.workspaceRoot, 'nested-plan')), false);
});

test('only gate-bound skill paths are included in the worker prompt', async () => {
  const selected = '.agents/skills/selected/SKILL.md', forbidden = '.agents/skills/not-selected/SKILL.md';
  const input = fixture([{ path: 'src/a.mjs', skillPaths: [selected] }], { expectedSkill: selected, forbiddenSkill: forbidden });
  const selectedTarget = path.join(input.workspaceRoot, ...selected.split('/')), forbiddenTarget = path.join(input.workspaceRoot, ...forbidden.split('/')); fs.mkdirSync(path.dirname(forbiddenTarget), { recursive: true }); fs.writeFileSync(forbiddenTarget, '# forbidden\n');
  const control = JSON.parse(fs.readFileSync(input.controlFile, 'utf8')); control.expectedSkill = selectedTarget; control.forbiddenSkill = forbiddenTarget; fs.writeFileSync(input.controlFile, JSON.stringify(control));
  assert.equal((await runScaffoldAutomation(input)).status, 'COMPLETE');
  const start = readLog(input.logFile).find((entry) => entry.tool === 'dispatch-start');
  assert.equal(start.selectedSkillSeen, true); assert.equal(start.forbiddenSkillSeen, false);
});

test('invalid selected skill fails command preflight before wave or attempt state', async () => {
  const input = fixture([{ path: 'src/a.mjs', skillPaths: ['.git/invalid/SKILL.md'] }]);
  await assert.rejects(runScaffoldAutomation(input), errorCode('READ_FORBIDDEN'));
  assert.equal(fs.existsSync(path.join(input.planDir, 'runtime', 'attempt-ledger.json')), false);
  const events = fs.readFileSync(path.join(input.planDir, 'runtime', 'events.jsonl'), 'utf8');
  assert.equal(events.includes('"type":"WAVE_STARTED"'), false); assert.equal(readLog(input.logFile).some((entry) => entry.tool === 'dispatch-start'), false);
});

test('post dependency mismatch prevents terminal COMPLETE', async () => {
  const input = fixture([{ path: 'src/a.mjs' }, { path: 'src/b.mjs', dependsOn: ['src/a.mjs'] }], { dependencyMismatch: true });
  await assert.rejects(runScaffoldAutomation(input), errorCode('DEPENDENCY_GATE_MISMATCH'));
  const events = fs.readFileSync(path.join(input.planDir, 'runtime', 'events.jsonl'), 'utf8');
  assert.equal(events.includes('"type":"COMPLETE"'), false);
});

test('interrupted wave audits its persisted snapshot and resumes without rerunning successful dependencies', { timeout: 15000 }, async () => {
  const input = fixture([{ path: 'src/a.mjs' }, { path: 'src/b.mjs', dependsOn: ['src/a.mjs'], retryCap: 1 }], { delays: { 'src/b.mjs': 800 } });
  const files = { blueprint: path.join(input.root, 'blueprint.json'), policy: path.join(input.root, 'policy.json'), bundle: path.join(input.root, 'bundle.json'), runtime: path.join(input.root, 'runtime.json') };
  fs.writeFileSync(files.blueprint, JSON.stringify(input.blueprint)); fs.writeFileSync(files.policy, JSON.stringify(input.policy));
  fs.writeFileSync(files.bundle, JSON.stringify({ gate: input.gate, receipts: input.receipts, findingsRoot: input.findingsRoot })); fs.writeFileSync(files.runtime, JSON.stringify(input.runtimeConfig));
  const child = spawn(process.execPath, [CLI, 'orchestrate', files.blueprint, files.policy, files.bundle, input.workspaceRoot, input.planDir, '--runtime-config', files.runtime], { stdio: 'ignore', windowsHide: true });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !readLog(input.logFile).some((entry) => entry.tool === 'dispatch-start' && entry.target === 'src/b.mjs')) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(readLog(input.logFile).some((entry) => entry.tool === 'dispatch-start' && entry.target === 'src/b.mjs'), true);
  child.kill('SIGKILL'); await new Promise((resolve) => child.once('close', resolve)); await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal((await runScaffoldAutomation(input)).status, 'COMPLETE');
  const starts = readLog(input.logFile).filter((entry) => entry.tool === 'dispatch-start');
  assert.equal(starts.filter((entry) => entry.target === 'src/a.mjs').length, 1);
  assert.equal(starts.filter((entry) => entry.target === 'src/b.mjs').length, 2);
  const waves = fs.readFileSync(path.join(input.planDir, 'runtime', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map(JSON.parse).filter((event) => event.type === 'WAVE_STARTED');
  assert.equal(waves.every((wave) => Array.isArray(wave.data.snapshotRecords)), true); assert.deepEqual(waves[0].data.allowedPaths, ['src/a.mjs']);
});

test('same-wave resume permits sibling result evidence and its new directory ancestors', { timeout: 15000 }, async () => {
  const input = fixture([{ path: 'src/a.mjs', retryCap: 1 }, { path: 'src/b.mjs', retryCap: 1 }]);
  const { earlier, later } = await crashSameWaveDuringLaterVerifier(input);
  assert.equal((await runScaffoldAutomation(input)).status, 'COMPLETE');
  const starts = readLog(input.logFile).filter((entry) => entry.tool === 'dispatch-start');
  assert.equal(starts.filter((entry) => entry.target === earlier).length, 1); assert.equal(starts.filter((entry) => entry.target === later).length, 2);
  assert.equal(starts.findLast((entry) => entry.target === later).priorEvidenceReadSeen, true);
});

test('same-wave resume rejects tampered terminal sibling result evidence', { timeout: 15000 }, async () => {
  const input = fixture([{ path: 'src/a.mjs', retryCap: 1 }, { path: 'src/b.mjs', retryCap: 1 }]);
  const { firstResult } = await crashSameWaveDuringLaterVerifier(input);
  fs.writeFileSync(path.join(input.workspaceRoot, ...firstResult.split('/')), 'tampered\n');
  await assert.rejects(runScaffoldAutomation(input), errorCode('RESULT_ARTIFACT_DIGEST_MISMATCH'));
  assert.equal(readLog(input.logFile).filter((entry) => entry.tool === 'dispatch-start').length, 2);
});

test('immediate resume fences a live orphan verifier before retry and late write', { timeout: 15000 }, async () => {
  const input = fixture([{ path: 'src/a.mjs', retryCap: 1 }]), sentinel = path.join(input.root, 'old-verifier-late-write.txt');
  const control = JSON.parse(fs.readFileSync(input.controlFile, 'utf8')); control.verificationDelayedWriteOnce = { target: 'src/a.mjs', delayMs: 800, sentinel }; fs.writeFileSync(input.controlFile, JSON.stringify(control));
  const files = { blueprint: path.join(input.root, 'blueprint.json'), policy: path.join(input.root, 'policy.json'), bundle: path.join(input.root, 'bundle.json'), runtime: path.join(input.root, 'runtime.json') };
  fs.writeFileSync(files.blueprint, JSON.stringify(input.blueprint)); fs.writeFileSync(files.policy, JSON.stringify(input.policy)); fs.writeFileSync(files.bundle, JSON.stringify({ gate: input.gate, receipts: input.receipts, findingsRoot: input.findingsRoot })); fs.writeFileSync(files.runtime, JSON.stringify(input.runtimeConfig));
  const child = spawn(process.execPath, [CLI, 'orchestrate', files.blueprint, files.policy, files.bundle, input.workspaceRoot, input.planDir, '--runtime-config', files.runtime], { stdio: 'ignore', windowsHide: true });
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline && !readLog(input.logFile).some((entry) => entry.tool === 'verify')) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(readLog(input.logFile).some((entry) => entry.tool === 'verify'), true);
  child.kill('SIGKILL'); await new Promise((resolve) => child.once('close', resolve));
  assert.equal((await runScaffoldAutomation(input)).status, 'COMPLETE');
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(fs.existsSync(sentinel), false);
  const log = readLog(input.logFile); assert.equal(log.filter((entry) => entry.tool === 'dispatch-start').length, 2); assert.equal(log.filter((entry) => entry.tool === 'verify').length, 2);
  const leases = fs.readdirSync(path.join(input.planDir, 'runtime', 'leases')).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(fs.readFileSync(path.join(input.planDir, 'runtime', 'leases', name), 'utf8')));
  assert.equal(leases.every((lease) => lease.status === 'settled'), true);
});

test('parent death during reserved launch delay fences before target launch', { timeout: 10000 }, async () => {
  const root = temp(), leaseDir = path.join(root, 'leases'), sentinel = path.join(root, 'target-launched.txt');
  const supervisorUrl = pathToFileURL(path.join(HERE, '..', 'lib', 'process-supervisor.mjs')).href;
  const target = `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'launched')`;
  const helperSource = `import { runSupervisedProcess } from ${JSON.stringify(supervisorUrl)}; await runSupervisedProcess(process.execPath, ['-e', ${JSON.stringify(target)}], { cwd: ${JSON.stringify(root)}, timeoutMs: 5000, maxCaptureBytes: 1024, leaseDir: ${JSON.stringify(leaseDir)}, launchDelayMs: 1500 });`;
  const helper = spawn(process.execPath, ['--input-type=module', '-e', helperSource], { stdio: 'ignore', windowsHide: true });
  const deadline = Date.now() + 5000;
  let leaseFile;
  while (Date.now() < deadline) {
    leaseFile = fs.existsSync(leaseDir) ? fs.readdirSync(leaseDir).find((name) => name.endsWith('.json')) : undefined;
    if (leaseFile) {
      const lease = JSON.parse(fs.readFileSync(path.join(leaseDir, leaseFile), 'utf8'));
      if (lease.status === 'reserved' || lease.status === 'preparing') break;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(leaseFile, 'parent must durably reserve the lease before sending the launch request');
  helper.kill('SIGKILL'); await new Promise((resolve) => helper.once('close', resolve));
  await fenceActiveLeases(leaseDir, 5000);
  await new Promise((resolve) => setTimeout(resolve, 1600));
  assert.equal(fs.existsSync(sentinel), false);
  const lease = JSON.parse(fs.readFileSync(path.join(leaseDir, leaseFile), 'utf8'));
  assert.equal(lease.status, 'settled');
  assert.ok(['parent_dead', 'fenced', 'process_tree_gone'].includes(lease.outcome));
});

test('parent death while active kills a detached descendant before its delayed write', { timeout: 12000 }, async () => {
  const root = temp(), leaseDir = path.join(root, 'leases'), ready = path.join(root, 'root-ready.txt'), sentinel = path.join(root, 'orphan-write.txt');
  const tempBefore = containedTempNames();
  const supervisorUrl = pathToFileURL(path.join(HERE, '..', 'lib', 'process-supervisor.mjs')).href;
  const descendant = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'late'),1200)`;
  const target = `const {spawn}=require('node:child_process'),fs=require('node:fs');const p=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:'ignore'});p.unref();fs.writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>{},5000)`;
  const helperSource = `import { runSupervisedProcess } from ${JSON.stringify(supervisorUrl)}; await runSupervisedProcess(process.execPath, ['-e', ${JSON.stringify(target)}], { cwd: ${JSON.stringify(root)}, timeoutMs: 7000, maxCaptureBytes: 4096, leaseDir: ${JSON.stringify(leaseDir)} });`;
  const helper = spawn(process.execPath, ['--input-type=module', '-e', helperSource], { stdio: 'ignore', windowsHide: true });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !fs.existsSync(ready)) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fs.existsSync(ready), true);
  helper.kill('SIGKILL'); await new Promise((resolve) => helper.once('close', resolve));
  await fenceActiveLeases(leaseDir, 7000);
  await new Promise((resolve) => setTimeout(resolve, 1400));
  assert.equal(fs.existsSync(sentinel), false);
  const leases = fs.readdirSync(leaseDir).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(fs.readFileSync(path.join(leaseDir, name), 'utf8')));
  assert.equal(leases.every((lease) => lease.status === 'settled'), true);
  assert.equal(fs.readdirSync(leaseDir).some((name) => name.includes('.capture-')), false);
  assert.deepEqual(containedTempNames(), tempBefore);
});

test('lease fencing preserves foreign or tampered capture bytes and fails closed', async (t) => {
  for (const variant of ['foreign', 'wrong-nonce']) await t.test(variant, async () => {
    const root = temp(), leaseDir = path.join(root, 'leases'); fs.mkdirSync(leaseDir);
    const leaseFile = path.join(leaseDir, `${variant}.json`), nonce = 'expected-nonce';
    fs.writeFileSync(leaseFile, JSON.stringify({ schemaVersion: 1, nonce, supervisorPid: process.pid, targetPid: null, status: 'settled', outcome: 'exited' }));
    const capture = `${leaseFile}.capture-stdout`;
    const bytes = variant === 'foreign' ? Buffer.from('FOREIGN_SENTINEL') : Buffer.from(`${JSON.stringify({ kind: 'scaffold-supervisor-capture', nonce: 'wrong-nonce', schemaVersion: 1, stream: 'stdout' })}\nprivate`);
    fs.writeFileSync(capture, bytes);
    await assert.rejects(() => fenceActiveLeases(leaseDir), errorCode('SUPERVISOR_CAPTURE_OWNERSHIP_INVALID'));
    assert.deepEqual(fs.readFileSync(capture), bytes);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

test('successful supervised root exit kills detached descendants before lease settlement', { timeout: 10000 }, async () => {
  const root = temp(), sentinel = path.join(root, 'detached-descendant.txt');
  const descendant = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'late'),700)`;
  const target = `const {spawn}=require('node:child_process');const p=spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{detached:true,stdio:'ignore'});p.unref()`;
  const result = await runSupervisedProcess(process.execPath, ['-e', target], { cwd: root, timeoutMs: 3000, maxCaptureBytes: 4096, leaseDir: path.join(root, 'leases') });
  assert.equal(result.exitCode, 0);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.equal(fs.existsSync(sentinel), false);
  const leases = fs.readdirSync(path.join(root, 'leases')).filter((name) => name.endsWith('.json')).map((name) => JSON.parse(fs.readFileSync(path.join(root, 'leases', name), 'utf8')));
  assert.equal(leases.length, 1);
  assert.equal(leases[0].status, 'settled');
  assert.equal(fs.readdirSync(path.join(root, 'leases')).some((name) => name.endsWith('.request')), false);
});

test('OS containment enforces the target output cap before returning buffered output', async () => {
  const root = temp();
  const result = await runSupervisedProcess(process.execPath, ['-e', "process.stdout.write('x'.repeat(200000))"], { cwd: root, timeoutMs: 3000, maxCaptureBytes: 1024, leaseDir: path.join(root, 'leases') });
  assert.equal(result.outputTooLarge, true);
  assert.ok(result.stdout.length <= 1024);
  const lease = JSON.parse(fs.readFileSync(path.join(root, 'leases', fs.readdirSync(path.join(root, 'leases')).find((name) => name.endsWith('.json'))), 'utf8'));
  assert.equal(lease.status, 'settled');
  assert.equal(lease.outcome, 'output_cap');
});

test('Codex adapter preserves argv/stdin boundaries and captures private JSONL', async () => {
  const input = fixture([{ path: 'src/a.mjs' }]), transport = path.join(input.root, 'private transport.jsonl');
  const request = { schemaVersion: 1, planDigest: 'a'.repeat(64), nodeId: 'node-a', attemptId: 'attempt-a', workspaceRoot: input.workspaceRoot, capsuleDir: input.root, compiledCommand: 'literal & | ; $() prompt', transportArtifactPath: transport, sandbox: 'workspace-write', fast: false, budget, requestedProfile: { model: null, reasoning: 'low', fast: false } };
  const response = await dispatchCodex(request, { executable: process.execPath, args: [FAKE, 'codex', input.controlFile, input.logFile] });
  assert.equal(response.status, 'succeeded'); assert.equal(fs.existsSync(transport), true);
  const call = readLog(input.logFile).find((entry) => entry.tool === 'codex');
  assert.deepEqual(call.argv.slice(0, 8), ['exec', '--ephemeral', '--json', '--skip-git-repo-check', '-s', 'workspace-write', '-C', input.workspaceRoot]);
  assert.equal(call.stdinDigest, digest(request.compiledCommand));
  assert.equal(fs.existsSync(path.join(input.workspaceRoot, 'no-shell')), false);
});

test('Codex timeout terminates its descendant process tree', async () => {
  const sentinelRoot = temp(), sentinel = path.join(sentinelRoot, 'descendant-survived.txt');
  const input = fixture([{ path: 'src/a.mjs' }], { codexChildSentinel: sentinel }), transport = path.join(input.root, 'timeout.jsonl');
  const request = { schemaVersion: 1, planDigest: 'a'.repeat(64), nodeId: 'node-a', attemptId: 'attempt-timeout', workspaceRoot: input.workspaceRoot, capsuleDir: input.root, compiledCommand: 'timeout test', transportArtifactPath: transport, sandbox: 'workspace-write', fast: false, budget: { ...budget, wallSeconds: 0.15 }, requestedProfile: { model: null, reasoning: 'low', fast: false } };
  const response = await dispatchCodex(request, { executable: process.execPath, args: [FAKE, 'codex', input.controlFile, input.logFile] });
  assert.equal(response.status, 'timeout'); await new Promise((resolve) => setTimeout(resolve, 900)); assert.equal(fs.existsSync(sentinel), false);
});

test('a mismatched dispatcher transport digest is rejected', async () => {
  const input = fixture([{ path: 'src/a.mjs' }], { badTransportDigest: true });
  await assert.rejects(runScaffoldAutomation(input), errorCode('DISPATCH_TRANSPORT_INVALID'));
  assert.equal(readLog(input.logFile).some((entry) => entry.tool === 'verify'), false);
});

test('CLI help and orchestrate options preserve the command surface', () => {
  const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0); assert.equal(help.stdout.includes('orchestrate <blueprint.json>'), true); assert.equal(help.stdout.includes('graph-diff <blueprint.json>'), true);
  const invalid = spawnSync(process.execPath, [CLI, 'orchestrate', 'a', 'b', 'c', 'd', 'e', '--fast', '--fast'], { encoding: 'utf8' });
  assert.equal(invalid.status, 2); assert.equal(JSON.parse(invalid.stderr).error.code, 'USAGE');
  const input = fixture([{ path: 'src/a.mjs' }]), blueprintFile = path.join(input.root, 'blueprint.json'), policyFile = path.join(input.root, 'policy.json'), bundleFile = path.join(input.root, 'bundle.json'), runtimeFile = path.join(input.root, 'runtime config.json');
  fs.writeFileSync(blueprintFile, JSON.stringify(input.blueprint)); fs.writeFileSync(policyFile, JSON.stringify(input.policy)); fs.writeFileSync(bundleFile, JSON.stringify({ gate: input.gate, receipts: input.receipts, findingsRoot: input.findingsRoot })); fs.writeFileSync(runtimeFile, JSON.stringify(input.runtimeConfig));
  const result = spawnSync(process.execPath, [CLI, 'orchestrate', blueprintFile, policyFile, bundleFile, input.workspaceRoot, input.planDir, '--runtime-config', runtimeFile, '--fast'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).status, 'COMPLETE');
  assert.equal(readLog(input.logFile).find((entry) => entry.tool === 'dispatch-start').fast, true);
});
