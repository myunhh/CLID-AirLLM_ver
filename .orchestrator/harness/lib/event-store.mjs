import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { canonicalHash, canonicalJson, sha256Bytes } from './canonical-json.mjs';

const ZERO_HASH = '0'.repeat(64);
const HASH_PATTERN = /^[0-9a-f]{64}$/u;
const RFC3339_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/u;
const PROMPT_KEYS = new Set(['prompt', 'rawPrompt']);
const REPLY_KEYS = new Set(['reply', 'rawReply', 'output', 'content', 'message', 'text']);

export class EventStoreError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'EventStoreError';
    this.code = code;
  }
}

function fail(code) {
  throw new EventStoreError(code);
}

function forbiddenKey(value, seen = new Set()) {
  if (!value || typeof value !== 'object') return null;
  if (seen.has(value)) fail('EVENT_DATA_CYCLE');
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (PROMPT_KEYS.has(key)) return 'RAW_PROMPT_EVENT_FORBIDDEN';
    if (REPLY_KEYS.has(key)) return 'RAW_REPLY_EVENT_FORBIDDEN';
    const nested = forbiddenKey(child, seen);
    if (nested) return nested;
  }
  seen.delete(value);
  return null;
}

function validateBaseInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('EVENT_INPUT_INVALID');
  for (const key of ['runId', 'type', 'producer', 'authority']) {
    if (typeof input[key] !== 'string' || input[key].length === 0) fail(`EVENT_${key.toUpperCase()}_INVALID`);
  }
  if (!input.data || typeof input.data !== 'object' || Array.isArray(input.data)) fail('EVENT_DATA_INVALID');
  const forbidden = forbiddenKey(input.data);
  if (forbidden) fail(forbidden);
  canonicalJson(input.data);
}

function confinedArtifact(runDir, reference) {
  if (typeof reference !== 'string' || reference.length === 0 || reference.includes('\0') || path.isAbsolute(reference)) return null;
  const absolute = path.resolve(runDir, reference);
  const relative = path.relative(runDir, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  let real;
  try {
    real = fs.realpathSync.native(absolute);
  } catch {
    return null;
  }
  const realRelative = path.relative(fs.realpathSync.native(runDir), real);
  if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) return null;
  return real;
}

function validateArtifact(data, runDir, kind) {
  const digestKey = `${kind}Digest`;
  const refKey = `${kind}ArtifactRef`;
  const prefix = kind.toUpperCase();
  if (!HASH_PATTERN.test(data[digestKey] ?? '')) fail(`${prefix}_DIGEST_MISSING`);
  if (typeof data[refKey] !== 'string' || data[refKey].length === 0) fail(`${prefix}_ARTIFACT_REF_MISSING`);
  const artifact = confinedArtifact(runDir, data[refKey]);
  if (!artifact) fail(`${prefix}_ARTIFACT_REF_INVALID`);
  if (sha256Bytes(fs.readFileSync(artifact)) !== data[digestKey]) fail(`${prefix}_ARTIFACT_DIGEST_MISMATCH`);
}

function validateConfidentiality(input, runDir) {
  const normalizedType = input.type.toLocaleLowerCase('en-US');
  if (/(?:^|_)prompt(?:_|$)/u.test(normalizedType)) validateArtifact(input.data, runDir, 'prompt');
  if (/(?:^|_)reply(?:_|$)/u.test(normalizedType)) validateArtifact(input.data, runDir, 'reply');
}

function validateStoredEvent(event, expectedSeq, expectedPrev, expectedRunId) {
  const exactKeys = ['schemaVersion', 'seq', 'runId', 'type', 'timestamp', 'producer', 'authority', 'data', 'prevEventHash', 'eventHash'];
  if (!event || typeof event !== 'object' || Array.isArray(event)) fail('EVENT_SCHEMA_INVALID');
  if (Object.keys(event).sort().join('\0') !== [...exactKeys].sort().join('\0')) fail('EVENT_SCHEMA_INVALID');
  if (event.schemaVersion !== 2 || !Number.isSafeInteger(event.seq) || event.seq !== expectedSeq) fail('EVENT_SEQUENCE_INVALID');
  if (expectedRunId !== undefined && event.runId !== expectedRunId) fail('EVENT_RUN_ID_MISMATCH');
  if (![event.runId, event.type, event.timestamp, event.producer, event.authority].every((v) => typeof v === 'string' && v.length > 0)) fail('EVENT_SCHEMA_INVALID');
  if (!RFC3339_PATTERN.test(event.timestamp) || Number.isNaN(Date.parse(event.timestamp))) fail('EVENT_TIMESTAMP_INVALID');
  if (!event.data || typeof event.data !== 'object' || Array.isArray(event.data)) fail('EVENT_SCHEMA_INVALID');
  if (forbiddenKey(event.data)) fail('EVENT_CONFIDENTIALITY_INVALID');
  if (event.prevEventHash !== expectedPrev) fail('EVENT_PREDECESSOR_INVALID');
  if (!HASH_PATTERN.test(event.eventHash)) fail('EVENT_HASH_INVALID');
  const { eventHash, ...hashable } = event;
  if (canonicalHash(hashable) !== eventHash) fail('EVENT_HASH_INVALID');
}

export function verifyEventChain(events, expectedRunId) {
  let previous = ZERO_HASH;
  let runId = expectedRunId;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (runId === undefined) runId = event.runId;
    validateStoredEvent(event, index + 1, previous, runId);
    previous = event.eventHash;
  }
  return { count: events.length, seq: events.length, eventHash: previous, runId };
}

function parseLog(logPath) {
  if (!fs.existsSync(logPath)) return [];
  const bytes = fs.readFileSync(logPath, 'utf8');
  if (bytes.length === 0) return [];
  if (!bytes.endsWith('\n')) fail('EVENT_LOG_TRUNCATED');
  return bytes.slice(0, -1).split('\n').map((line) => {
    try { return JSON.parse(line); } catch { fail('EVENT_LOG_INVALID_JSON'); }
  });
}

async function acquire(lockPath, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fs.mkdirSync(lockPath);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline) fail('EVENT_LOCK_TIMEOUT');
      await delay(10);
    }
  }
}

function atomicWrite(file, bytes) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, bytes, { flag: 'wx' });
  fs.renameSync(temporary, file);
}

export class EventStore {
  constructor(options) {
    if (!options || typeof options.runDir !== 'string' || options.runDir.length === 0) fail('EVENT_STORE_OPTIONS_INVALID');
    this.runDir = path.resolve(options.runDir);
    this.runId = options.runId;
    this.logPath = path.join(this.runDir, options.logName ?? 'events.jsonl');
    this.checkpointPath = path.join(this.runDir, options.checkpointName ?? 'checkpoint.json');
    this.lockPath = path.join(this.runDir, options.lockName ?? '.events.lock');
    this.lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
  }

  replay() {
    const events = parseLog(this.logPath);
    const tip = verifyEventChain(events, this.runId);
    if (fs.existsSync(this.checkpointPath)) {
      let checkpoint;
      try { checkpoint = JSON.parse(fs.readFileSync(this.checkpointPath, 'utf8')); } catch { fail('EVENT_CHECKPOINT_INVALID'); }
      if (checkpoint.schemaVersion !== 2 || checkpoint.seq !== tip.seq || checkpoint.eventHash !== tip.eventHash || checkpoint.runId !== tip.runId) {
        fail('EVENT_CHECKPOINT_MISMATCH');
      }
    }
    return { events, ...tip };
  }

  async append(input) {
    validateBaseInput(input);
    if (this.runId !== undefined && input.runId !== this.runId) fail('EVENT_RUN_ID_MISMATCH');
    validateConfidentiality(input, this.runDir);
    fs.mkdirSync(this.runDir, { recursive: true });
    await acquire(this.lockPath, this.lockTimeoutMs);
    try {
      const current = this.replay();
      if (current.count > 0 && current.runId !== input.runId) fail('EVENT_RUN_ID_MISMATCH');
      const event = {
        schemaVersion: 2,
        seq: current.seq + 1,
        runId: input.runId,
        type: input.type,
        timestamp: input.timestamp ?? new Date().toISOString(),
        producer: input.producer,
        authority: input.authority,
        data: input.data,
        prevEventHash: current.eventHash,
      };
      event.eventHash = canonicalHash(event);
      validateStoredEvent(event, event.seq, current.eventHash, this.runId ?? input.runId);
      fs.appendFileSync(this.logPath, `${canonicalJson(event)}\n`, { encoding: 'utf8', flag: 'a' });
      atomicWrite(this.checkpointPath, `${canonicalJson({ schemaVersion: 2, runId: event.runId, seq: event.seq, eventHash: event.eventHash })}\n`);
      return event;
    } finally {
      fs.rmdirSync(this.lockPath);
    }
  }
}

export const EMPTY_EVENT_HASH = ZERO_HASH;
