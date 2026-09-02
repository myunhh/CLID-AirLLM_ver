#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalHash, canonicalJson, sha256Bytes } from './lib/canonical-json.mjs';
import { EventStore } from './lib/event-store.mjs';
import { AuthorityError, rejectAuthentication, rejectCallerRole, validateHumanApproval, validateJudgeReceipt, withAuthorityLock } from './lib/authority.mjs';
import { verifyTarget } from './verify-events.mjs';

const HELP = `Usage: orchestrator-graph <command> [arguments]

Commands:
  validate <graph.json>
  init <graph.json> <run-dir>
  ready <run-dir>
  transition <run-dir> <node-id> <RUNNING|VERIFYING|BLOCKED>
  submit-verdict <run-dir> <receipt.json>
  approve-gate <run-dir> <receipt.json>
  status <run-dir>
  render <run-dir> [--output <file>]

Judge success/failure requires submit-verdict; human gates require approve-gate.
Caller-supplied --actor-role and --authenticated claims are unavailable.`;

export class ControllerError extends Error {
  constructor(code, exitCode = 1) { super(code); this.name = 'ControllerError'; this.code = code; this.exitCode = exitCode; }
}
function fail(code, exitCode = 1) { throw new ControllerError(code, exitCode); }
function readJson(file, code = 'JSON_INVALID') { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail(code); } }
function writeExclusive(file, bytes) { fs.writeFileSync(file, bytes, { flag: 'wx' }); }
function uniqueStrings(value) { return Array.isArray(value) && value.every((v) => typeof v === 'string' && v.length > 0) && new Set(value).size === value.length; }

export function validateGraph(graph) {
  if (!graph || graph.schemaVersion !== 2 || typeof graph.runId !== 'string' || !graph.runId || !uniqueStrings(graph.builders) || !uniqueStrings(graph.judges) || graph.judges.length === 0 || !Array.isArray(graph.nodes) || graph.nodes.length === 0) fail('GRAPH_SCHEMA_INVALID');
  if (graph.judges.some((id) => graph.builders.includes(id))) fail('BUILDER_JUDGE_NOT_INDEPENDENT');
  const ids = new Set();
  for (const node of graph.nodes) {
    if (!node || typeof node.id !== 'string' || !node.id || ids.has(node.id) || !Array.isArray(node.dependsOn) || !Array.isArray(node.acceptance) || node.acceptance.length === 0 || !uniqueStrings(node.builderIds) || typeof node.judgeNonce !== 'string' || !node.judgeNonce || typeof node.resultArtifactRef !== 'string' || !node.resultArtifactRef) fail('GRAPH_SCHEMA_INVALID');
    if (node.builderIds.some((id) => !graph.builders.includes(id))) fail('GRAPH_BUILDER_UNDECLARED');
    const b = node.budgets;
    if (!b || !['tokens', 'toolCalls', 'wallSeconds', 'processes'].every((key) => Number.isSafeInteger(b[key]) && b[key] > 0)) fail('GRAPH_BUDGET_INVALID');
    ids.add(node.id);
  }
  for (const node of graph.nodes) if (node.dependsOn.some((id) => !ids.has(id) || id === node.id)) fail('GRAPH_DEPENDENCY_INVALID');
  const visiting = new Set(), visited = new Set();
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  function visit(id) { if (visiting.has(id)) fail('GRAPH_CYCLE'); if (visited.has(id)) return; visiting.add(id); for (const dep of byId.get(id).dependsOn) visit(dep); visiting.delete(id); visited.add(id); }
  for (const id of ids) visit(id);
  if (graph.humanGates !== undefined) {
    if (!Array.isArray(graph.humanGates)) fail('GRAPH_SCHEMA_INVALID');
    const gates = new Set();
    for (const gate of graph.humanGates) {
      if (!gate || typeof gate.id !== 'string' || !gate.id || gates.has(gate.id) || !/^[0-9a-f]{64}$/u.test(gate.actionDigest ?? '') || typeof gate.gateNonce !== 'string' || !gate.gateNonce) fail('GRAPH_SCHEMA_INVALID');
      gates.add(gate.id);
    }
  }
  return graph;
}

export function graphWithDigests(graph) {
  return { ...graph, nodes: graph.nodes.map((node) => ({ ...node, acceptanceDigest: canonicalHash(node.acceptance) })) };
}

function runFiles(runDir) { const dir = path.resolve(runDir); return { dir, graph: path.join(dir, 'execution-graph.json'), events: path.join(dir, 'events.jsonl') }; }
function familyOfLog(logPath) {
  if (!fs.existsSync(logPath) || fs.statSync(logPath).size === 0) return 'empty';
  const families = new Set(fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/u).map((line) => { const e = JSON.parse(line); return e.schemaVersion === 2 ? 'v2' : (Object.hasOwn(e, 'digest') ? 'bridge-v0' : 'controller-v1'); }));
  return families.size === 1 ? [...families][0] : 'mixed';
}
function loadRun(runDir, mutation = false) {
  const files = runFiles(runDir); const family = familyOfLog(files.events);
  if (mutation && family !== 'v2') fail(family === 'mixed' ? 'MIXED_EVENT_SCHEMA' : 'LEGACY_RUN_REQUIRES_MIGRATION');
  let graph; try { graph = JSON.parse(fs.readFileSync(files.graph, 'utf8')); } catch { fail('RUN_DEFINITION_MUTATED'); }
  const replay = new EventStore({ runDir: files.dir }).replay();
  const initialized = replay.events[0];
  if (family === 'v2' && (initialized?.type !== 'run_initialized' || !/^[0-9a-f]{64}$/u.test(initialized.data?.definitionDigest ?? '') || canonicalHash(graph) !== initialized.data.definitionDigest)) fail('RUN_DEFINITION_MUTATED');
  validateGraph(graph);
  const store = new EventStore({ runDir: files.dir, runId: graph.runId });
  return { files, graph, store, replay };
}
function derived(graph, events) {
  const nodes = Object.fromEntries(graph.nodes.map((node) => [node.id, 'PENDING'])); const consumedNonces = new Set(), consumedReceiptDigests = new Set(), gates = {};
  for (const gate of graph.humanGates ?? []) gates[gate.id] = 'PENDING';
  for (const event of events) {
    if ((event.type === 'node_transition' || event.type === 'judge_verdict_recorded') && event.data.nodeId in nodes) nodes[event.data.nodeId] = event.data.to;
    if (event.type === 'human_approval_recorded' && event.data.gateId in gates) gates[event.data.gateId] = 'APPROVED';
    if (typeof event.data.nonce === 'string') consumedNonces.add(event.data.nonce);
    if (typeof event.data.receiptDigest === 'string') consumedReceiptDigests.add(event.data.receiptDigest);
  }
  return { nodes, gates, consumedNonces, consumedReceiptDigests };
}
function receiptFile(value) { return typeof value === 'string' ? readJson(value, 'RECEIPT_INVALID') : value; }
function resultDigest(runDir, reference) {
  if (path.isAbsolute(reference) || reference.includes('\0')) fail('RESULT_ARTIFACT_REF_INVALID');
  const absolute = path.resolve(runDir, reference), relative = path.relative(runDir, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) fail('RESULT_ARTIFACT_REF_INVALID');
  const realRoot = fs.realpathSync.native(runDir), realArtifact = fs.realpathSync.native(absolute), realRelative = path.relative(realRoot, realArtifact);
  if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) fail('RESULT_ARTIFACT_REF_INVALID');
  return sha256Bytes(fs.readFileSync(realArtifact));
}

export async function initRun(graphPath, runDir) {
  const graph = graphWithDigests(validateGraph(readJson(graphPath, 'GRAPH_INVALID'))); const files = runFiles(runDir);
  if (fs.existsSync(files.dir)) fail('RUN_ALREADY_EXISTS');
  fs.mkdirSync(files.dir, { recursive: false });
  writeExclusive(files.graph, `${canonicalJson(graph)}\n`);
  const store = new EventStore({ runDir: files.dir, runId: graph.runId });
  return store.append({ runId: graph.runId, type: 'run_initialized', producer: 'orchestrator-graph', authority: 'workflow_assertion', data: { definitionDigest: canonicalHash(graph), nodeCount: graph.nodes.length } });
}
export async function transition(runDir, nodeId, to, options = {}) {
  if (options.authenticated) rejectAuthentication();
  if (options.actorRole || ['SUCCEEDED', 'FAILED', 'APPROVED'].includes(to)) rejectCallerRole();
  return withAuthorityLock(path.resolve(runDir), async () => {
    const run = loadRun(runDir, true); const state = derived(run.graph, run.replay.events); const node = run.graph.nodes.find((n) => n.id === nodeId);
    if (!node) fail('NODE_NOT_FOUND'); const from = state.nodes[nodeId];
    if (from === 'PENDING' && to === 'RUNNING' && node.dependsOn.some((id) => state.nodes[id] !== 'SUCCEEDED')) fail('NODE_DEPENDENCIES_INCOMPLETE');
    const legal = { PENDING: ['RUNNING', 'BLOCKED'], RUNNING: ['VERIFYING', 'BLOCKED'], BLOCKED: ['RUNNING'], VERIFYING: [] };
    if (!(legal[from] ?? []).includes(to)) fail('ILLEGAL_NODE_TRANSITION');
    return run.store.append({ runId: run.graph.runId, type: 'node_transition', producer: 'orchestrator-graph', authority: 'workflow_assertion', data: { nodeId, from, to, acceptanceDigest: node.acceptanceDigest } });
  });
}
export async function submitVerdict(runDir, receiptInput) {
  return withAuthorityLock(path.resolve(runDir), async () => {
    const run = loadRun(runDir, true); const state = derived(run.graph, run.replay.events); const receipt = receiptFile(receiptInput); const node = run.graph.nodes.find((n) => n.id === receipt?.nodeId);
    const expected = { runId: run.graph.runId, nodeId: node?.id, acceptanceDigest: node?.acceptanceDigest, resultDigest: node ? resultDigest(run.files.dir, node.resultArtifactRef) : undefined, judgeIds: run.graph.judges, builderIds: node?.builderIds ?? run.graph.builders, nonce: node?.judgeNonce, ...state };
    const valid = validateJudgeReceipt(receipt, expected);
    if (state.nodes[node.id] !== 'VERIFYING') fail('NODE_NOT_VERIFYING');
    const outcome = receipt.outcome ?? 'pass'; if (!['pass', 'fail'].includes(outcome)) fail('VERDICT_INVALID');
    return run.store.append({ runId: run.graph.runId, type: 'judge_verdict_recorded', producer: valid.judgeId, authority: 'workflow_assertion', data: { nodeId: node.id, from: 'VERIFYING', to: outcome === 'pass' ? 'SUCCEEDED' : 'FAILED', acceptanceDigest: valid.acceptanceDigest, resultDigest: valid.resultDigest, judgeId: valid.judgeId, nonce: valid.nonce, receiptDigest: valid.receiptDigest } });
  });
}
export async function approveGate(runDir, receiptInput) {
  return withAuthorityLock(path.resolve(runDir), async () => {
    const run = loadRun(runDir, true); const state = derived(run.graph, run.replay.events); const receipt = receiptFile(receiptInput); const gate = (run.graph.humanGates ?? []).find((g) => g.id === receipt?.gateId);
    const valid = validateHumanApproval(receipt, { runId: run.graph.runId, gateId: gate?.id, actionDigest: gate?.actionDigest, gateNonce: gate?.gateNonce, ...state });
    if (state.gates[gate.id] !== 'PENDING') fail('RECEIPT_REPLAY');
    return run.store.append({ runId: run.graph.runId, type: 'human_approval_recorded', producer: 'human-workflow', authority: 'workflow_assertion', data: { gateId: valid.gateId, actionDigest: valid.actionDigest, gateNonce: valid.gateNonce, receiptDigest: valid.receiptDigest } });
  });
}
export function status(runDir) {
  const files = runFiles(runDir), family = familyOfLog(files.events);
  if (family !== 'v2') { const verified = verifyTarget(files.dir); return { runId: verified.runId, family: verified.family, seq: verified.seq, eventHash: verified.eventHash, legacyReadOnly: true }; }
  const run = loadRun(runDir); return { runId: run.graph.runId, family: 'v2', ...derived(run.graph, run.replay.events), seq: run.replay.seq, eventHash: run.replay.eventHash };
}

function option(args, name) { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; }
async function main(args) {
  if (args.length === 0 || args.includes('--help') || args[0] === 'help') { console.log(HELP); return; }
  if (args.includes('--authenticated')) rejectAuthentication();
  const [command, ...rest] = args;
  if (command === 'validate') { validateGraph(readJson(rest[0], 'GRAPH_INVALID')); console.log(JSON.stringify({ status: 'PASS' })); }
  else if (command === 'init') console.log(JSON.stringify(await initRun(rest[0], rest[1])));
  else if (command === 'ready') { const run = loadRun(rest[0]); const state = derived(run.graph, run.replay.events); console.log(JSON.stringify({ runId: run.graph.runId, ready: run.graph.nodes.filter((node) => state.nodes[node.id] === 'PENDING' && node.dependsOn.every((id) => state.nodes[id] === 'SUCCEEDED')).map((node) => node.id) })); }
  else if (command === 'transition') console.log(JSON.stringify(await transition(rest[0], rest[1], rest[2], { actorRole: option(rest, '--actor-role'), authenticated: rest.includes('--authenticated') })));
  else if (command === 'submit-verdict') console.log(JSON.stringify(await submitVerdict(rest[0], rest[1])));
  else if (command === 'approve-gate') console.log(JSON.stringify(await approveGate(rest[0], rest[1])));
  else if (command === 'status') { const value = status(rest[0]); value.consumedNonces = [...value.consumedNonces]; value.consumedReceiptDigests = [...value.consumedReceiptDigests]; console.log(JSON.stringify(value)); }
  else if (command === 'render') { const run = loadRun(rest[0]); const body = `graph TD\n${run.graph.nodes.map((n) => n.dependsOn.length ? n.dependsOn.map((d) => `  ${d} --> ${n.id}`).join('\n') : `  ${n.id}`).join('\n')}\n`; const output = option(rest, '--output'); if (output) fs.writeFileSync(output, body); else process.stdout.write(body); }
  else fail('COMMAND_INVALID', 2);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => { const code = error.code ?? error.message ?? 'UNEXPECTED_ERROR'; console.error(code); process.exitCode = error instanceof ControllerError ? error.exitCode : (error instanceof AuthorityError && code === 'CALLER_ROLE_AUTHORITY_FORBIDDEN' ? 2 : 1); });
}
