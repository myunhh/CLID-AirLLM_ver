import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const harness = path.resolve(import.meta.dirname, '..'), fixtures = path.join(import.meta.dirname, 'fixtures');
function cli(file, args) { return spawnSync(process.execPath, [path.join(harness, file), ...args], { encoding: 'utf8' }); }
test('help surfaces are static and successful', () => { for (const file of ['orchestrator-graph.mjs', 'verify-events.mjs', 'migrate-events.mjs']) { const result = cli(file, ['--help']); assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /Usage:/u); } });
test('controller help advertises receipt authority instead of a caller-role option', () => {
  const help = cli('orchestrator-graph.mjs', ['--help']);
  assert.equal(help.status, 0);
  assert.doesNotMatch(help.stdout, /\[--actor-role/u);
  assert.match(help.stdout, /submit-verdict/u);
  assert.match(help.stdout, /approve-gate/u);
});
test('CLI stable exits distinguish forbidden caller authority and unavailable authentication', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-cli-')), run = path.join(root, 'run'); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(cli('orchestrator-graph.mjs', ['init', path.join(fixtures, 'execution-graph-v2-valid.json'), run]).status, 0);
  const before = fs.readFileSync(path.join(run, 'events.jsonl'));
  const role = cli('orchestrator-graph.mjs', ['transition', run, 'worker', 'SUCCEEDED', '--actor-role', 'judge']); assert.equal(role.status, 2); assert.match(role.stderr, /CALLER_ROLE_AUTHORITY_FORBIDDEN/u);
  const auth = cli('orchestrator-graph.mjs', ['status', run, '--authenticated']); assert.equal(auth.status, 1); assert.match(auth.stderr, /AUTHENTICATION_UNAVAILABLE/u);
  assert.deepEqual(fs.readFileSync(path.join(run, 'events.jsonl')), before);
});

test('receipt CLIs consume Judge and Human workflow assertions exactly once', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-cli-receipts-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const judgeRun = path.join(root, 'judge-run'); assert.equal(cli('orchestrator-graph.mjs', ['init', path.join(fixtures, 'execution-graph-v2-valid.json'), judgeRun]).status, 0); fs.mkdirSync(path.join(judgeRun, 'artifacts')); fs.writeFileSync(path.join(judgeRun, 'artifacts', 'result.txt'), 'verified result\n');
  assert.equal(cli('orchestrator-graph.mjs', ['transition', judgeRun, 'worker', 'RUNNING']).status, 0); assert.equal(cli('orchestrator-graph.mjs', ['transition', judgeRun, 'worker', 'VERIFYING']).status, 0);
  const self = cli('orchestrator-graph.mjs', ['submit-verdict', judgeRun, path.join(fixtures, 'judge-receipt-builder-self-pass.json')]); assert.equal(self.status, 1); assert.match(self.stderr, /BUILDER_JUDGE_NOT_INDEPENDENT/u);
  const accepted = cli('orchestrator-graph.mjs', ['submit-verdict', judgeRun, path.join(fixtures, 'judge-receipt-valid.json')]); assert.equal(accepted.status, 0, accepted.stderr);
  const replay = cli('orchestrator-graph.mjs', ['submit-verdict', judgeRun, path.join(fixtures, 'judge-receipt-valid.json')]); assert.equal(replay.status, 1); assert.match(replay.stderr, /RECEIPT_REPLAY/u);

  const humanRun = path.join(root, 'human-run'); assert.equal(cli('orchestrator-graph.mjs', ['init', path.join(fixtures, 'execution-graph-v2-human-gate.json'), humanRun]).status, 0); fs.mkdirSync(path.join(humanRun, 'artifacts')); fs.writeFileSync(path.join(humanRun, 'artifacts', 'result.txt'), 'verified result\n');
  const human = cli('orchestrator-graph.mjs', ['approve-gate', humanRun, path.join(fixtures, 'human-approval-valid.json')]); assert.equal(human.status, 0, human.stderr);
  const humanReplay = cli('orchestrator-graph.mjs', ['approve-gate', humanRun, path.join(fixtures, 'human-approval-valid.json')]); assert.equal(humanReplay.status, 1); assert.match(humanReplay.stderr, /RECEIPT_REPLAY/u);
});
