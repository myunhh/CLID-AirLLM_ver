import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { initRun, status, transition, submitVerdict, approveGate } from '../orchestrator-graph.mjs';
import { validateHumanApproval, validateJudgeReceipt } from '../lib/authority.mjs';

const fixtures = path.join(import.meta.dirname, 'fixtures');
const judge = JSON.parse(fs.readFileSync(path.join(fixtures, 'judge-receipt-valid.json'), 'utf8'));
const human = JSON.parse(fs.readFileSync(path.join(fixtures, 'human-approval-valid.json'), 'utf8'));
const judgeExpected = { runId: judge.runId, nodeId: judge.nodeId, acceptanceDigest: judge.acceptanceDigest, resultDigest: judge.resultDigest, judgeIds: ['judge-1'], builderIds: ['builder-1'], nonce: judge.nonce, consumedNonces: new Set(), consumedReceiptDigests: new Set() };
const humanExpected = { runId: human.runId, gateId: human.gateId, actionDigest: human.actionDigest, gateNonce: human.gateNonce, consumedNonces: new Set(), consumedReceiptDigests: new Set() };
const controllerCli = path.resolve(import.meta.dirname, '..', 'orchestrator-graph.mjs');
function errorCode(fn, code) { assert.throws(fn, (error) => error.code === code); }
function changed(base, field, value) { const result = { ...base }; if (value === undefined) delete result[field]; else result[field] = value; return result; }

test('every Judge receipt missing/substitution/replay case has its stable ID', () => {
  const cases = [
    ['runId', undefined, 'JUDGE_RECEIPT_RUN_ID_MISSING'], ['runId', 'other', 'JUDGE_RECEIPT_RUN_ID_MISMATCH'],
    ['nodeId', undefined, 'JUDGE_RECEIPT_NODE_ID_MISSING'], ['nodeId', 'other', 'JUDGE_RECEIPT_NODE_ID_MISMATCH'],
    ['acceptanceDigest', undefined, 'JUDGE_RECEIPT_ACCEPTANCE_DIGEST_MISSING'], ['acceptanceDigest', '0'.repeat(64), 'JUDGE_RECEIPT_ACCEPTANCE_DIGEST_MISMATCH'],
    ['resultDigest', undefined, 'JUDGE_RECEIPT_RESULT_DIGEST_MISSING'], ['resultDigest', '0'.repeat(64), 'JUDGE_RECEIPT_RESULT_DIGEST_MISMATCH'],
    ['judgeId', undefined, 'JUDGE_RECEIPT_JUDGE_ID_MISSING'], ['judgeId', 'undeclared', 'JUDGE_RECEIPT_JUDGE_ID_MISMATCH'],
    ['judgeId', 'builder-1', 'BUILDER_JUDGE_NOT_INDEPENDENT'], ['nonce', undefined, 'JUDGE_RECEIPT_NONCE_MISSING'], ['nonce', 'altered', 'JUDGE_RECEIPT_NONCE_MISMATCH']
  ];
  for (const [field, value, code] of cases) errorCode(() => validateJudgeReceipt(changed(judge, field, value), judgeExpected), code);
  errorCode(() => validateJudgeReceipt(judge, { ...judgeExpected, consumedNonces: new Set([judge.nonce]) }), 'RECEIPT_REPLAY');
});

test('every Human approval missing/substitution/replay case has its stable ID', () => {
  const cases = [
    ['runId', undefined, 'HUMAN_APPROVAL_RUN_ID_MISSING'], ['runId', 'other', 'HUMAN_APPROVAL_RUN_ID_MISMATCH'],
    ['gateId', undefined, 'HUMAN_APPROVAL_GATE_ID_MISSING'], ['gateId', 'other', 'HUMAN_APPROVAL_GATE_ID_MISMATCH'],
    ['actionDigest', undefined, 'HUMAN_APPROVAL_ACTION_DIGEST_MISSING'], ['actionDigest', '0'.repeat(64), 'HUMAN_APPROVAL_ACTION_DIGEST_MISMATCH'],
    ['gateNonce', undefined, 'HUMAN_APPROVAL_GATE_NONCE_MISSING'], ['gateNonce', 'altered', 'HUMAN_APPROVAL_GATE_NONCE_MISMATCH']
  ];
  for (const [field, value, code] of cases) errorCode(() => validateHumanApproval(changed(human, field, value), humanExpected), code);
  errorCode(() => validateHumanApproval(human, { ...humanExpected, consumedNonces: new Set([human.gateNonce]) }), 'RECEIPT_REPLAY');
});

async function makeRun(graphName) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-authority-')), run = path.join(root, 'run');
  await initRun(path.join(fixtures, graphName), run); fs.mkdirSync(path.join(run, 'artifacts')); fs.writeFileSync(path.join(run, 'artifacts', 'result.txt'), 'verified result\n'); return { root, run };
}
function snapshot(run) { return [fs.readFileSync(path.join(run, 'events.jsonl')), fs.readFileSync(path.join(run, 'checkpoint.json'))]; }
function sameSnapshot(run, before) { assert.deepEqual(fs.readFileSync(path.join(run, 'events.jsonl')), before[0]); assert.deepEqual(fs.readFileSync(path.join(run, 'checkpoint.json')), before[1]); assert.equal(fs.existsSync(path.join(run, '.authority.lock')), false); }

test('Judge receipt advances one node once; each rejected substitution writes nothing', async (t) => {
  const { root, run } = await makeRun('execution-graph-v2-valid.json'); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await transition(run, 'worker', 'RUNNING'); await transition(run, 'worker', 'VERIFYING');
  for (const [field, value, code] of [['runId', 'other', 'JUDGE_RECEIPT_RUN_ID_MISMATCH'], ['nodeId', 'other', 'JUDGE_RECEIPT_NODE_ID_MISMATCH'], ['acceptanceDigest', '0'.repeat(64), 'JUDGE_RECEIPT_ACCEPTANCE_DIGEST_MISMATCH'], ['resultDigest', '0'.repeat(64), 'JUDGE_RECEIPT_RESULT_DIGEST_MISMATCH'], ['judgeId', 'undeclared', 'JUDGE_RECEIPT_JUDGE_ID_MISMATCH'], ['nonce', 'altered', 'JUDGE_RECEIPT_NONCE_MISMATCH']]) {
    const before = snapshot(run); await assert.rejects(submitVerdict(run, changed(judge, field, value)), (error) => error.code === code); sameSnapshot(run, before);
  }
  const self = JSON.parse(fs.readFileSync(path.join(fixtures, 'judge-receipt-builder-self-pass.json'), 'utf8')); const beforeSelf = snapshot(run); await assert.rejects(submitVerdict(run, self), (e) => e.code === 'BUILDER_JUDGE_NOT_INDEPENDENT'); sameSnapshot(run, beforeSelf);
  const event = await submitVerdict(run, judge); assert.equal(event.seq, 4); assert.equal(event.data.to, 'SUCCEEDED'); assert.equal(event.authority, 'workflow_assertion');
  const beforeReplay = snapshot(run); await assert.rejects(submitVerdict(run, judge), (e) => e.code === 'RECEIPT_REPLAY'); sameSnapshot(run, beforeReplay);
});

test('Human approval advances one gate once and rejected binding writes nothing', async (t) => {
  const { root, run } = await makeRun('execution-graph-v2-human-gate.json'); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [field, value, code] of [['runId', 'other', 'HUMAN_APPROVAL_RUN_ID_MISMATCH'], ['gateId', 'other', 'HUMAN_APPROVAL_GATE_ID_MISMATCH'], ['actionDigest', '0'.repeat(64), 'HUMAN_APPROVAL_ACTION_DIGEST_MISMATCH'], ['gateNonce', 'other', 'HUMAN_APPROVAL_GATE_NONCE_MISMATCH']]) { const before = snapshot(run); await assert.rejects(approveGate(run, changed(human, field, value)), (e) => e.code === code); sameSnapshot(run, before); }
  const event = await approveGate(run, human); assert.equal(event.seq, 2); assert.equal(event.type, 'human_approval_recorded');
  const before = snapshot(run); await assert.rejects(approveGate(run, human), (e) => e.code === 'RECEIPT_REPLAY'); sameSnapshot(run, before);
});

test('initialized definition digest rejects every graph authority mutation without state writes', async (t) => {
  const mutations = [
    (g) => { g.runId = 'altered-run'; }, (g) => { g.builders[0] = 'altered-builder'; }, (g) => { g.judges[0] = 'altered-judge'; },
    (g) => { g.nodes[0].id = 'altered-node'; }, (g) => { g.nodes[0].dependsOn = ['altered-dependency']; }, (g) => { g.nodes[0].acceptance[0] = 'altered acceptance'; },
    (g) => { g.nodes[0].acceptanceDigest = '0'.repeat(64); }, (g) => { g.nodes[0].builderIds[0] = 'altered-builder'; }, (g) => { g.nodes[0].judgeNonce = 'altered-nonce'; },
    (g) => { g.nodes[0].resultArtifactRef = 'altered-result'; }, (g) => { g.nodes[0].budgets.tokens += 1; }, (g) => { g.humanGates = [{ id: 'new-gate', actionDigest: '0'.repeat(64), gateNonce: 'new-nonce' }]; },
    (g) => { g.unrecognizedAuthorityField = true; }
  ];
  for (const mutate of mutations) {
    const { root, run } = await makeRun('execution-graph-v2-valid.json'); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const graphFile = path.join(run, 'execution-graph.json'), graph = JSON.parse(fs.readFileSync(graphFile, 'utf8')); mutate(graph); fs.writeFileSync(graphFile, JSON.stringify(graph));
    const before = snapshot(run);
    assert.throws(() => status(run), (e) => e.code === 'RUN_DEFINITION_MUTATED'); sameSnapshot(run, before);
    await assert.rejects(transition(run, 'worker', 'RUNNING'), (e) => e.code === 'RUN_DEFINITION_MUTATED'); sameSnapshot(run, before);
    await assert.rejects(submitVerdict(run, judge), (e) => e.code === 'RUN_DEFINITION_MUTATED'); sameSnapshot(run, before);
    await assert.rejects(approveGate(run, human), (e) => e.code === 'RUN_DEFINITION_MUTATED'); sameSnapshot(run, before);
  }
});

test('ready and render CLI loads reject a mutated initialized definition before output writes', async (t) => {
  const { root, run } = await makeRun('execution-graph-v2-valid.json'); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const graphFile = path.join(run, 'execution-graph.json'), graph = JSON.parse(fs.readFileSync(graphFile, 'utf8')); graph.nodes[0].judgeNonce = 'mutated-before-cli-load'; fs.writeFileSync(graphFile, JSON.stringify(graph));
  const before = snapshot(run), output = path.join(root, 'render.mmd');
  for (const args of [['ready', run], ['render', run, '--output', output]]) { const result = spawnSync(process.execPath, [controllerCli, ...args], { encoding: 'utf8' }); assert.equal(result.status, 1); assert.match(result.stderr, /RUN_DEFINITION_MUTATED/u); sameSnapshot(run, before); }
  assert.equal(fs.existsSync(output), false);
});
