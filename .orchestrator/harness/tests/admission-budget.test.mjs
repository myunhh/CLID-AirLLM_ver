import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AdmissionLedger, DIMENSIONS, hardContainmentCapability, launchBudgetedRunner } from '../lib/admission.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => path.join(here, 'fixtures', name);
const cap = { tokens: 10, toolCalls: 2, wallSeconds: 1, processes: 1 };
const containment = { wall: true, processTree: true };
const temporaryRoots = [];
function temporary() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-admission-')); temporaryRoots.push(root); return root; }
after(() => { for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true }); });
function ledger(root, capacity = cap) { return new AdmissionLedger({ runDir: path.join(root, 'run'), runId: path.basename(root), capacity, workspaceRoot: root }); }
const request = (childId, budget = cap) => ({ childId, budget, metadata: { kind: 'implementation' }, containment });

test('exact-cap records all dimensions and each one-over rejection records its dimension without reservation', async () => {
  for (const dimension of DIMENSIONS) {
    const root = temporary();
    const book = ledger(root);
    await book.reserve(request('exact'));
    const state = JSON.parse(fs.readFileSync(path.join(root, 'run', 'admission.json')));
    assert.deepEqual(state.reservations.exact.budget, cap);
    await book.release('exact', { tokens: 0, toolCalls: 0, wallSeconds: 0, processes: 0 });
    const over = { ...cap, [dimension]: cap[dimension] + 1 };
    await assert.rejects(book.reserve(request(`over-${dimension}`, over)), (error) => error.code === 'BUDGET_ADMISSION_EXCEEDED' && error.dimension === dimension);
    const after = JSON.parse(fs.readFileSync(path.join(root, 'run', 'admission.json')));
    assert.equal(after.reservations[`over-${dimension}`], undefined);
    const events = fs.readFileSync(path.join(root, 'run', 'events.jsonl'), 'utf8');
    assert.match(events, new RegExp(`"dimension":"${dimension}"`, 'u'));
  }
});

test('strict pre-consumption and missing containment reject before admission', async () => {
  const root = temporary();
  const book = ledger(root);
  await assert.rejects(book.reserve({ ...request('strict'), strictPreConsumption: true }), { code: 'UNSUPPORTED_HARD_BUDGET' });
  await assert.rejects(book.reserve({ ...request('unsafe'), containment: { wall: true } }), { code: 'CONTAINMENT_UNAVAILABLE' });
  assert.equal(fs.existsSync(path.join(root, 'run', 'admission.json')), false);
});

test('missing usage releases with explicit unknown values in state and canonical event', async () => {
  const root = temporary();
  const book = ledger(root);
  await book.reserve(request('missing-usage'));
  await book.releaseIncomplete('missing-usage');
  const state = JSON.parse(fs.readFileSync(path.join(root, 'run', 'admission.json')));
  assert.equal(state.reservations['missing-usage'].status, 'released');
  assert.equal(state.reservations['missing-usage'].usageComplete, false);
  assert.deepEqual(state.reservations['missing-usage'].usage, { tokens: 'unknown', toolCalls: 'unknown', wallSeconds: 'unknown', processes: 'unknown' });
  const events = fs.readFileSync(path.join(root, 'run', 'events.jsonl'), 'utf8').trim().split(/\r?\n/u).map((line) => JSON.parse(line));
  assert.equal(events.at(-1).data.usageComplete, false);
  assert.deepEqual(events.at(-1).data.usage, state.reservations['missing-usage'].usage);
  assert.doesNotMatch(JSON.stringify(events.at(-1).data.usage), /:0(?:[,}])/u);
});

test('wall timeout before usage records known wall overrun and unknown unobserved dimensions', async () => {
  const root = temporary();
  const book = ledger(root);
  await book.reserve(request('wall-before-usage'));
  await book.releaseWallTimeout('wall-before-usage', cap.wallSeconds + 1);
  const state = JSON.parse(fs.readFileSync(path.join(root, 'run', 'admission.json'))).reservations['wall-before-usage'];
  assert.equal(state.status, 'released');
  assert.equal(state.usageComplete, false);
  assert.deepEqual(state.usage, { tokens: 'unknown', toolCalls: 'unknown', wallSeconds: 2, processes: 'unknown' });
  assert.equal(state.outcome, 'bridge_budget_exceeded(wallSeconds)');
  const event = fs.readFileSync(path.join(root, 'run', 'events.jsonl'), 'utf8').trim().split(/\r?\n/u).map((line) => JSON.parse(line)).at(-1);
  assert.deepEqual(event.data.usage, state.usage);
  assert.equal(event.data.usageComplete, false);
  assert.equal(event.data.outcome, 'bridge_budget_exceeded(wallSeconds)');
  assert.doesNotMatch(JSON.stringify(event.data.usage), /:0(?:[,}])/u);
});

test('optional content-free usage details remain a sidecar to the four enforced dimensions', async () => {
  const root = temporary();
  const book = ledger(root);
  await book.reserve(request('details'));
  const usage = { tokens: 4, toolCalls: 1, wallSeconds: 0, processes: 1 };
  const details = { provider: 'codex', inputTokens: 4, cachedInputTokens: 3, uncachedInputTokens: 1, outputTokens: 1, requestedFast: true, observedFast: false };
  await book.release('details', usage, 'completed', details);
  const reservation = JSON.parse(fs.readFileSync(path.join(root, 'run', 'admission.json'))).reservations.details;
  assert.deepEqual(Object.keys(reservation.usage), DIMENSIONS);
  assert.deepEqual(reservation.usageDetails, { version: 1, ...details });
  assert.equal(Object.hasOwn(reservation.usageDetails, 'prompt'), false);
});

test('caller containment booleans and an unprobed provider candidate cannot bypass the public request-file surface', async () => {
  const root = temporary();
  const book = ledger(root);
  await book.reserve(request('fail-closed'));
  assert.equal(hardContainmentCapability().verified, false);
  assert.equal(hardContainmentCapability().requiresLiveProbe, true);
  await assert.rejects(launchBudgetedRunner({ ledger: book, reservation: { childId: 'fail-closed', budget: cap } }), { code: 'PUBLIC_REQUEST_FILE_REQUIRED' });
  const state = JSON.parse(fs.readFileSync(path.join(root, 'run', 'admission.json')));
  assert.equal(state.reservations['fail-closed'].status, 'released');
  assert.equal(state.reservations['fail-closed'].outcome, 'public_request_file_required');
});
