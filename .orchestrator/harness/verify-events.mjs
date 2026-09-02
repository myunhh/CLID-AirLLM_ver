#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalHash, sha256Bytes } from './lib/canonical-json.mjs';
import { EventStore, verifyEventChain } from './lib/event-store.mjs';

const HELP = `Usage: verify-events <run-dir|events.jsonl> [--family <auto|v2|controller-v1|bridge-v0>]
Verifies canonical v2 and read-only legacy event chains. Exit 0 is valid; exit 1 is invalid.`;
export class VerifyError extends Error { constructor(code) { super(code); this.code = code; } }
function fail(code) { throw new VerifyError(code); }
function parse(file) {
  if (!fs.existsSync(file)) fail('EVENT_LOG_NOT_FOUND'); const bytes = fs.readFileSync(file, 'utf8');
  if (!bytes) return { bytes: Buffer.from(''), events: [] }; if (!bytes.endsWith('\n')) fail('LEGACY_CHAIN_INVALID');
  try { return { bytes: Buffer.from(bytes), events: bytes.slice(0, -1).split('\n').map(JSON.parse) }; } catch { fail('LEGACY_CHAIN_INVALID'); }
}
export function eventFamily(events) {
  const families = new Set(events.map((event) => {
    if (event?.schemaVersion === 2) return 'v2';
    if (Object.hasOwn(event ?? {}, 'digest')) return 'bridge-v0';
    if (Object.hasOwn(event ?? {}, 'eventHash')) return 'controller-v1';
    return 'unknown';
  }));
  if (families.size > 1) fail('MIXED_EVENT_SCHEMA'); const family = [...families][0] ?? 'empty'; if (family === 'unknown') fail('LEGACY_CHAIN_INVALID'); return family;
}
function verifyController(events) {
  let previous = null;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]; if (event.seq !== index + 1 || event.prevEventHash !== previous || !/^[0-9a-f]{64}$/u.test(event.eventHash ?? '')) fail('LEGACY_CHAIN_INVALID');
    const { eventHash, ...body } = event; if (canonicalHash(body) !== eventHash) fail('LEGACY_CHAIN_INVALID'); previous = eventHash;
  }
  return previous;
}
function verifyBridge(events) {
  let previous = 'genesis';
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]; if (event.seq !== index + 1 || event.prevDigest !== previous || !/^[0-9a-f]{64}$/u.test(event.digest ?? '')) fail('LEGACY_CHAIN_INVALID');
    const { digest, ...body } = event; if (canonicalHash(body) !== digest) fail('LEGACY_CHAIN_INVALID'); previous = event.digest;
  }
  return previous;
}
export function verifyLog(logPath, options = {}) {
  const parsed = parse(logPath), family = eventFamily(parsed.events); if (options.family && options.family !== 'auto' && options.family !== family) fail('EVENT_FAMILY_MISMATCH');
  let tip;
  if (family === 'v2') tip = verifyEventChain(parsed.events, options.runId);
  else if (family === 'controller-v1') tip = { seq: parsed.events.length, eventHash: verifyController(parsed.events), runId: parsed.events[0]?.runId };
  else if (family === 'bridge-v0') tip = { seq: parsed.events.length, eventHash: verifyBridge(parsed.events), runId: parsed.events[0]?.runId };
  else tip = { seq: 0, eventHash: null, runId: options.runId };
  return { status: 'PASS', family, sourceDigest: sha256Bytes(parsed.bytes), sourceByteLength: parsed.bytes.length, ...tip };
}
export function verifyTarget(target, options = {}) {
  const resolved = path.resolve(target), stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    const log = path.join(resolved, 'events.jsonl'); const parsed = parse(log), family = eventFamily(parsed.events);
    if (family === 'v2') { const graphPath = path.join(resolved, 'execution-graph.json'); const runId = fs.existsSync(graphPath) ? JSON.parse(fs.readFileSync(graphPath, 'utf8')).runId : undefined; const replay = new EventStore({ runDir: resolved, runId }).replay(); return { status: 'PASS', family, seq: replay.seq, eventHash: replay.eventHash, runId: replay.runId }; }
    return verifyLog(log, options);
  }
  return verifyLog(resolved, options);
}
async function main(args) { if (!args.length || args.includes('--help')) { console.log(HELP); return; } const fi = args.indexOf('--family'); console.log(JSON.stringify(verifyTarget(args[0], { family: fi >= 0 ? args[fi + 1] : 'auto' }))); }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch((error) => { console.error(error.code ?? error.message); process.exitCode = 1; });
