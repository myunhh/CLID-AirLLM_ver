import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  BlueprintError, blueprintDigest, policyDigest, deriveReviewQuorum, validateBlueprint,
  validateReviewReceipt, createGateAttestation, validateGateAttestation, compilePlan,
  writePlanDirectory, validatePlan, materializeScaffold, beginNodeAttempt, readAttemptLedger,
  completeNodeAttempt, compareObservedGraph, compareScaffoldGraph, validateWaveWriteSets,
} from '../lib/blueprint-scaffold.mjs';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scaffold-pipeline.mjs');
const COMMAND_WORKER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'command-worker.mjs');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const budget = { tokens: 100, toolCalls: 2, wallSeconds: 10, processes: 1 };
const clone = (value) => JSON.parse(JSON.stringify(value));
const failCode = (callback, code) => assert.throws(callback, (error) => error instanceof BlueprintError && error.code === code);
function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'blueprint-scaffold-')); }
function fixture(root, options = {}) {
  const policy = { schemaVersion: 1, policyVersion: 'policy-1', classification: 'M', ambiguitySignals: [], standardApprovals: 2, elevatedApprovals: 2, maxRetryCap: 2, reservedRoots: ['.git'] };
  const blueprint = {
    schemaVersion: 1, blueprintId: 'demo', classification: 'M', ambiguitySignals: [], builders: ['builder-a'], judges: ['judge-a', 'judge-b'], defaultBudget: budget,
    graphPolicy: { directed: true, edgeDirection: 'source-depends-on-target' },
    files: [
      { path: 'src/a.mjs', dependsOn: [], builderId: 'builder-a', contract: { purpose: 'a', exports: ['a'], acceptance: ['a passes'] }, instructions: 'implement a', stub: '/* IMPLEMENTATION_REQUIRED */\nexport const a = 1;\n', retryCap: 2 },
      { path: 'src/b.mjs', dependsOn: ['src/a.mjs'], builderId: 'builder-a', contract: { purpose: 'b', exports: ['b'], acceptance: ['b passes'] }, instructions: 'implement b', stub: '/* IMPLEMENTATION_REQUIRED */\nexport const b = 2;\n' },
    ],
  };
  Object.assign(policy, options.policy); Object.assign(blueprint, options.blueprint);
  fs.mkdirSync(root, { recursive: true });
  const quorum = deriveReviewQuorum(policy), receipts = ['judge-a', 'judge-b'].map((judgeId, index) => {
    const ref = `finding-${index}.md`, bytes = `finding ${judgeId}\n`;
    fs.writeFileSync(path.join(root, ref), bytes);
    return { schemaVersion: 1, blueprintDigest: blueprintDigest(blueprint, policy), policyDigest: policyDigest(policy), quorumDigest: quorum.quorumDigest, judgeId, nonce: `nonce-${index}`, outcome: 'approve', findingsArtifactRef: ref, findingsDigest: digest(bytes) };
  });
  const gate = createGateAttestation({ blueprint, policy, receipts, findingsRoot: root });
  return { blueprint, policy, receipts, gate, findingsRoot: root, workspaceRoot: root };
}
function planFixture(root) {
  const input = fixture(root); const plan = compilePlan(input); const planDir = path.join(root, 'plan');
  writePlanDirectory(planDir, plan, input); return { ...input, plan, planDir };
}
function cli(args, cwd = path.resolve('.')) { return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' }); }
function statIdentity(file) { const stat = fs.statSync(file); return { dev: String(stat.dev), ino: String(stat.ino), size: stat.size }; }

test('trusted-policy quorum downgrade and ambiguity quorum are fail closed', () => {
  const root = temp(), input = fixture(root);
  const downgraded = clone(input.policy); downgraded.standardApprovals = 1;
  failCode(() => validateGateAttestation(input.gate, { ...input, policy: downgraded }), 'GATE_BINDING_MISMATCH');
  const ambiguous = fixture(temp(), { policy: { ambiguitySignals: ['uncertain'] }, blueprint: { ambiguitySignals: ['uncertain'] } });
  assert.equal(deriveReviewQuorum(ambiguous.policy).requiredApprovals, 2);
  failCode(() => createGateAttestation({ ...ambiguous, receipts: [ambiguous.receipts[0]] }), 'REVIEW_QUORUM_INSUFFICIENT');
});

test('builder self-review and duplicate judge or nonce receipts are rejected', () => {
  const root = temp(), input = fixture(root), selfReview = clone(input.blueprint); selfReview.judges = ['builder-a'];
  failCode(() => validateBlueprint(selfReview, input.policy), 'BLUEPRINT_INVALID');
  failCode(() => createGateAttestation({ ...input, receipts: [input.receipts[0], input.receipts[0]] }), 'DUPLICATE_REVIEWER');
  const duplicateNonce = clone(input.receipts[1]); duplicateNonce.nonce = input.receipts[0].nonce;
  failCode(() => createGateAttestation({ ...input, receipts: [input.receipts[0], duplicateNonce] }), 'DUPLICATE_REVIEW_NONCE');
});

test('failed mismatched and missing findings receipts cannot enter a gate', () => {
  const root = temp(), input = fixture(root);
  const failed = clone(input.receipts[0]); failed.outcome = 'fail';
  failCode(() => validateReviewReceipt(failed, input), 'REVIEW_RECEIPT_INVALID');
  const mismatched = clone(input.receipts[0]); mismatched.findingsDigest = '0'.repeat(64);
  failCode(() => validateReviewReceipt(mismatched, input), 'FINDINGS_DIGEST_MISMATCH');
  const missing = clone(input.receipts[0]); missing.findingsArtifactRef = 'missing.md';
  failCode(() => validateReviewReceipt(missing, input), 'FINDINGS_ARTIFACT_REF_INVALID');
});

test('forged gate is rejected because compilePlan replays the exact receipt set', () => {
  const input = fixture(temp()), forged = clone(input.gate); forged.receiptDigests = ['a'.repeat(64), 'b'.repeat(64)];
  const body = { ...forged }; delete body.attestationDigest; forged.attestationDigest = digest(JSON.stringify(Object.fromEntries(Object.entries(body).sort())));
  failCode(() => compilePlan({ ...input, gate: forged }), 'GATE_ATTESTATION_INVALID');
  failCode(() => compilePlan({ blueprint: input.blueprint, policy: input.policy, gate: input.gate, workspaceRoot: input.workspaceRoot }), 'GATE_RECEIPTS_REQUIRED');
});

test('blueprint and canonical plan drift are rejected before product writes', () => {
  const root = temp(), input = planFixture(root), drifted = clone(input.blueprint); drifted.files[0].stub += 'x';
  failCode(() => compilePlan({ ...input, blueprint: drifted }), 'GATE_BINDING_MISMATCH');
  const planJson = path.join(input.planDir, 'plan.json'), original = fs.readFileSync(planJson);
  fs.writeFileSync(planJson, Buffer.from(`${original.toString().replace('demo', 'evil')}`));
  const product = path.join(root, 'src', 'a.mjs');
  failCode(() => materializeScaffold(input), 'PLAN_RECOMPILE_MISMATCH');
  assert.equal(fs.existsSync(product), false);
});

test('direct materialize without a verified canonical plan directory is rejected', () => {
  const input = fixture(temp());
  failCode(() => materializeScaffold({ ...input, planDir: undefined }), 'PLAN_DIRECTORY_REQUIRED');
  const plan = compilePlan(input);
  failCode(() => validatePlan(plan, input), 'PLAN_DIRECTORY_REQUIRED');
});

test('generated capsule ownership remains bound to the target workspace from an unrelated cwd', () => {
  const root = temp(), input = fixture(root), plan = compilePlan(input), planDir = path.join(root, 'plan'), elsewhere = temp();
  writePlanDirectory(planDir, plan, input);
  const capsule = plan.capsules.find((item) => item.id === plan.nodes.find((node) => node.path === 'src/a.mjs').id);
  const ownership = JSON.parse(capsule.files['OWNERSHIP.json']);
  const targetNode = plan.nodes.find((node) => node.path === 'src/a.mjs'), targetManifest = plan.manifest.find((entry) => entry.path === 'src/a.mjs');
  assert.equal(path.isAbsolute(ownership.worktreePath), true);
  assert.equal(path.resolve(ownership.worktreePath).toLocaleLowerCase('en-US'), fs.realpathSync.native(root).toLocaleLowerCase('en-US'));
  assert.deepEqual(ownership.allowedReadRoots, ['src/a.mjs', targetManifest.sidecarPath, targetNode.resultArtifactRef]);
  assert.deepEqual(ownership.allowedWriteFiles, ['src/a.mjs']);
  assert.deepEqual(plan.nodes.find((node) => node.path === 'src/a.mjs').writeSet, ['src/a.mjs']);
  assert.equal(plan.nodes.find((node) => node.path === 'src/a.mjs').resultArtifactRef.includes('/results/'), true);
  const dependentNode = plan.nodes.find((node) => node.path === 'src/b.mjs'), dependentManifest = plan.manifest.find((entry) => entry.path === 'src/b.mjs');
  const dependentOwnership = JSON.parse(plan.capsules.find((item) => item.id === dependentNode.id).files['OWNERSHIP.json']);
  assert.deepEqual(dependentOwnership.allowedReadRoots, ['src/b.mjs', 'src/a.mjs', dependentManifest.sidecarPath, dependentNode.resultArtifactRef]);
  assert.deepEqual(dependentOwnership.allowedWriteFiles, ['src/b.mjs']);
  const capsuleDir = path.join(planDir, 'capsules', capsule.id);
  const result = spawnSync(process.execPath, [COMMAND_WORKER, 'compile', '--capsule', capsuleDir], { cwd: elsewhere, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes(path.join(root, 'src', 'a.mjs').toLocaleLowerCase('en-US')), true);
  assert.equal(result.stdout.includes(path.join(elsewhere, 'src', 'a.mjs').toLocaleLowerCase('en-US')), false);
});

test('verification commands are strict and bound into plans and contract sidecars', () => {
  const root = temp(), input = fixture(root);
  input.blueprint.files[0].verificationCommands = [{ command: 'node', args: ['--test', 'test/a.test.mjs'], cwd: 'packages/a' }];
  for (const receipt of input.receipts) receipt.blueprintDigest = blueprintDigest(input.blueprint, input.policy);
  input.gate = createGateAttestation(input);
  const plan = compilePlan(input), node = plan.nodes.find((entry) => entry.path === 'src/a.mjs'), omitted = plan.nodes.find((entry) => entry.path === 'src/b.mjs');
  assert.deepEqual(node.verificationCommands, input.blueprint.files[0].verificationCommands);
  assert.deepEqual(omitted.verificationCommands, []);
  assert.deepEqual(plan.executionGraph.nodes.find((entry) => entry.targetPath === 'src/a.mjs').verificationCommands, input.blueprint.files[0].verificationCommands);
  assert.equal(plan.sidecars.find((sidecar) => sidecar.path.includes('src/a.mjs')).bytes.includes('"args":["--test","test/a.test.mjs"],"command":"node","cwd":"packages/a"'), true);
  const withoutCommands = fixture(temp());
  assert.notEqual(blueprintDigest(input.blueprint, input.policy), blueprintDigest(withoutCommands.blueprint, withoutCommands.policy));
  for (const bad of [
    [{ command: '', args: [] }],
    [{ command: 'node', args: 'test.mjs' }],
    [{ command: 'node', args: [], shell: true }],
    [{ command: 'node', args: [], cwd: '../outside' }],
  ]) {
    const candidate = clone(input.blueprint); candidate.files[0].verificationCommands = bad;
    failCode(() => validateBlueprint(candidate, input.policy), 'BLUEPRINT_VERIFICATION_COMMAND_INVALID');
  }
});

test('skill paths are unique workspace-relative and bound into plans capsules and sidecars', () => {
  const root = temp(), input = fixture(root);
  input.blueprint.files[0].skillPaths = ['.agents/skills/javascript/SKILL.md', '.agents/skills/testing/SKILL.md'];
  for (const receipt of input.receipts) receipt.blueprintDigest = blueprintDigest(input.blueprint, input.policy);
  input.gate = createGateAttestation(input);
  const plan = compilePlan(input), node = plan.nodes.find((entry) => entry.path === 'src/a.mjs'), omitted = plan.nodes.find((entry) => entry.path === 'src/b.mjs');
  assert.deepEqual(node.skillPaths, input.blueprint.files[0].skillPaths);
  assert.deepEqual(omitted.skillPaths, []);
  assert.deepEqual(plan.executionGraph.nodes.find((entry) => entry.targetPath === 'src/a.mjs').skillPaths, input.blueprint.files[0].skillPaths);
  const capsule = plan.capsules.find((entry) => entry.id === node.id), ownership = JSON.parse(capsule.files['OWNERSHIP.json']);
  const manifest = plan.manifest.find((entry) => entry.path === 'src/a.mjs');
  assert.deepEqual(ownership.allowedReadRoots, ['src/a.mjs', ...input.blueprint.files[0].skillPaths, manifest.sidecarPath, node.resultArtifactRef]);
  assert.deepEqual(ownership.allowedWriteFiles, ['src/a.mjs']); assert.deepEqual(node.writeSet, ['src/a.mjs']);
  assert.equal(capsule.files['CONTEXT.md'].includes(JSON.stringify(input.blueprint.files[0].skillPaths)), true);
  assert.equal(plan.sidecars.find((sidecar) => sidecar.path.includes('src/a.mjs')).bytes.includes(JSON.stringify(input.blueprint.files[0].skillPaths)), true);
  const withoutSkills = fixture(temp());
  assert.notEqual(blueprintDigest(input.blueprint, input.policy), blueprintDigest(withoutSkills.blueprint, withoutSkills.policy));
  for (const bad of [
    '.agents/skills/javascript/SKILL.md',
    ['.agents/skills/javascript/SKILL.md', '.agents/skills/javascript/SKILL.md'],
    ['.agents/skills/javascript/SKILL.md', '.AGENTS/SKILLS/JAVASCRIPT/SKILL.MD'],
    ['../outside/SKILL.md'],
    ['C:/outside/SKILL.md'],
    ['.agents\\skills\\javascript\\SKILL.md'],
    [''],
  ]) {
    const candidate = clone(input.blueprint); candidate.files[0].skillPaths = bad;
    failCode(() => validateBlueprint(candidate, input.policy), 'BLUEPRINT_SKILL_PATH_INVALID');
  }
});

test('materialization is idempotent and rejects differing product bytes', () => {
  const root = temp(), input = planFixture(root);
  assert.equal(materializeScaffold(input).status, 'MATERIALIZED');
  assert.equal(materializeScaffold(input).unchanged.length, 4);
  fs.writeFileSync(path.join(root, 'src/a.mjs'), 'different');
  failCode(() => materializeScaffold(input), 'MATERIALIZATION_CONFLICT');
});

test('path escape case Unicode device ADS trailing and file-prefix collisions are rejected', () => {
  const input = fixture(temp());
  for (const bad of ['../escape.mjs', 'src/CON', 'src/a:ads', 'src/trailing.']) {
    const candidate = clone(input.blueprint); candidate.files[0].path = bad;
    failCode(() => validateBlueprint(candidate, input.policy), 'PATH_INVALID');
  }
  for (const pair of [['src/A.mjs', 'src/a.mjs'], ['src/Straße.mjs', 'src/STRASSE.mjs'], ['src/file', 'src/file/child']]) {
    const candidate = clone(input.blueprint); candidate.files[0].path = pair[0]; candidate.files[1].path = pair[1]; candidate.files[1].dependsOn = [pair[0]];
    assert.throws(() => validateBlueprint(candidate, input.policy), (error) => error instanceof BlueprintError && ['PATH_COLLISION', 'NODE_ID_COLLISION'].includes(error.code));
  }
});

test('dependency cycles and unsafe same-wave writes are rejected while safe waves are deterministic', () => {
  const cyclic = fixture(temp()); cyclic.blueprint.files[0].dependsOn = ['src/b.mjs'];
  for (const receipt of cyclic.receipts) receipt.blueprintDigest = blueprintDigest(cyclic.blueprint, cyclic.policy);
  cyclic.gate = createGateAttestation(cyclic);
  assert.throws(() => compilePlan(cyclic), (error) => error instanceof BlueprintError && ['GRAPH_CYCLE', 'EXECUTION_GRAPH_INVALID'].includes(error.code));
  const input = fixture(temp()), plan = compilePlan(input);
  assert.deepEqual(plan.waves.map((wave) => wave.length), [1, 1]);
  assert.equal(plan.capsules.every((capsule) => Object.keys(capsule.files).length === 6), true);
  failCode(() => validateWaveWriteSets([{ writeSet: ['src/a.mjs'] }, { writeSet: ['src/a.mjs'] }]), 'SAME_WAVE_WRITE_CONFLICT');
  failCode(() => validateWaveWriteSets([{ writeSet: ['src'] }, { writeSet: ['src/a.mjs'] }]), 'SAME_WAVE_WRITE_CONFLICT');
});

test('attempt authority is plan bound and exactly two retries permit no fourth attempt', () => {
  const input = planFixture(temp()), ledger = path.join(input.workspaceRoot, 'ledger.json'), node = input.plan.nodes.find((entry) => entry.retryCap === 2);
  failCode(() => beginNodeAttempt({ ledgerPath: ledger, plan: input.plan, nodeId: 'undeclared', attemptId: 'x' }), 'ATTEMPT_NODE_UNDECLARED');
  failCode(() => beginNodeAttempt({ ledgerPath: ledger, plan: input.plan, nodeId: node.id, retryCap: 99, attemptId: 'x' }), 'ATTEMPT_INVALID');
  for (let ordinal = 1; ordinal <= 3; ordinal += 1) {
    const attemptId = `attempt-${ordinal}`;
    assert.equal(beginNodeAttempt({ ledgerPath: ledger, plan: input.plan, nodeId: node.id, attemptId }).status, 'RUNNING');
    assert.equal(completeNodeAttempt({ ledgerPath: ledger, plan: input.plan, nodeId: node.id, attemptId, outcome: 'failed', resultDigest: digest(`result-${ordinal}`) }).status, ordinal === 3 ? 'ESCALATED' : 'READY');
  }
  assert.equal(beginNodeAttempt({ ledgerPath: ledger, plan: input.plan, nodeId: node.id, attemptId: 'fourth' }).status, 'ESCALATED');
});

test('budget-exceeded completion immediately escalates and remains a valid terminal ledger', () => {
  const input = planFixture(temp()), ledger = path.join(input.workspaceRoot, 'budget-ledger.json'), node = input.plan.nodes.find((entry) => entry.retryCap === 2);
  beginNodeAttempt({ ledgerPath: ledger, plan: input.plan, nodeId: node.id, attemptId: 'budgeted' });
  const completed = completeNodeAttempt({ ledgerPath: ledger, plan: input.plan, nodeId: node.id, attemptId: 'budgeted', outcome: 'budget_exceeded', resultDigest: digest('budget exceeded result') });
  assert.equal(completed.status, 'ESCALATED'); assert.equal(completed.attempts, 1);
  const strict = readAttemptLedger(ledger, input.plan);
  assert.equal(strict.nodes[node.id].status, 'ESCALATED'); assert.equal(strict.nodes[node.id].attempts[0].status, 'FAILED'); assert.equal(strict.nodes[node.id].attempts[0].failureReason, 'budget_exceeded');
  const refused = beginNodeAttempt({ ledgerPath: ledger, plan: input.plan, nodeId: node.id, attemptId: 'must-not-run' });
  assert.equal(refused.status, 'ESCALATED'); assert.equal(refused.attempts, 1);
  assert.equal(readAttemptLedger(ledger, input.plan).nodes[node.id].attempts.length, 1);
});

test('unobserved usage immediately escalates and remains a valid terminal ledger', () => {
  const input = planFixture(temp()), ledger = path.join(input.workspaceRoot, 'usage-unobserved-ledger.json'), node = input.plan.nodes.find((entry) => entry.retryCap === 2);
  beginNodeAttempt({ ledgerPath: ledger, plan: input.plan, nodeId: node.id, attemptId: 'provider-succeeded-without-usage' });
  const completed = completeNodeAttempt({ ledgerPath: ledger, plan: input.plan, nodeId: node.id, attemptId: 'provider-succeeded-without-usage', outcome: 'usage_unobserved', resultDigest: digest('provider response without usage') });
  assert.equal(completed.status, 'ESCALATED'); assert.equal(completed.attempts, 1);
  const strict = readAttemptLedger(ledger, input.plan);
  assert.equal(strict.nodes[node.id].attempts[0].status, 'FAILED'); assert.equal(strict.nodes[node.id].attempts[0].failureReason, 'usage_unobserved');
  assert.deepEqual(beginNodeAttempt({ ledgerPath: ledger, plan: input.plan, nodeId: node.id, attemptId: 'must-not-run' }), { nodeId: node.id, status: 'ESCALATED', attempts: 1 });
  assert.equal(readAttemptLedger(ledger, input.plan).nodes[node.id].attempts.length, 1);
});

test('downstream attempts require all plan-declared dependencies to have succeeded', () => {
  const input = planFixture(temp()), ledger = path.join(input.workspaceRoot, 'dependency-ledger.json');
  const prerequisite = input.plan.nodes.find((entry) => entry.path === 'src/a.mjs'), downstream = input.plan.nodes.find((entry) => entry.path === 'src/b.mjs');
  failCode(() => beginNodeAttempt({ ledgerPath: ledger, plan: input.plan, nodeId: downstream.id, attemptId: 'too-early' }), 'ATTEMPT_DEPENDENCIES_INCOMPLETE');
  beginNodeAttempt({ ledgerPath: ledger, plan: input.plan, nodeId: prerequisite.id, attemptId: 'prerequisite' });
  completeNodeAttempt({ ledgerPath: ledger, plan: input.plan, nodeId: prerequisite.id, attemptId: 'prerequisite', outcome: 'succeeded', resultDigest: digest('prerequisite result') });
  assert.equal(beginNodeAttempt({ ledgerPath: ledger, plan: input.plan, nodeId: downstream.id, attemptId: 'now-ready' }).status, 'RUNNING');
});

test('attempt ledgers reject malformed nested state and recover only verified dead-owner locks', () => {
  const input = planFixture(temp()), node = input.plan.nodes.find((entry) => entry.path === 'src/a.mjs');
  for (const [name, nodes] of [
    ['unknown-node', { unknown: { retryCap: 0, status: 'READY', attempts: [] } }],
    ['bad-ordinal', { [node.id]: { retryCap: node.retryCap, status: 'RUNNING', attempts: [{ attemptId: 'bad', ordinal: 2, status: 'RUNNING' }] } }],
    ['bad-status', { [node.id]: { retryCap: node.retryCap, status: 'SUCCEEDED', attempts: [] } }],
  ]) {
    const ledger = path.join(input.workspaceRoot, `${name}.json`);
    fs.writeFileSync(ledger, JSON.stringify({ schemaVersion: 1, planDigest: input.plan.planDigest, nodes }));
    failCode(() => beginNodeAttempt({ ledgerPath: ledger, plan: input.plan, nodeId: node.id, attemptId: `try-${name}` }), 'ATTEMPT_LEDGER_INVALID');
    assert.equal(fs.existsSync(`${ledger}.lock`), false);
  }
  const staleLedger = path.join(input.workspaceRoot, 'stale-ledger.json'), staleLock = `${staleLedger}.lock`;
  fs.mkdirSync(staleLock);
  fs.writeFileSync(path.join(staleLock, 'owner.json'), JSON.stringify({ schemaVersion: 1, pid: 99999996, transactionId: 'dead-ledger-owner', planDigest: input.plan.planDigest, workspaceIdentity: digest(JSON.stringify({ ledgerPath: path.resolve(staleLedger) })) }));
  assert.equal(beginNodeAttempt({ ledgerPath: staleLedger, plan: input.plan, nodeId: node.id, attemptId: 'after-stale' }).status, 'RUNNING');
  assert.equal(fs.existsSync(staleLock), false);
  const liveLedger = path.join(input.workspaceRoot, 'live-ledger.json'), liveLock = `${liveLedger}.lock`;
  fs.mkdirSync(liveLock);
  fs.writeFileSync(path.join(liveLock, 'owner.json'), JSON.stringify({ schemaVersion: 1, pid: process.pid, transactionId: 'live-ledger-owner', planDigest: input.plan.planDigest, workspaceIdentity: digest(JSON.stringify({ ledgerPath: path.resolve(liveLedger) })) }));
  failCode(() => beginNodeAttempt({ ledgerPath: liveLedger, plan: input.plan, nodeId: node.id, attemptId: 'blocked-live' }), 'PIPELINE_LOCKED');
  assert.equal(fs.existsSync(liveLock), true);
  const uncertainLedger = path.join(input.workspaceRoot, 'uncertain-ledger.json'), uncertainLock = `${uncertainLedger}.lock`;
  fs.mkdirSync(uncertainLock); fs.writeFileSync(path.join(uncertainLock, 'owner.json'), '{}');
  failCode(() => beginNodeAttempt({ ledgerPath: uncertainLedger, plan: input.plan, nodeId: node.id, attemptId: 'blocked-uncertain' }), 'LOCK_IDENTITY_UNCERTAIN');
  assert.equal(fs.existsSync(uncertainLock), true);
});

test('strict attempt-ledger reads reject forged nested state against the supplied plan', () => {
  const input = planFixture(temp()), ledger = path.join(input.workspaceRoot, 'strict-read-ledger.json'), node = input.plan.nodes.find((entry) => entry.path === 'src/a.mjs');
  beginNodeAttempt({ ledgerPath: ledger, plan: input.plan, nodeId: node.id, attemptId: 'valid' });
  assert.equal(readAttemptLedger(ledger, input.plan).nodes[node.id].status, 'RUNNING');
  const forged = JSON.parse(fs.readFileSync(ledger, 'utf8')); forged.nodes[node.id].attempts[0].ordinal = 99; fs.writeFileSync(ledger, JSON.stringify(forged));
  failCode(() => readAttemptLedger(ledger, input.plan), 'ATTEMPT_LEDGER_INVALID');
  assert.equal(readAttemptLedger(ledger).nodes[node.id].attempts[0].ordinal, 99);
});

test('attempts after verified success are terminal and result digests cannot replay', () => {
  const input = fixture(temp()); input.blueprint.files[1].retryCap = 2;
  for (const receipt of input.receipts) receipt.blueprintDigest = blueprintDigest(input.blueprint, input.policy);
  input.gate = createGateAttestation(input); input.plan = compilePlan(input);
  const ledger = path.join(input.workspaceRoot, 'ledger.json'), node = input.plan.nodes.find((entry) => entry.path === 'src/a.mjs'), replayNode = input.plan.nodes.find((entry) => entry.path === 'src/b.mjs'), result = digest('pass');
  beginNodeAttempt({ ledgerPath: ledger, plan: input.plan, nodeId: node.id, attemptId: 'one' });
  assert.equal(completeNodeAttempt({ ledgerPath: ledger, plan: input.plan, nodeId: node.id, attemptId: 'one', outcome: 'succeeded', resultDigest: result }).status, 'SUCCEEDED');
  failCode(() => beginNodeAttempt({ ledgerPath: ledger, plan: input.plan, nodeId: node.id, attemptId: 'two' }), 'ATTEMPT_TERMINAL');
  const replayDigest = digest('first failed result');
  beginNodeAttempt({ ledgerPath: ledger, plan: input.plan, nodeId: replayNode.id, attemptId: 'failed-one' });
  assert.equal(completeNodeAttempt({ ledgerPath: ledger, plan: input.plan, nodeId: replayNode.id, attemptId: 'failed-one', outcome: 'failed', resultDigest: replayDigest }).status, 'READY');
  assert.equal(beginNodeAttempt({ ledgerPath: ledger, plan: input.plan, nodeId: replayNode.id, attemptId: 'failed-two' }).status, 'RUNNING');
  failCode(() => completeNodeAttempt({ ledgerPath: ledger, plan: input.plan, nodeId: replayNode.id, attemptId: 'failed-two', outcome: 'failed', resultDigest: replayDigest }), 'RESULT_DIGEST_REPLAY');
  const corruptLedger = path.join(input.workspaceRoot, 'corrupt-ledger.json'); fs.writeFileSync(corruptLedger, '{');
  failCode(() => beginNodeAttempt({ ledgerPath: corruptLedger, plan: input.plan, nodeId: replayNode.id, attemptId: 'corrupt' }), 'ATTEMPT_LEDGER_INVALID');
  assert.equal(fs.existsSync(`${corruptLedger}.lock`), false);
});

test('constructed dead-owner journal resumes only its bound operation set', () => {
  const root = temp(), input = planFixture(root), publications = input.blueprint.files.map((file) => ({ path: file.path, bytes: file.stub })).concat(input.plan.sidecars.map((sidecar) => ({ path: sidecar.path, bytes: sidecar.bytes })));
  const records = publications.map(({ path: relative, bytes }, index) => {
    const target = path.join(root, ...relative.split('/')); fs.mkdirSync(path.dirname(target), { recursive: true });
    if (index === 0) {
      const prepared = path.join(path.dirname(target), `.${path.basename(target)}.prepared.tmp`); fs.writeFileSync(prepared, bytes);
      return { path: relative, target, temp: prepared, digest: digest(bytes), state: 'prepared', tempIdentity: statIdentity(prepared) };
    }
    fs.writeFileSync(target, bytes); return { path: relative, target, digest: digest(bytes), state: 'existing', targetIdentity: statIdentity(target) };
  });
  const stateRoot = path.join(root, '.orchestrator/blueprints/demo'), lock = path.join(stateRoot, 'materialization.lock'); fs.mkdirSync(lock, { recursive: true });
  const owner = { schemaVersion: 1, pid: 99999999, transactionId: 'dead-transaction', planDigest: input.plan.planDigest, workspaceIdentity: input.plan.authorization.workspaceIdentity };
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(owner));
  fs.writeFileSync(path.join(stateRoot, 'materialization.journal.json'), JSON.stringify({ schemaVersion: owner.schemaVersion, transactionId: owner.transactionId, planDigest: owner.planDigest, workspaceIdentity: owner.workspaceIdentity, state: 'prepared', records }));
  const recovered = materializeScaffold(input); assert.equal(recovered.status, 'RECOVERED');
  assert.deepEqual(recovered.created, [publications[0].path]); assert.deepEqual(recovered.unchanged, publications.slice(1).map((item) => item.path));
  assert.equal(fs.existsSync(lock), false);
  const tamperedRoot = temp(), tampered = planFixture(tamperedRoot), tamperedPublications = tampered.blueprint.files.map((file) => ({ path: file.path, bytes: file.stub })).concat(tampered.plan.sidecars.map((sidecar) => ({ path: sidecar.path, bytes: sidecar.bytes })));
  const tamperedRecords = tamperedPublications.map(({ path: relative, bytes }) => {
    const target = path.join(tamperedRoot, ...relative.split('/')); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, bytes);
    return { path: relative, target, digest: digest(bytes), state: 'existing', targetIdentity: statIdentity(target) };
  });
  const tamperedStateRoot = path.join(tamperedRoot, '.orchestrator/blueprints/demo'), tamperedLock = path.join(tamperedStateRoot, 'materialization.lock'); fs.mkdirSync(tamperedLock, { recursive: true });
  const tamperedOwner = { schemaVersion: 1, pid: 99999997, transactionId: 'extra-operation', planDigest: tampered.plan.planDigest, workspaceIdentity: tampered.plan.authorization.workspaceIdentity };
  fs.writeFileSync(path.join(tamperedLock, 'owner.json'), JSON.stringify(tamperedOwner));
  tamperedRecords.push({ ...tamperedRecords[0], path: 'src/extra.mjs', target: path.join(tamperedRoot, 'src/extra.mjs') });
  fs.writeFileSync(path.join(tamperedStateRoot, 'materialization.journal.json'), JSON.stringify({ schemaVersion: 1, transactionId: tamperedOwner.transactionId, planDigest: tamperedOwner.planDigest, workspaceIdentity: tamperedOwner.workspaceIdentity, state: 'prepared', records: tamperedRecords }));
  failCode(() => materializeScaffold(tampered), 'RECOVERY_OPERATION_SET_MISMATCH');
  for (const publication of tamperedPublications) assert.equal(fs.readFileSync(path.join(tamperedRoot, ...publication.path.split('/')), 'utf8'), publication.bytes);
  assert.equal(fs.existsSync(path.join(tamperedRoot, 'src/extra.mjs')), false);
});

test('foreign replacement during recovery is refused rather than deleted or overwritten', () => {
  const root = temp(), input = planFixture(root), publication = { path: input.blueprint.files[0].path, bytes: input.blueprint.files[0].stub };
  const target = path.join(root, ...publication.path.split('/')); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, publication.bytes);
  const oldIdentity = statIdentity(target), stateRoot = path.join(root, '.orchestrator/blueprints/demo'), lock = path.join(stateRoot, 'materialization.lock'); fs.mkdirSync(lock, { recursive: true });
  const owner = { schemaVersion: 1, pid: 99999998, transactionId: 'foreign-transaction', planDigest: input.plan.planDigest, workspaceIdentity: input.plan.authorization.workspaceIdentity };
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(owner));
  const publications = input.blueprint.files.map((file) => ({ path: file.path, bytes: file.stub })).concat(input.plan.sidecars.map((sidecar) => ({ path: sidecar.path, bytes: sidecar.bytes })));
  const records = publications.map((item) => {
    const file = path.join(root, ...item.path.split('/')); fs.mkdirSync(path.dirname(file), { recursive: true }); if (!fs.existsSync(file)) fs.writeFileSync(file, item.bytes);
    return { path: item.path, target: file, digest: digest(item.bytes), state: 'existing', targetIdentity: item.path === publication.path ? oldIdentity : statIdentity(file) };
  });
  fs.rmSync(target); fs.writeFileSync(target, publication.bytes);
  fs.writeFileSync(path.join(stateRoot, 'materialization.journal.json'), JSON.stringify({ schemaVersion: 1, transactionId: owner.transactionId, planDigest: owner.planDigest, workspaceIdentity: owner.workspaceIdentity, state: 'prepared', records }));
  failCode(() => materializeScaffold(input), 'FOREIGN_REPLACEMENT_REFUSED');
  assert.equal(fs.readFileSync(target, 'utf8'), publication.bytes);
});

test('observed graph reports exact missing unexpected reversed dangling self-loop and malformed cases', () => {
  const input = fixture(temp());
  failCode(() => compareObservedGraph({ ...input, observedGraph: null }), 'OBSERVED_GRAPH_INVALID');
  const report = compareObservedGraph({ ...input, observedGraph: { directed: true, edgeDirection: 'source-depends-on-target', nodes: [{ id: 'a', source_file: 'src/a.mjs' }, { id: 'b', source_file: 'src/b.mjs' }], edges: [{ source: 'a', target: 'b' }, { source: 'b', target: 'b' }, { source: 'a', target: 'missing' }] } });
  assert.equal(report.matches, false); assert.deepEqual(report.missingEdges, ['src/b.mjs->src/a.mjs']); assert.deepEqual(report.unexpectedEdges, ['src/a.mjs->src/b.mjs']);
  assert.deepEqual(report.errors.map((error) => error.code), ['DANGLING_EDGE', 'SELF_LOOP']);
  failCode(() => compareObservedGraph({ ...input, observedGraph: { directed: false, edgeDirection: 'source-depends-on-target', nodes: [], edges: [] } }), 'OBSERVED_GRAPH_INVALID');
  const symbols = compareObservedGraph({ ...input, observedGraph: { directed: true, edgeDirection: 'source-depends-on-target', nodes: [{ id: 'a-one', source_file: 'src/a.mjs' }, { id: 'a-two', source_file: 'src/a.mjs' }, { id: 'b-one', source_file: 'src/b.mjs' }, { id: 'b-two', source_file: 'src/b.mjs' }], edges: [{ source: 'b-one', target: 'a-one' }, { source: 'b-two', target: 'a-two' }] } });
  assert.equal(symbols.matches, true); assert.deepEqual(symbols.missingEdges, []); assert.deepEqual(symbols.unexpectedEdges, []);
  const alias = compareObservedGraph({ ...input, observedGraph: { directed: true, edgeDirection: 'source-depends-on-target', nodes: [{ id: 'a', source_file: 'src/A.mjs' }, { id: 'b', source_file: 'src/b.mjs' }], edges: [{ source: 'b', target: 'a' }] } });
  assert.equal(alias.matches, false); assert.deepEqual(alias.errors.map((error) => error.code), ['DUPLICATE_SOURCE_MAPPING']);
});

test('observed graph accepts native Graphify node-link JSON and ignores provenance-free concepts', () => {
  const input = fixture(temp());
  const report = compareObservedGraph({ ...input, observedGraph: {
    directed: false,
    multigraph: false,
    graph: {},
    hyperedges: [],
    built_at_commit: '0123456789abcdef',
    nodes: [
      { id: 'a', label: 'a', source_file: 'src/a.mjs', community: 0, norm_label: 'a' },
      { id: 'b', label: 'b', source_file: 'src/b.mjs', community: 0, norm_label: 'b' },
      { id: 'concept', label: 'semantic concept', source_file: '', community: 1, norm_label: 'semantic concept' },
    ],
    links: [
      { source: 'b', target: 'a', relation: 'imports_from', confidence_score: 1, source_file: 'src/b.mjs' },
      { source: 'a', target: 'b', relation: 'calls', confidence_score: 1, source_file: 'src/a.mjs' },
      { source: 'a', target: 'b', relation: 'references', confidence_score: 1, source_file: 'src/a.mjs' },
      { source: 'concept', target: 'a', relation: 'describes', confidence_score: 0.8 },
    ],
  } });
  assert.equal(report.matches, true); assert.deepEqual(report.errors, []);
  failCode(() => compareObservedGraph({ ...input, observedGraph: { directed: true, nodes: [], edges: [], links: [] } }), 'OBSERVED_GRAPH_INVALID');
  failCode(() => compareObservedGraph({ ...input, observedGraph: { directed: false, nodes: [], edges: [] } }), 'OBSERVED_GRAPH_INVALID');
  failCode(() => compareObservedGraph({ ...input, observedGraph: { directed: false, nodes: [{ id: 'a', source_file: 'src/a.mjs' }], links: [{ source: 'a', target: 'a' }] } }), 'OBSERVED_GRAPH_INVALID');
  const callsOnly = compareObservedGraph({ ...input, observedGraph: { directed: false, nodes: [{ id: 'a', source_file: 'src/a.mjs' }, { id: 'b', source_file: 'src/b.mjs' }], links: [{ source: 'b', target: 'a', relation: 'calls' }] } });
  assert.equal(callsOnly.matches, false); assert.deepEqual(callsOnly.missingEdges, ['src/b.mjs->src/a.mjs']); assert.deepEqual(callsOnly.unexpectedEdges, []);
});

test('phased comparator accepts only the raw Graphify extraction envelope and filters relations', () => {
  const input = fixture(temp()), rawGraphify = {
    nodes: [
      { id: 'module-a', label: 'src/a.mjs', source_file: 'src/a.mjs', type: 'module' },
      { id: 'symbol-a', label: 'a', source_file: 'src/a.mjs', type: 'function' },
      { id: 'module-b', label: 'src/b.mjs', source_file: 'src/b.mjs', type: 'module' },
      { id: 'symbol-b', label: 'b', source_file: 'src/b.mjs', type: 'function' },
      { id: 'other', label: 'other', source_file: 'src/other.mjs', type: 'module' },
    ],
    edges: [
      { source: 'module-a', target: 'symbol-a', relation: 'contains', source_file: 'src/a.mjs' },
      { source: 'module-b', target: 'module-a', relation: 'imports_from', source_file: 'src/b.mjs' },
      { source: 'symbol-b', target: 'symbol-a', relation: 'imports', source_file: 'src/b.mjs' },
      { source: 'other', target: 'module-a', relation: 'contains', source_file: 'src/other.mjs' },
    ],
    hyperedges: [],
    input_tokens: 0,
    output_tokens: 0,
  };
  const dependencies = compareScaffoldGraph({ ...input, observedGraph: rawGraphify, phase: 'dependencies' });
  assert.equal(dependencies.matches, true); assert.deepEqual(dependencies.missingEdges, []); assert.deepEqual(dependencies.unexpectedEdges, []); assert.deepEqual(dependencies.errors, []);
  assert.equal(compareScaffoldGraph({ ...input, observedGraph: rawGraphify, phase: 'structure' }).matches, true);
  const extraTopLevel = { ...rawGraphify, metadata: {} };
  failCode(() => compareScaffoldGraph({ ...input, observedGraph: extraTopLevel, phase: 'dependencies' }), 'OBSERVED_GRAPH_INVALID');
  const missingRelation = clone(rawGraphify); delete missingRelation.edges[0].relation;
  failCode(() => compareScaffoldGraph({ ...input, observedGraph: missingRelation, phase: 'dependencies' }), 'OBSERVED_GRAPH_INVALID');
  for (const malformed of [
    { ...rawGraphify, input_tokens: -1 },
    { ...rawGraphify, input_tokens: Number.POSITIVE_INFINITY },
    { ...rawGraphify, output_tokens: '0' },
    Object.fromEntries(Object.entries(rawGraphify).filter(([key]) => key !== 'output_tokens')),
    { nodes: rawGraphify.nodes, edges: rawGraphify.edges, hyperedges: [] },
  ]) failCode(() => compareScaffoldGraph({ ...input, observedGraph: malformed, phase: 'dependencies' }), 'OBSERVED_GRAPH_INVALID');
});

test('phased graph comparison separates declared structure from exact declared dependencies', () => {
  const input = fixture(temp()), observedGraph = {
    directed: false,
    nodes: [
      { id: 'a', source_file: 'src/a.mjs' },
      { id: 'b', source_file: 'src/b.mjs' },
      { id: 'unrelated', source_file: 'src/unrelated.mjs' },
    ],
    links: [
      { source: 'a', target: 'b', relation: 'imports' },
      { source: 'unrelated', target: 'a', relation: 'imports' },
    ],
  };
  const structure = compareScaffoldGraph({ ...input, observedGraph, phase: 'structure' });
  assert.equal(structure.phase, 'structure'); assert.equal(structure.matches, true);
  assert.deepEqual(structure.missingEdges, []); assert.deepEqual(structure.unexpectedEdges, []); assert.deepEqual(structure.errors, []);
  const dependencies = compareScaffoldGraph({ ...input, observedGraph, phase: 'dependencies' });
  assert.equal(dependencies.phase, 'dependencies'); assert.equal(dependencies.matches, false);
  assert.deepEqual(dependencies.missingEdges, ['src/b.mjs->src/a.mjs']);
  assert.deepEqual(dependencies.unexpectedEdges, ['src/a.mjs->src/b.mjs']); assert.deepEqual(dependencies.errors, []);
  const exact = clone(observedGraph); exact.links[0] = { source: 'b', target: 'a', relation: 'imports_from' };
  assert.equal(compareScaffoldGraph({ ...input, observedGraph: exact, phase: 'dependencies' }).matches, true);
  const missing = clone(exact); missing.nodes = missing.nodes.filter((node) => node.id !== 'b'); missing.links = missing.links.filter((edge) => edge.source !== 'b' && edge.target !== 'b');
  assert.deepEqual(compareScaffoldGraph({ ...input, observedGraph: missing, phase: 'structure' }).errors.map((error) => error.code), ['DECLARED_FILE_MISSING']);
  failCode(() => compareScaffoldGraph({ ...input, observedGraph, phase: 'edges' }), 'OBSERVED_GRAPH_PHASE_INVALID');
  const legacy = compareObservedGraph({ ...input, observedGraph });
  assert.equal(legacy.errors.some((error) => error.code === 'UNEXPECTED_SOURCE_FILE'), true);
});

test('graph-diff CLI mismatch exits one and creates no files', () => {
  const root = temp(), input = fixture(root), blueprintFile = path.join(root, 'blueprint.json'), policyFile = path.join(root, 'policy.json'), observedFile = path.join(root, 'observed.json');
  fs.writeFileSync(blueprintFile, JSON.stringify(input.blueprint)); fs.writeFileSync(policyFile, JSON.stringify(input.policy)); fs.writeFileSync(observedFile, JSON.stringify({ directed: true, edgeDirection: 'source-depends-on-target', nodes: [], edges: [] }));
  const before = fs.readdirSync(root).sort(), result = cli(['graph-diff', blueprintFile, policyFile, observedFile]);
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stdout).matches, false); assert.deepEqual(fs.readdirSync(root).sort(), before);
});

test('graph-diff missing input exits one with a structured error and creates no files', () => {
  const root = temp(), input = fixture(root), blueprintFile = path.join(root, 'blueprint.json'), policyFile = path.join(root, 'policy.json');
  fs.writeFileSync(blueprintFile, JSON.stringify(input.blueprint)); fs.writeFileSync(policyFile, JSON.stringify(input.policy));
  const before = fs.readdirSync(root).sort(), result = cli(['graph-diff', blueprintFile, policyFile, path.join(root, 'missing.json')]);
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stderr).error.code, 'OBSERVED_GRAPH_UNREADABLE'); assert.deepEqual(fs.readdirSync(root).sort(), before);
});

test('thin CLI has static help usage exit two and a receipt-bound gate-plan-materialize flow', () => {
  const root = temp(), input = fixture(root), blueprintFile = path.join(root, 'blueprint.json'), policyFile = path.join(root, 'policy.json'), bundleFile = path.join(root, 'gate.json'), planDir = path.join(root, 'cli-plan');
  fs.writeFileSync(blueprintFile, JSON.stringify(input.blueprint)); fs.writeFileSync(policyFile, JSON.stringify(input.policy));
  const receiptFiles = input.receipts.map((receipt, index) => { const file = path.join(root, `receipt-${index}.json`); fs.writeFileSync(file, JSON.stringify(receipt)); return file; });
  const help = cli(['--help']);
  assert.equal(help.status, 0);
  for (const contract of [
    'validate <blueprint.json> <policy.json>',
    'gate <blueprint.json> <policy.json> <output.json> <receipt.json...>',
    'plan <blueprint.json> <policy.json> <gate.json> <workspace-root> <plan-dir>',
    'materialize <blueprint.json> <policy.json> <gate.json> <workspace-root> <plan-dir>',
    'attempt-begin <plan-dir> <ledger-dir> <node-id> <attempt-id>',
    'attempt-complete <plan-dir> <ledger-dir> <node-id> <attempt-id> <pass|fail> <result-artifact>',
    'graph-diff <blueprint.json> <policy.json> <observed-graph.json>',
  ]) assert.equal(help.stdout.includes(contract), true, `missing help contract: ${contract}`);
  assert.equal(cli(['plan']).status, 2);
  assert.equal(cli(['gate', blueprintFile, policyFile, bundleFile, ...receiptFiles]).status, 0);
  assert.equal(cli(['plan', blueprintFile, policyFile, bundleFile, root, planDir]).status, 0);
  assert.equal(cli(['materialize', blueprintFile, policyFile, bundleFile, root, planDir]).status, 0);
});
