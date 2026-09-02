#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalHash, canonicalJson, sha256Bytes } from './lib/canonical-json.mjs';
import { EventStore } from './lib/event-store.mjs';
import { validateHumanApproval } from './lib/authority.mjs';
import { verifyTarget } from './verify-events.mjs';

const HELP = `Usage: migrate-events <run-dir> --check
       migrate-events <run-dir> --approval <human-approval.json> [--inject-pre-swap-failure]
       migrate-events <run-dir> --recover
Migration is never automatic. --check is read-only; mutation requires a bound Human approval.`;
export class MigrationError extends Error { constructor(code, exitCode = 1) { super(code); this.code = code; this.exitCode = exitCode; } }
function fail(code, exitCode = 1) { throw new MigrationError(code, exitCode); }
function atomicWrite(file, bytes) { const temporary = `${file}.${process.pid}.tmp`; try { fs.writeFileSync(temporary, bytes, { flag: 'wx' }); fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.rmSync(temporary); } }
function readJson(file, code) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail(code); } }
function pathsOf(runDir) { const dir = path.resolve(runDir); return { dir, source: path.join(dir, 'events.jsonl'), graph: path.join(dir, 'execution-graph.json'), checkpoint: path.join(dir, 'checkpoint.json'), marker: path.join(dir, 'migration-recovery.json'), consumed: path.join(dir, 'migration-consumption.json'), backup: path.join(dir, 'events.legacy-v1.jsonl'), legacyCheckpoint: path.join(dir, 'checkpoint.legacy.json'), stagingLog: path.join(dir, '.migration.events.jsonl'), stagingCheckpoint: path.join(dir, '.migration.checkpoint.json'), manifest: path.join(dir, 'migration-manifest.json') }; }
export function migrationAction(runId, gateId, sourceFamily, sourceLogDigest) { return { action: 'migrate_events', runId, gateId, sourceSchemaFamily: sourceFamily, sourceLogDigest, targetSchemaVersion: 2 }; }
export function migrationActionDigest(runId, gateId, sourceFamily, sourceLogDigest) { return canonicalHash(migrationAction(runId, gateId, sourceFamily, sourceLogDigest)); }
function metadata(files) {
  const verified = verifyTarget(files.dir); if (verified.family === 'v2') fail(fs.existsSync(files.manifest) ? 'RECEIPT_REPLAY' : 'RUN_ALREADY_V2');
  if (!['controller-v1', 'bridge-v0'].includes(verified.family)) fail(verified.family === 'mixed' ? 'MIXED_EVENT_SCHEMA' : 'LEGACY_CHAIN_INVALID');
  const graph = readJson(files.graph, 'LEGACY_GRAPH_INVALID'), runId = graph.runId ?? verified.runId, gate = graph.migrationGate;
  if (typeof runId !== 'string' || !runId || !gate || typeof gate.id !== 'string' || !gate.id || typeof gate.gateNonce !== 'string' || !gate.gateNonce) fail('LEGACY_GRAPH_INVALID');
  return { verified, graph, runId, gate, actionDigest: migrationActionDigest(runId, gate.id, verified.family, verified.sourceDigest) };
}
function preflight(files) { for (const file of [files.marker, files.consumed, files.backup, files.legacyCheckpoint, files.stagingLog, files.stagingCheckpoint, files.manifest]) if (fs.existsSync(file)) fail('MIGRATION_ARTIFACT_EXISTS'); }
export function checkMigration(runDir) { const files = pathsOf(runDir), meta = metadata(files); return { status: 'PASS', mode: 'check', runId: meta.runId, sourceFamily: meta.verified.family, sourceLogDigest: meta.verified.sourceDigest, actionDigest: meta.actionDigest }; }
export function recoverMigration(runDir) {
  const files = pathsOf(runDir); if (!fs.existsSync(files.marker)) fail('MIGRATION_RECOVERY_NOT_FOUND'); const marker = readJson(files.marker, 'MIGRATION_RECOVERY_INVALID');
  if (fs.existsSync(files.backup)) {
    const bytes = fs.readFileSync(files.backup); if (sha256Bytes(bytes) !== marker.sourceLogDigest) fail('MIGRATION_RECOVERY_INVALID', 3);
    const temporary = `${files.source}.${process.pid}.restore`; fs.writeFileSync(temporary, bytes, { flag: 'wx' }); fs.renameSync(temporary, files.source);
  } else if (!fs.existsSync(files.source) || sha256Bytes(fs.readFileSync(files.source)) !== marker.sourceLogDigest) fail('MIGRATION_RECOVERY_INVALID', 3);
  const checkpoint = marker.sourceCheckpoint;
  if (!checkpoint || typeof checkpoint.present !== 'boolean') fail('MIGRATION_RECOVERY_INVALID', 3);
  if (checkpoint.present) {
    if (!Number.isSafeInteger(checkpoint.byteLength) || checkpoint.byteLength < 0 || !/^[0-9a-f]{64}$/u.test(checkpoint.digest ?? '') || typeof checkpoint.bytesBase64 !== 'string') fail('MIGRATION_RECOVERY_INVALID', 3);
    const recordedBytes = Buffer.from(checkpoint.bytesBase64, 'base64');
    if (recordedBytes.length !== checkpoint.byteLength || sha256Bytes(recordedBytes) !== checkpoint.digest) fail('MIGRATION_RECOVERY_INVALID', 3);
    if (fs.existsSync(files.legacyCheckpoint)) {
      const bytes = fs.readFileSync(files.legacyCheckpoint); if (bytes.length !== checkpoint.byteLength || sha256Bytes(bytes) !== checkpoint.digest) fail('MIGRATION_RECOVERY_INVALID', 3);
      atomicWrite(files.checkpoint, bytes);
    } else atomicWrite(files.checkpoint, recordedBytes);
  } else if (fs.existsSync(files.checkpoint)) fs.rmSync(files.checkpoint);
  for (const file of [files.stagingLog, files.stagingCheckpoint, files.manifest, files.backup, files.legacyCheckpoint]) if (fs.existsSync(file)) fs.rmSync(file);
  fs.renameSync(files.marker, files.consumed);
  return { status: 'PASS', mode: 'recovered', sourceLogDigest: marker.sourceLogDigest };
}
export async function migrate(runDir, receiptInput, options = {}) {
  const files = pathsOf(runDir); const meta = metadata(files);
  if (!receiptInput) fail('MIGRATION_APPROVAL_REQUIRED');
  const receipt = typeof receiptInput === 'string' ? readJson(receiptInput, 'HUMAN_APPROVAL_INVALID') : receiptInput;
  const prior = fs.existsSync(files.marker) ? readJson(files.marker, 'MIGRATION_RECOVERY_INVALID') : (fs.existsSync(files.consumed) ? readJson(files.consumed, 'MIGRATION_RECOVERY_INVALID') : null);
  const valid = validateHumanApproval(receipt, { runId: meta.runId, gateId: meta.gate.id, actionDigest: meta.actionDigest, gateNonce: meta.gate.gateNonce, consumedNonces: new Set(prior ? [prior.consumedNonce] : []), consumedReceiptDigests: new Set(prior ? [prior.receiptDigest] : []) });
  // Revalidate after receipt parsing and before the first write.
  const second = metadata(files); if (second.verified.sourceDigest !== meta.verified.sourceDigest || second.actionDigest !== meta.actionDigest) fail('LEGACY_CHAIN_INVALID');
  preflight(files);
  const checkpointBytes = fs.existsSync(files.checkpoint) ? fs.readFileSync(files.checkpoint) : null;
  const sourceCheckpoint = checkpointBytes === null ? { present: false } : { present: true, byteLength: checkpointBytes.length, digest: sha256Bytes(checkpointBytes), bytesBase64: checkpointBytes.toString('base64') };
  const marker = { schemaVersion: 1, runId: meta.runId, sourceFamily: meta.verified.family, sourceLogDigest: meta.verified.sourceDigest, sourceByteLength: meta.verified.sourceByteLength, sourceCheckpoint, actionDigest: meta.actionDigest, receiptDigest: valid.receiptDigest, consumedNonce: valid.gateNonce };
  atomicWrite(files.marker, `${canonicalJson(marker)}\n`);
  if (options.injectPreSwapFailure || options.injectFailureAt === 'recovery-marker') fail('MIGRATION_RECOVERY_REQUIRED', 3);
  try {
    fs.copyFileSync(files.source, files.backup, fs.constants.COPYFILE_EXCL);
    if (sha256Bytes(fs.readFileSync(files.backup)) !== meta.verified.sourceDigest) fail('MIGRATION_BACKUP_INVALID', 3);
    if (fs.existsSync(files.checkpoint)) fs.copyFileSync(files.checkpoint, files.legacyCheckpoint, fs.constants.COPYFILE_EXCL);
    if (options.injectFailureAt === 'backup') fail('MIGRATION_RECOVERY_REQUIRED', 3);
    const store = new EventStore({ runDir: files.dir, runId: meta.runId, logName: path.basename(files.stagingLog), checkpointName: path.basename(files.stagingCheckpoint), lockName: '.migration.events.lock' });
    await store.append({ runId: meta.runId, type: 'run_initialized', producer: 'migrate-events', authority: 'workflow_assertion', data: { migratedFrom: meta.verified.family, sourceLogDigest: meta.verified.sourceDigest } });
    await store.append({ runId: meta.runId, type: 'human_approval_recorded', producer: 'human-workflow', authority: 'workflow_assertion', data: { gateId: valid.gateId, actionDigest: valid.actionDigest, gateNonce: valid.gateNonce, receiptDigest: valid.receiptDigest } });
    await store.append({ runId: meta.runId, type: 'legacy_events_migrated', producer: 'migrate-events', authority: 'workflow_assertion', data: { sourceFamily: meta.verified.family, sourceLogDigest: meta.verified.sourceDigest, sourceByteLength: meta.verified.sourceByteLength, legacyEventCount: meta.verified.seq } });
    fs.renameSync(files.stagingLog, files.source);
    if (options.injectFailureAt === 'event-swap') fail('MIGRATION_RECOVERY_REQUIRED', 3);
    fs.renameSync(files.stagingCheckpoint, files.checkpoint);
    if (options.injectFailureAt === 'checkpoint-swap') fail('MIGRATION_RECOVERY_REQUIRED', 3);
    const target = verifyTarget(files.dir);
    const manifest = { schemaVersion: 1, runId: meta.runId, sourceFamily: meta.verified.family, sourceLogDigest: meta.verified.sourceDigest, sourceCheckpoint: checkpointBytes === null ? { present: false } : { present: true, byteLength: checkpointBytes.length, digest: sha256Bytes(checkpointBytes) }, targetSchemaVersion: 2, targetEventHash: target.eventHash, actionDigest: valid.actionDigest, receiptDigest: valid.receiptDigest, consumedNonce: valid.gateNonce, retainedLegacyLog: path.basename(files.backup), ...(checkpointBytes === null ? {} : { retainedLegacyCheckpoint: path.basename(files.legacyCheckpoint) }) };
    atomicWrite(files.manifest, `${canonicalJson(manifest)}\n`);
    if (options.injectFailureAt === 'manifest') fail('MIGRATION_RECOVERY_REQUIRED', 3);
    fs.rmSync(files.marker);
    return { status: 'PASS', mode: 'migrated', ...manifest };
  } catch (error) {
    if (error instanceof MigrationError && error.exitCode === 3) throw error;
    fail('MIGRATION_RECOVERY_REQUIRED', 3);
  }
}
function option(args, name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }
async function main(args) { if (!args.length || args.includes('--help')) { console.log(HELP); return; } const runDir = args[0]; if (args.includes('--check')) console.log(JSON.stringify(checkMigration(runDir))); else if (args.includes('--recover')) console.log(JSON.stringify(recoverMigration(runDir))); else console.log(JSON.stringify(await migrate(runDir, option(args, '--approval'), { injectPreSwapFailure: args.includes('--inject-pre-swap-failure') }))); }
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch((error) => { console.error(error.code ?? error.message); process.exitCode = error.exitCode ?? 1; });
