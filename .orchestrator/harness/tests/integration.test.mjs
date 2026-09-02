import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { initRun, status, transition } from '../orchestrator-graph.mjs';
import { verifyTarget } from '../verify-events.mjs';

test('controller and Bridge use one v2 chain, monotonic sequence, and canonical verifier', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-integration-')), run = path.join(root, 'run'); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await initRun(path.join(import.meta.dirname, 'fixtures', 'execution-graph-v2-valid.json'), run);
  await transition(run, 'worker', 'RUNNING');
  const request = { runDir: run, runId: 'fixture-v2-run', workspaceRoot: root, capacity: { tokens: 100, toolCalls: 10, wallSeconds: 60, processes: 2 }, childId: 'bridge-dry-run', budget: { tokens: 10, toolCalls: 2, wallSeconds: 5, processes: 1 }, metadata: { kind: 'read_only_evidence' }, owns: [], containment: { wall: true, processTree: true } };
  const requestFile = path.join(root, 'bridge-request.json'); fs.writeFileSync(requestFile, JSON.stringify(request));
  const launched = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '..', 'bridge-launcher.mjs'), 'admit', '--request-file', requestFile], { encoding: 'utf8' });
  assert.equal(launched.status, 0, launched.stderr); assert.deepEqual({ dryRun: JSON.parse(launched.stdout).dryRun, launched: JSON.parse(launched.stdout).launched }, { dryRun: true, launched: false });
  const current = status(run); assert.equal(current.seq, 4);
  const verified = verifyTarget(run); assert.equal(verified.family, 'v2'); assert.equal(verified.seq, 4); assert.equal(verified.eventHash, current.eventHash);
  const events = fs.readFileSync(path.join(run, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse); assert.deepEqual(events.map((event) => event.seq), [1, 2, 3, 4]); assert.deepEqual(events.slice(2).map((event) => event.type), ['bridge_admitted', 'bridge_reservation_released']);
});

test('generic protected transition and claimed authentication reject without append', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-integration-')), run = path.join(root, 'run'); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await initRun(path.join(import.meta.dirname, 'fixtures', 'execution-graph-v2-valid.json'), run); const before = fs.readFileSync(path.join(run, 'events.jsonl'));
  await assert.rejects(transition(run, 'worker', 'SUCCEEDED', { actorRole: 'judge' }), (e) => e.code === 'CALLER_ROLE_AUTHORITY_FORBIDDEN');
  await assert.rejects(transition(run, 'worker', 'RUNNING', { authenticated: true }), (e) => e.code === 'AUTHENTICATION_UNAVAILABLE');
  assert.deepEqual(fs.readFileSync(path.join(run, 'events.jsonl')), before);
});
