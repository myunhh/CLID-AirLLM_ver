import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkMigration, migrate, recoverMigration } from '../migrate-events.mjs';
import { verifyTarget } from '../verify-events.mjs';
import { transition, status } from '../orchestrator-graph.mjs';

const fixtures = path.join(import.meta.dirname, 'fixtures');
const migrationCli = path.resolve(import.meta.dirname, '..', 'migrate-events.mjs');
function cli(args) { return spawnSync(process.execPath, [migrationCli, ...args], { encoding: 'utf8' }); }
function legacyRun(eventFixture = 'controller-v1-valid.events.jsonl') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-migration-')), run = path.join(root, 'run'); fs.mkdirSync(run);
  fs.copyFileSync(path.join(fixtures, eventFixture), path.join(run, 'events.jsonl'));
  const graph = JSON.parse(fs.readFileSync(path.join(fixtures, 'execution-graph-v1-legacy.json'), 'utf8'));
  if (eventFixture.startsWith('bridge-')) graph.runId = 'legacy-bridge-run';
  fs.writeFileSync(path.join(run, 'execution-graph.json'), `${JSON.stringify(graph)}\n`); return { root, run };
}
function inventory(run) { return fs.readdirSync(run).sort().map((name) => [name, fs.readFileSync(path.join(run, name)).toString('base64')]); }
function approval(check) { return { runId: check.runId, gateId: 'legacy-migration', actionDigest: check.actionDigest, gateNonce: 'migration-nonce-1' }; }
function withoutConsumption(items) { return items.filter(([name]) => name !== 'migration-consumption.json'); }

test('valid legacy families verify read-only; mixed and tampered families have stable IDs', async (t) => {
  for (const fixture of ['controller-v1-valid.events.jsonl', 'bridge-v0-valid.events.jsonl']) { const item = legacyRun(fixture); t.after(() => fs.rmSync(item.root, { recursive: true, force: true })); const verified = verifyTarget(item.run); assert.match(verified.family, /^(controller-v1|bridge-v0)$/u); assert.equal(status(item.run).legacyReadOnly, true); const before = inventory(item.run); await assert.rejects(transition(item.run, 'worker', 'RUNNING'), (e) => e.code === 'LEGACY_RUN_REQUIRES_MIGRATION'); assert.deepEqual(inventory(item.run), before); }
  for (const [fixture, code] of [['controller-v1-tampered.events.jsonl', 'LEGACY_CHAIN_INVALID'], ['bridge-v0-tampered.events.jsonl', 'LEGACY_CHAIN_INVALID'], ['mixed-controller-bridge-invalid.events.jsonl', 'MIXED_EVENT_SCHEMA']]) { const item = legacyRun(fixture); t.after(() => fs.rmSync(item.root, { recursive: true, force: true })); assert.throws(() => verifyTarget(item.run), (e) => e.code === code); }
});

test('--check is byte-read-only and missing approval makes zero writes', async (t) => {
  const { root, run } = legacyRun(); t.after(() => fs.rmSync(root, { recursive: true, force: true })); const before = inventory(run); const checked = checkMigration(run); assert.equal(checked.mode, 'check'); assert.deepEqual(inventory(run), before);
  await assert.rejects(migrate(run), (e) => e.code === 'MIGRATION_APPROVAL_REQUIRED'); assert.deepEqual(inventory(run), before);
});

test('invalid migration approval field substitutions make zero writes', async (t) => {
  const fields = [['runId', 'other', 'HUMAN_APPROVAL_RUN_ID_MISMATCH'], ['gateId', 'other', 'HUMAN_APPROVAL_GATE_ID_MISMATCH'], ['actionDigest', '0'.repeat(64), 'HUMAN_APPROVAL_ACTION_DIGEST_MISMATCH'], ['gateNonce', 'other', 'HUMAN_APPROVAL_GATE_NONCE_MISMATCH']];
  for (const [field, value, code] of fields) { const item = legacyRun(); t.after(() => fs.rmSync(item.root, { recursive: true, force: true })); const receipt = approval(checkMigration(item.run)); receipt[field] = value; const before = inventory(item.run); await assert.rejects(migrate(item.run, receipt), (e) => e.code === code); assert.deepEqual(inventory(item.run), before); }
});

test('injected pre-swap failure records recovery and recovery restores exact source', async (t) => {
  const { root, run } = legacyRun(); t.after(() => fs.rmSync(root, { recursive: true, force: true })); const checked = checkMigration(run), original = fs.readFileSync(path.join(run, 'events.jsonl'));
  await assert.rejects(migrate(run, approval(checked), { injectPreSwapFailure: true }), (e) => e.code === 'MIGRATION_RECOVERY_REQUIRED' && e.exitCode === 3);
  const marker = JSON.parse(fs.readFileSync(path.join(run, 'migration-recovery.json'), 'utf8')); assert.equal(marker.actionDigest, checked.actionDigest); assert.equal(marker.consumedNonce, 'migration-nonce-1');
  const recovered = recoverMigration(run); assert.equal(recovered.mode, 'recovered'); assert.deepEqual(fs.readFileSync(path.join(run, 'events.jsonl')), original); assert.equal(fs.existsSync(path.join(run, 'migration-recovery.json')), false); assert.equal(fs.existsSync(path.join(run, 'migration-consumption.json')), true);
  await assert.rejects(migrate(run, approval(checked)), (e) => e.code === 'RECEIPT_REPLAY');
});

test('every deterministic boundary recovers exact checkpoint presence and bytes without temp residue', async (t) => {
  for (const checkpointPresent of [false, true]) for (const boundary of ['recovery-marker', 'backup', 'event-swap', 'checkpoint-swap', 'manifest']) {
    const { root, run } = legacyRun(); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    if (checkpointPresent) fs.writeFileSync(path.join(run, 'checkpoint.json'), Buffer.from('legacy checkpoint exact bytes\r\n\0', 'utf8'));
    const original = inventory(run), checked = checkMigration(run);
    await assert.rejects(migrate(run, approval(checked), { injectFailureAt: boundary }), (e) => e.code === 'MIGRATION_RECOVERY_REQUIRED' && e.exitCode === 3);
    const marker = JSON.parse(fs.readFileSync(path.join(run, 'migration-recovery.json'), 'utf8'));
    assert.equal(marker.sourceCheckpoint.present, checkpointPresent); if (checkpointPresent) { const bytes = Buffer.from(original.find(([name]) => name === 'checkpoint.json')[1], 'base64'); assert.equal(marker.sourceCheckpoint.byteLength, bytes.length); assert.equal(Buffer.from(marker.sourceCheckpoint.bytesBase64, 'base64').equals(bytes), true); }
    if (boundary === 'recovery-marker') { if (checkpointPresent) fs.writeFileSync(path.join(run, 'checkpoint.json'), 'interrupted checkpoint bytes'); else fs.writeFileSync(path.join(run, 'checkpoint.json'), 'unexpected migrated checkpoint'); }
    recoverMigration(run);
    assert.deepEqual(withoutConsumption(inventory(run)), original, `${boundary}, checkpoint=${checkpointPresent}`);
    assert.equal(fs.readdirSync(run).some((name) => /(?:\.tmp|\.restore|^\.migration\.)/u.test(name)), false);
    await assert.rejects(migrate(run, approval(checked)), (e) => e.code === 'RECEIPT_REPLAY');
  }
});

test('approved migration retains exact legacy bytes, records bound approval, verifies v2, and cannot replay', async (t) => {
  const { root, run } = legacyRun(); t.after(() => fs.rmSync(root, { recursive: true, force: true })); const checked = checkMigration(run), original = fs.readFileSync(path.join(run, 'events.jsonl'));
  const result = await migrate(run, approval(checked)); assert.equal(result.mode, 'migrated'); assert.deepEqual(fs.readFileSync(path.join(run, 'events.legacy-v1.jsonl')), original);
  const verified = verifyTarget(run); assert.equal(verified.family, 'v2'); assert.equal(verified.seq, 3);
  const events = fs.readFileSync(path.join(run, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); const approvalEvent = events.filter((e) => e.type === 'human_approval_recorded'); assert.equal(approvalEvent.length, 1); assert.equal(approvalEvent[0].data.actionDigest, checked.actionDigest); assert.equal(approvalEvent[0].data.gateNonce, 'migration-nonce-1');
  await assert.rejects(migrate(run, approval(checked)), (e) => e.code === 'RECEIPT_REPLAY');
});

test('migration CLI exposes exact 0/1/3 exit contract and stable IDs', (t) => {
  const first = legacyRun(); t.after(() => fs.rmSync(first.root, { recursive: true, force: true }));
  const checked = cli([first.run, '--check']); assert.equal(checked.status, 0, checked.stderr); const check = JSON.parse(checked.stdout);
  const before = inventory(first.run), missing = cli([first.run]); assert.equal(missing.status, 1); assert.match(missing.stderr, /MIGRATION_APPROVAL_REQUIRED/u); assert.deepEqual(inventory(first.run), before);
  const receiptFile = path.join(first.root, 'approval.json'); fs.writeFileSync(receiptFile, JSON.stringify(approval(check)));
  const injected = cli([first.run, '--approval', receiptFile, '--inject-pre-swap-failure']); assert.equal(injected.status, 3); assert.match(injected.stderr, /MIGRATION_RECOVERY_REQUIRED/u);
  const recovered = cli([first.run, '--recover']); assert.equal(recovered.status, 0, recovered.stderr);
  const replay = cli([first.run, '--approval', receiptFile]); assert.equal(replay.status, 1); assert.match(replay.stderr, /RECEIPT_REPLAY/u);

  const second = legacyRun(); t.after(() => fs.rmSync(second.root, { recursive: true, force: true })); const secondCheck = JSON.parse(cli([second.run, '--check']).stdout); const secondReceipt = path.join(second.root, 'approval.json'); fs.writeFileSync(secondReceipt, JSON.stringify(approval(secondCheck)));
  const migrated = cli([second.run, '--approval', secondReceipt]); assert.equal(migrated.status, 0, migrated.stderr); assert.equal(verifyTarget(second.run).family, 'v2');
});
