import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { canonicalHash, sha256Bytes } from '../lib/canonical-json.mjs';
import { EventStore, EventStoreError } from '../lib/event-store.mjs';

const execFileAsync = promisify(execFile);

function temporaryDirectory(t, name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `ecc-a-${name}-`));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function input(index, overrides = {}) {
  return {
    runId: 'run-a',
    type: 'worker_observed',
    producer: `worker-${index}`,
    authority: 'workflow_assertion',
    data: { index, nested: { ok: true } },
    ...overrides,
  };
}

function expectCode(code) {
  return (error) => error instanceof EventStoreError && error.code === code;
}

test('concurrent append allocates one gapless monotonic sequence and one hash chain', async (t) => {
  const runDir = temporaryDirectory(t, 'concurrency');
  const stores = Array.from({ length: 32 }, () => new EventStore({ runDir, runId: 'run-a' }));
  const events = await Promise.all(stores.map((store, index) => store.append(input(index))));
  assert.deepEqual(events.map((event) => event.seq).sort((a, b) => a - b), Array.from({ length: 32 }, (_, index) => index + 1));
  const replay = stores[0].replay();
  assert.equal(replay.count, 32);
  assert.deepEqual(replay.events.map((event) => event.seq), Array.from({ length: 32 }, (_, index) => index + 1));
  assert.equal(new Set(replay.events.map((event) => event.eventHash)).size, 32);
  assert.equal(fs.existsSync(path.join(runDir, '.events.lock')), false);
});

test('independent processes serialize concurrent append under the filesystem lock', async (t) => {
  const runDir = temporaryDirectory(t, 'multiprocess');
  const moduleUrl = new URL('../lib/event-store.mjs', import.meta.url).href;
  const program = `import { EventStore } from ${JSON.stringify(moduleUrl)};
const [runDir, index] = process.argv.slice(1);
const store = new EventStore({ runDir, runId: 'run-multiprocess' });
await store.append({ runId: 'run-multiprocess', type: 'worker_observed', producer: 'child-' + index, authority: 'workflow_assertion', data: { index: Number(index) } });`;
  await Promise.all(Array.from({ length: 12 }, (_, index) => execFileAsync(process.execPath, ['--input-type=module', '-e', program, runDir, String(index)])));
  const replay = new EventStore({ runDir, runId: 'run-multiprocess' }).replay();
  assert.equal(replay.count, 12);
  assert.deepEqual(replay.events.map((event) => event.seq), Array.from({ length: 12 }, (_, index) => index + 1));
  assert.equal(fs.existsSync(path.join(runDir, '.events.lock')), false);
});

test('canonical hashing ignores object key insertion order but retains array order', () => {
  assert.equal(canonicalHash({ z: 1, a: { y: 2, x: 3 } }), canonicalHash({ a: { x: 3, y: 2 }, z: 1 }));
  assert.notEqual(canonicalHash({ values: [1, 2] }), canonicalHash({ values: [2, 1] }));
});

for (const tamper of [
  ['content', (event) => { event.data.index = 999; }, 'EVENT_HASH_INVALID'],
  ['sequence', (event) => { event.seq += 1; }, 'EVENT_SEQUENCE_INVALID'],
  ['predecessor', (event) => { event.prevEventHash = 'f'.repeat(64); event.eventHash = canonicalHash(Object.fromEntries(Object.entries(event).filter(([key]) => key !== 'eventHash'))); }, 'EVENT_PREDECESSOR_INVALID'],
]) {
  test(`${tamper[0]} tampering is detected`, async (t) => {
    const runDir = temporaryDirectory(t, `tamper-${tamper[0]}`);
    const store = new EventStore({ runDir, runId: 'run-a' });
    await store.append(input(1));
    await store.append(input(2));
    const logPath = path.join(runDir, 'events.jsonl');
    const lines = fs.readFileSync(logPath, 'utf8').trimEnd().split('\n').map(JSON.parse);
    tamper[1](lines[1]);
    fs.writeFileSync(logPath, `${lines.map(JSON.stringify).join('\n')}\n`);
    assert.throws(() => store.replay(), expectCode(tamper[2]));
  });
}

test('raw prompt and reply keys reject recursively before any run artifact exists', async (t) => {
  const parent = temporaryDirectory(t, 'raw');
  for (const [name, data, code] of [
    ['prompt', { nested: { prompt: 'unique-secret-prompt' } }, 'RAW_PROMPT_EVENT_FORBIDDEN'],
    ['rawPrompt', { rawPrompt: 'unique-secret-prompt' }, 'RAW_PROMPT_EVENT_FORBIDDEN'],
    ['reply', { nested: { reply: 'unique-secret-reply' } }, 'RAW_REPLY_EVENT_FORBIDDEN'],
    ['output', { output: 'unique-secret-reply' }, 'RAW_REPLY_EVENT_FORBIDDEN'],
    ['content', { content: 'unique-secret-reply' }, 'RAW_REPLY_EVENT_FORBIDDEN'],
    ['message', { message: 'unique-secret-reply' }, 'RAW_REPLY_EVENT_FORBIDDEN'],
    ['text', { nested: { text: 'unique-secret-reply' } }, 'RAW_REPLY_EVENT_FORBIDDEN'],
  ]) {
    const runDir = path.join(parent, name);
    const store = new EventStore({ runDir, runId: 'run-a' });
    await assert.rejects(store.append(input(1, { data })), expectCode(code));
    assert.equal(fs.existsSync(runDir), false, `${name} rejection created an artifact`);
  }
});

test('prompt and reply events bind confined artifacts by exact byte digest', async (t) => {
  const runDir = temporaryDirectory(t, 'artifacts');
  const artifactDir = path.join(runDir, 'artifacts');
  fs.mkdirSync(artifactDir);
  const promptBytes = Buffer.from('prompt\r\nexact bytes', 'utf8');
  const replyBytes = Buffer.from([0, 1, 2, 255]);
  fs.writeFileSync(path.join(artifactDir, 'prompt.bin'), promptBytes);
  fs.writeFileSync(path.join(artifactDir, 'reply.bin'), replyBytes);
  const store = new EventStore({ runDir, runId: 'run-a' });
  await store.append(input(1, {
    type: 'bridge_prompt_recorded',
    data: { promptDigest: sha256Bytes(promptBytes), promptArtifactRef: 'artifacts/prompt.bin' },
  }));
  await store.append(input(2, {
    type: 'bridge_reply_recorded',
    data: { replyDigest: sha256Bytes(replyBytes), replyArtifactRef: 'artifacts/reply.bin', usage: { tokens: 3 } },
  }));
  const serialized = fs.readFileSync(path.join(runDir, 'events.jsonl'), 'utf8') + fs.readFileSync(path.join(runDir, 'checkpoint.json'), 'utf8');
  assert.equal(serialized.includes('prompt\r\nexact bytes'), false);
  assert.equal(serialized.includes('unique-secret-reply'), false);
  assert.equal(store.replay().count, 2);
});

test('missing, escaping, absent, and mismatched prompt/reply artifacts append nothing', async (t) => {
  const runDir = temporaryDirectory(t, 'artifact-reject');
  const outside = path.join(temporaryDirectory(t, 'outside'), 'outside.bin');
  fs.writeFileSync(outside, 'outside');
  const store = new EventStore({ runDir, runId: 'run-a' });
  const cases = [
    ['prompt_missing_digest', 'bridge_prompt_recorded', { promptArtifactRef: 'x' }, 'PROMPT_DIGEST_MISSING'],
    ['prompt_missing_ref', 'bridge_prompt_recorded', { promptDigest: 'a'.repeat(64) }, 'PROMPT_ARTIFACT_REF_MISSING'],
    ['prompt_escape', 'bridge_prompt_recorded', { promptDigest: sha256Bytes('outside'), promptArtifactRef: path.relative(runDir, outside) }, 'PROMPT_ARTIFACT_REF_INVALID'],
    ['prompt_mismatch', 'bridge_prompt_recorded', { promptDigest: 'a'.repeat(64), promptArtifactRef: 'inside.bin' }, 'PROMPT_ARTIFACT_DIGEST_MISMATCH'],
    ['reply_missing_digest', 'bridge_reply_recorded', { replyArtifactRef: 'x' }, 'REPLY_DIGEST_MISSING'],
    ['reply_missing_ref', 'bridge_reply_recorded', { replyDigest: 'a'.repeat(64) }, 'REPLY_ARTIFACT_REF_MISSING'],
    ['reply_absent', 'bridge_reply_recorded', { replyDigest: 'a'.repeat(64), replyArtifactRef: 'absent.bin' }, 'REPLY_ARTIFACT_REF_INVALID'],
  ];
  fs.writeFileSync(path.join(runDir, 'inside.bin'), 'inside');
  for (const [name, type, data, code] of cases) {
    const before = fs.readdirSync(runDir).sort();
    await assert.rejects(store.append(input(1, { type, data })), expectCode(code), name);
    assert.deepEqual(fs.readdirSync(runDir).sort(), before, `${name} changed artifacts`);
    assert.equal(fs.existsSync(path.join(runDir, 'events.jsonl')), false);
    assert.equal(fs.existsSync(path.join(runDir, 'checkpoint.json')), false);
    assert.equal(fs.existsSync(path.join(runDir, '.events.lock')), false);
  }
});
