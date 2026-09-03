import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalHash, canonicalJson, sha256Bytes } from './canonical-json.mjs';
import { validateBudget } from './admission.mjs';
import { validateGraph } from '../orchestrator-graph.mjs';
import { preflightCapsules } from './capsule-preflight.mjs';
import { compileWorkerCommand } from '../command-worker.mjs';
import { canonicalPathIdentity, resolveWorkspaceRoot } from './path-identity.mjs';

export const BLUEPRINT_SCHEMA_VERSION = 1;
export const REVIEW_RECEIPT_SCHEMA_VERSION = 1;
export const PLAN_SCHEMA_VERSION = 1;
export const COMPILER_VERSION = '1.2.0';
export const POLICY_SCHEMA_VERSION = 1;
export const GRAPH_SCHEMA_VERSION = 2;
export const ATTEMPT_LEDGER_SCHEMA_VERSION = 1;
export const OBSERVED_GRAPH_REPORT_VERSION = 1;
export const GRAPHIFY_DEPENDENCY_RELATIONS = Object.freeze(['imports', 'imports_from', 're_exports']);

export class BlueprintError extends Error {
  constructor(code, details = {}) { super(code); this.name = 'BlueprintError'; this.code = code; this.details = details; }
}
const fail = (code, details) => { throw new BlueprintError(code, details); };
const DIGEST = /^[0-9a-f]{64}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;
const ownKeys = (value, required, optional = []) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const permitted = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => permitted.has(key));
};
const strings = (value, { nonempty = true, unique = false } = {}) => Array.isArray(value) && (!nonempty || value.length > 0) && value.every((item) => typeof item === 'string' && item.length > 0) && (!unique || new Set(value).size === value.length);
const stringArray = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string');
const freeze = (value) => Object.freeze(value);

function portableKey(value, code = 'PATH_INVALID') {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value) || /[*?\[\]{}]/u.test(value)) fail(code, { path: value });
  const segments = value.split('/');
  if (segments.some((part) => part === '' || part === '.' || part === '..' || part.endsWith('.') || part.endsWith(' ') || part.includes(':') || DEVICE.test(part))) fail(code, { path: value });
  // ECMAScript case conversion is locale independent.  The upper/lower round trip
  // also expands full-fold aliases such as sharp-s to "ss".
  return segments.map((part) => part.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC')).join('/');
}
function assertNoAliases(paths, code = 'PATH_COLLISION') {
  const keyed = paths.map((item) => ({ item, key: portableKey(item) }));
  const seen = new Map();
  for (const entry of keyed) {
    if (seen.has(entry.key)) fail(code, { first: seen.get(entry.key), second: entry.item });
    seen.set(entry.key, entry.item);
  }
  const ordered = [...keyed].sort((a, b) => a.key.localeCompare(b.key));
  for (let index = 0; index < ordered.length; index += 1) for (let other = index + 1; other < ordered.length; other += 1) {
    if (ordered[other].key.startsWith(`${ordered[index].key}/`)) fail(code, { ancestor: ordered[index].item, descendant: ordered[other].item });
  }
  return seen;
}
function strictBudget(value) {
  try { const checked = validateBudget(value); return Object.fromEntries(['tokens', 'toolCalls', 'wallSeconds', 'processes'].map((key) => [key, checked[key]])); }
  catch (error) { fail('BUDGET_INVALID', { cause: error.code }); }
}

export function validatePolicy(policy) {
  const required = ['schemaVersion', 'policyVersion', 'classification', 'ambiguitySignals', 'standardApprovals', 'elevatedApprovals', 'maxRetryCap', 'reservedRoots'];
  if (!ownKeys(policy, required) || policy.schemaVersion !== POLICY_SCHEMA_VERSION || typeof policy.policyVersion !== 'string' || !policy.policyVersion || !['S', 'M', 'L', 'XL'].includes(policy.classification) || !strings(policy.ambiguitySignals, { nonempty: false, unique: true }) || !Number.isSafeInteger(policy.standardApprovals) || policy.standardApprovals < 1 || !Number.isSafeInteger(policy.elevatedApprovals) || policy.elevatedApprovals < policy.standardApprovals || !Number.isSafeInteger(policy.maxRetryCap) || policy.maxRetryCap < 0 || !strings(policy.reservedRoots, { nonempty: false, unique: true })) fail('POLICY_INVALID');
  assertNoAliases(policy.reservedRoots, 'RESERVED_ROOT_COLLISION');
  return freeze({ ...policy, ambiguitySignals: freeze([...policy.ambiguitySignals]), reservedRoots: freeze([...policy.reservedRoots]) });
}

export function policyDigest(policy) { return canonicalHash(validatePolicy(policy)); }
export const digestPolicy = policyDigest;

export function deriveReviewQuorum(policyInput) {
  const policy = validatePolicy(policyInput);
  const elevated = ['L', 'XL'].includes(policy.classification) || policy.ambiguitySignals.length > 0;
  const value = { schemaVersion: 1, policyVersion: policy.policyVersion, classification: policy.classification, ambiguitySignals: [...policy.ambiguitySignals].sort(), requiredApprovals: elevated ? policy.elevatedApprovals : policy.standardApprovals };
  return freeze({ ...value, quorumDigest: canonicalHash(value) });
}
export const computeReviewQuorum = deriveReviewQuorum;
export const deriveRequiredReviewQuorum = deriveReviewQuorum;

export function validateBlueprint(blueprint, policyInput) {
  const required = ['schemaVersion', 'blueprintId', 'classification', 'ambiguitySignals', 'builders', 'judges', 'defaultBudget', 'graphPolicy', 'files'];
  if (!ownKeys(blueprint, required) || blueprint.schemaVersion !== BLUEPRINT_SCHEMA_VERSION || !ID.test(blueprint.blueprintId ?? '') || !['S', 'M', 'L', 'XL'].includes(blueprint.classification) || !strings(blueprint.ambiguitySignals, { nonempty: false, unique: true }) || !strings(blueprint.builders, { unique: true }) || !strings(blueprint.judges, { unique: true }) || blueprint.judges.some((id) => blueprint.builders.includes(id)) || !ownKeys(blueprint.graphPolicy, ['directed', 'edgeDirection']) || blueprint.graphPolicy.directed !== true || blueprint.graphPolicy.edgeDirection !== 'source-depends-on-target' || !Array.isArray(blueprint.files) || blueprint.files.length === 0) fail('BLUEPRINT_INVALID');
  const policy = policyInput === undefined ? undefined : validatePolicy(policyInput);
  if (policy && (blueprint.classification !== policy.classification || canonicalJson([...blueprint.ambiguitySignals].sort()) !== canonicalJson([...policy.ambiguitySignals].sort()))) fail('BLUEPRINT_RISK_CLAIM_MISMATCH');
  strictBudget(blueprint.defaultBudget);
  const paths = [], nodeIds = new Set();
  for (const file of blueprint.files) {
    if (!ownKeys(file, ['path', 'dependsOn', 'builderId', 'contract', 'instructions', 'stub'], ['retryCap', 'budget', 'verificationCommands', 'skillPaths']) || !strings(file.dependsOn, { nonempty: false, unique: true }) || !blueprint.builders.includes(file.builderId) || !Number.isSafeInteger(file.retryCap ?? 0) || (file.retryCap ?? 0) < 0 || typeof file.instructions !== 'string' || !file.instructions || typeof file.stub !== 'string' || !file.stub.includes('IMPLEMENTATION_REQUIRED') || !ownKeys(file.contract, ['purpose', 'exports', 'acceptance']) || typeof file.contract.purpose !== 'string' || !file.contract.purpose || !Array.isArray(file.contract.exports) || !file.contract.exports.every((v) => typeof v === 'string') || !strings(file.contract.acceptance)) fail('BLUEPRINT_FILE_INVALID', { path: file?.path });
    portableKey(file.path);
    if (file.skillPaths !== undefined) {
      if (!strings(file.skillPaths, { nonempty: false, unique: true })) fail('BLUEPRINT_SKILL_PATH_INVALID', { path: file.path });
      const skillKeys = file.skillPaths.map((skillPath) => portableKey(skillPath, 'BLUEPRINT_SKILL_PATH_INVALID'));
      if (new Set(skillKeys).size !== skillKeys.length) fail('BLUEPRINT_SKILL_PATH_INVALID', { path: file.path });
    }
    if (file.verificationCommands !== undefined) {
      if (!Array.isArray(file.verificationCommands)) fail('BLUEPRINT_FILE_INVALID', { path: file.path });
      for (const verification of file.verificationCommands) {
        if (!ownKeys(verification, ['command', 'args'], ['cwd']) || typeof verification.command !== 'string' || verification.command.length === 0 || !stringArray(verification.args)) fail('BLUEPRINT_VERIFICATION_COMMAND_INVALID', { path: file.path });
        if (verification.cwd !== undefined) portableKey(verification.cwd, 'BLUEPRINT_VERIFICATION_COMMAND_INVALID');
      }
    }
    if (file.budget !== undefined) strictBudget(file.budget);
    if (policy && (file.retryCap ?? 0) > policy.maxRetryCap) fail('RETRY_CAP_EXCEEDS_POLICY', { path: file.path });
    paths.push(file.path);
    const id = nodeIdFor(file.path); if (nodeIds.has(id)) fail('NODE_ID_COLLISION'); nodeIds.add(id);
  }
  const pathMap = assertNoAliases(paths);
  for (const file of blueprint.files) for (const dependency of file.dependsOn) {
    const key = portableKey(dependency);
    if (!pathMap.has(key) || key === portableKey(file.path)) fail('BLUEPRINT_DEPENDENCY_INVALID', { path: file.path, dependency });
  }
  if (policy) {
    for (const file of blueprint.files) for (const root of policy.reservedRoots) {
      const key = portableKey(file.path), reserved = portableKey(root);
      if (key === reserved || key.startsWith(`${reserved}/`)) fail('RESERVED_ROOT_FORBIDDEN', { path: file.path, root });
    }
  }
  return blueprint;
}

export function blueprintDigest(blueprint, policy) { return canonicalHash(validateBlueprint(blueprint, policy)); }
export const digestBlueprint = blueprintDigest;

function confinedArtifact(root, reference) {
  portableKey(reference, 'FINDINGS_ARTIFACT_REF_INVALID');
  const rootPath = path.resolve(root), target = path.resolve(rootPath, ...reference.split('/'));
  const relative = path.relative(rootPath, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !fs.existsSync(target) || !fs.statSync(target).isFile()) fail('FINDINGS_ARTIFACT_REF_INVALID', { reference });
  const realRoot = fs.realpathSync.native(rootPath), realTarget = fs.realpathSync.native(target), realRelative = path.relative(realRoot, realTarget);
  if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) fail('FINDINGS_ARTIFACT_REF_INVALID', { reference });
  return fs.readFileSync(realTarget);
}

export function validateReviewReceipt(receipt, { blueprint, policy, findingsRoot }) {
  const required = ['schemaVersion', 'blueprintDigest', 'policyDigest', 'quorumDigest', 'judgeId', 'nonce', 'outcome', 'findingsArtifactRef', 'findingsDigest'];
  if (!ownKeys(receipt, required) || receipt.schemaVersion !== REVIEW_RECEIPT_SCHEMA_VERSION || !DIGEST.test(receipt.blueprintDigest ?? '') || !DIGEST.test(receipt.policyDigest ?? '') || !DIGEST.test(receipt.quorumDigest ?? '') || typeof receipt.judgeId !== 'string' || !receipt.judgeId || typeof receipt.nonce !== 'string' || !receipt.nonce || receipt.outcome !== 'approve' || !DIGEST.test(receipt.findingsDigest ?? '')) fail('REVIEW_RECEIPT_INVALID');
  validateBlueprint(blueprint, policy); const quorum = deriveReviewQuorum(policy);
  if (receipt.blueprintDigest !== blueprintDigest(blueprint, policy) || receipt.policyDigest !== policyDigest(policy) || receipt.quorumDigest !== quorum.quorumDigest) fail('REVIEW_RECEIPT_BINDING_MISMATCH');
  if (!blueprint.judges.includes(receipt.judgeId) || blueprint.builders.includes(receipt.judgeId)) fail('REVIEWER_NOT_INDEPENDENT');
  const bytes = confinedArtifact(findingsRoot, receipt.findingsArtifactRef);
  if (sha256Bytes(bytes) !== receipt.findingsDigest) fail('FINDINGS_DIGEST_MISMATCH');
  return freeze({ ...receipt, receiptDigest: canonicalHash(receipt) });
}

export function createGateAttestation({ blueprint, policy, receipts, findingsRoot }) {
  validateBlueprint(blueprint, policy); const quorum = deriveReviewQuorum(policy);
  if (!Array.isArray(receipts)) fail('RECEIPTS_INVALID');
  const checked = receipts.map((receipt) => validateReviewReceipt(receipt, { blueprint, policy, findingsRoot }));
  if (new Set(checked.map((r) => r.judgeId)).size !== checked.length) fail('DUPLICATE_REVIEWER');
  if (new Set(checked.map((r) => r.nonce)).size !== checked.length) fail('DUPLICATE_REVIEW_NONCE');
  if (checked.length < quorum.requiredApprovals) fail('REVIEW_QUORUM_INSUFFICIENT');
  const gate = { schemaVersion: 1, blueprintDigest: blueprintDigest(blueprint, policy), policyDigest: policyDigest(policy), policyVersion: policy.policyVersion, quorum, receiptDigests: checked.map((r) => r.receiptDigest).sort(), threatBoundary: 'trusted-local-workspace; judge identity and pipeline locks are workflow assertions, not authentication against privileged actors' };
  return freeze({ ...gate, attestationDigest: canonicalHash(gate) });
}
export const createGate = createGateAttestation;

export function validateGateAttestation(gate, { blueprint, policy, receipts, findingsRoot } = {}) {
  if (!ownKeys(gate, ['schemaVersion', 'blueprintDigest', 'policyDigest', 'policyVersion', 'quorum', 'receiptDigests', 'threatBoundary', 'attestationDigest']) || gate.schemaVersion !== 1 || !strings(gate.receiptDigests, { unique: true }) || !DIGEST.test(gate.attestationDigest ?? '')) fail('GATE_ATTESTATION_INVALID');
  const body = Object.fromEntries(Object.entries(gate).filter(([key]) => key !== 'attestationDigest'));
  if (gate.attestationDigest !== canonicalHash(body)) fail('GATE_ATTESTATION_INVALID');
  const quorum = deriveReviewQuorum(policy);
  if (gate.blueprintDigest !== blueprintDigest(blueprint, policy) || gate.policyDigest !== policyDigest(policy) || gate.policyVersion !== policy.policyVersion || canonicalJson(gate.quorum) !== canonicalJson(quorum) || gate.receiptDigests.length < quorum.requiredApprovals) fail('GATE_BINDING_MISMATCH');
  if (!Array.isArray(receipts) || typeof findingsRoot !== 'string' || !findingsRoot) fail('GATE_RECEIPTS_REQUIRED');
  const rebuilt = createGateAttestation({ blueprint, policy, receipts, findingsRoot });
  if (canonicalJson(rebuilt) !== canonicalJson(gate)) fail('GATE_RECEIPT_REPLAY_OR_SUBSTITUTION');
  return gate;
}

const nodeIdFor = (filePath) => `file-${sha256Bytes(portableKey(filePath)).slice(0, 20)}`;
const sidecarFor = (blueprintId, filePath) => `.orchestrator/blueprints/${blueprintId}/contracts/${filePath}.md`;
const resultFor = (blueprintId, nodeId) => `.orchestrator/blueprints/${blueprintId}/results/${nodeId}.md`;
const capsuleFor = (blueprintId, nodeId) => `.orchestrator/blueprints/${blueprintId}/capsules/${nodeId}`;
function capsuleFiles(blueprint, file, node, policy, workspace) {
  const owned = [...node.writeSet];
  const ownedKeys = owned.map((item) => portableKey(item));
  const forbidden = [...policy.reservedRoots, '.git'].filter((root) => {
    const key = portableKey(root);
    return !ownedKeys.some((ownedKey) => ownedKey === key || ownedKey.startsWith(`${key}/`));
  });
  return {
    'TASK.md': `# Objective\n\nImplement ${file.path} according to its contract sidecar.\n`,
    'ACCEPTANCE.md': `# Acceptance\n\n${file.contract.acceptance.map((item) => `- ${item}`).join('\n')}\n`,
    'BUDGET.json': `${canonicalJson(node.budgets)}\n`,
    'CONTEXT.md': `# Context\n\nContract: ${sidecarFor(blueprint.blueprintId, file.path)}\nSkills: ${canonicalJson(node.skillPaths)}\nRetry cap: ${node.retryCap}\nInherited context: 0\n`,
    'OWNERSHIP.json': `${canonicalJson({ worktreePath: workspace.canonicalWorkspaceRoot, allowedReadRoots: [file.path, ...file.dependsOn, ...node.skillPaths, sidecarFor(blueprint.blueprintId, file.path), node.resultArtifactRef], allowedWriteFiles: owned, forbiddenPaths: forbidden })}\n`,
    'RESULT.md': '# Result\n\nStatus: READY\n',
  };
}
export function validateWaveWriteSets(waves) {
  const waveList = Array.isArray(waves) && waves.every(Array.isArray) ? waves : [waves];
  for (const wave of waveList) {
    if (!Array.isArray(wave) || wave.some((node) => !node || typeof node !== 'object' || !Array.isArray(node.writeSet))) fail('SAME_WAVE_WRITE_CONFLICT');
    for (let i = 0; i < wave.length; i += 1) for (let j = i + 1; j < wave.length; j += 1) assertNoAliases([...wave[i].writeSet, ...wave[j].writeSet], 'SAME_WAVE_WRITE_CONFLICT');
  }
  return waves;
}
export const validateSafeWaves = validateWaveWriteSets;
function topologicalWaves(nodes) {
  const pending = new Map(nodes.map((node) => [node.id, node])), done = new Set(), waves = [];
  while (pending.size) {
    const wave = [...pending.values()].filter((node) => node.dependsOn.every((id) => done.has(id))).sort((a, b) => a.id.localeCompare(b.id));
    if (!wave.length) fail('GRAPH_CYCLE');
    validateWaveWriteSets(wave);
    waves.push(wave.map((node) => node.id)); for (const node of wave) { pending.delete(node.id); done.add(node.id); }
  }
  return waves;
}

function workspaceAuthorization(workspaceRoot) {
  const root = resolveWorkspaceRoot(workspaceRoot);
  return { root, identity: canonicalHash({ canonicalWorkspaceRoot: root.canonicalWorkspaceRoot }) };
}

export function compilePlan({ blueprint, policy, gate, receipts, findingsRoot, workspaceRoot }) {
  validateBlueprint(blueprint, policy); validateGateAttestation(gate, { blueprint, policy, receipts, findingsRoot });
  const { root: authorizedWorkspace, identity: workspaceIdentity } = workspaceAuthorization(workspaceRoot);
  const byKey = new Map(blueprint.files.map((file) => [portableKey(file.path), file]));
  const nodes = blueprint.files.map((file) => {
    const id = nodeIdFor(file.path), sidecar = sidecarFor(blueprint.blueprintId, file.path), result = resultFor(blueprint.blueprintId, id);
    return { id, path: file.path, dependsOn: file.dependsOn.map((dep) => nodeIdFor(byKey.get(portableKey(dep)).path)).sort(), acceptance: [...file.contract.acceptance], verificationCommands: (file.verificationCommands ?? []).map((verification) => ({ ...verification, args: [...verification.args] })), skillPaths: [...(file.skillPaths ?? [])], builderIds: [file.builderId], judgeNonce: `judge-${canonicalHash({ blueprint: blueprintDigest(blueprint, policy), id }).slice(0, 32)}`, resultArtifactRef: result, budgets: strictBudget(file.budget ?? blueprint.defaultBudget), retryCap: file.retryCap ?? 0, writeSet: [file.path] };
  }).sort((a, b) => a.id.localeCompare(b.id));
  const derived = [];
  for (const file of blueprint.files) derived.push(file.path, sidecarFor(blueprint.blueprintId, file.path), resultFor(blueprint.blueprintId, nodeIdFor(file.path)));
  derived.push(`.orchestrator/blueprints/${blueprint.blueprintId}/manifest.json`, `.orchestrator/blueprints/${blueprint.blueprintId}/materialization.journal.json`, `.orchestrator/blueprints/${blueprint.blueprintId}/materialization.lock`);
  for (const node of nodes) for (const name of ['TASK.md', 'ACCEPTANCE.md', 'BUDGET.json', 'CONTEXT.md', 'OWNERSHIP.json', 'RESULT.md']) derived.push(`${capsuleFor(blueprint.blueprintId, node.id)}/${name}`);
  assertNoAliases(derived, 'DERIVED_OUTPUT_COLLISION');
  const graph = { schemaVersion: GRAPH_SCHEMA_VERSION, runId: `blueprint-${blueprint.blueprintId}-${blueprintDigest(blueprint, policy).slice(0, 12)}`, builders: [...blueprint.builders], judges: [...blueprint.judges], nodes: nodes.map(({ path: targetPath, ...node }) => ({ ...node, targetPath })) };
  try { validateGraph(graph); } catch (error) { fail('EXECUTION_GRAPH_INVALID', { cause: error.code }); }
  const waves = topologicalWaves(nodes);
  const sidecars = blueprint.files.map((file) => ({ path: sidecarFor(blueprint.blueprintId, file.path), bytes: `# Contract: ${file.path}\n\nPurpose: ${file.contract.purpose}\n\n## Exports\n\n${file.contract.exports.map((v) => `- ${v}`).join('\n')}\n\n## Acceptance\n\n${file.contract.acceptance.map((v) => `- ${v}`).join('\n')}\n\n## Verification Commands\n\n\`\`\`json\n${canonicalJson(file.verificationCommands ?? [])}\n\`\`\`\n\n## Skills\n\n\`\`\`json\n${canonicalJson(file.skillPaths ?? [])}\n\`\`\`\n\n## Instructions\n\n${file.instructions}\n` })).sort((a, b) => a.path.localeCompare(b.path));
  const capsules = nodes.map((node) => { const file = byKey.get(portableKey(node.path)); return { id: node.id, directory: capsuleFor(blueprint.blueprintId, node.id), files: capsuleFiles(blueprint, file, node, policy, authorizedWorkspace) }; });
  const manifest = blueprint.files.map((file) => ({ path: file.path, digest: sha256Bytes(file.stub), sidecarPath: sidecarFor(blueprint.blueprintId, file.path), sidecarDigest: sha256Bytes(sidecars.find((s) => s.path === sidecarFor(blueprint.blueprintId, file.path)).bytes) })).sort((a, b) => a.path.localeCompare(b.path));
  const authorization = { blueprintDigest: blueprintDigest(blueprint, policy), gateAttestationDigest: gate.attestationDigest, schemaVersion: BLUEPRINT_SCHEMA_VERSION, compilerVersion: COMPILER_VERSION, policyVersion: policy.policyVersion, policyDigest: policyDigest(policy), reservedRootsDigest: canonicalHash(policy.reservedRoots), workspaceIdentity };
  const body = { schemaVersion: PLAN_SCHEMA_VERSION, authorization, executionGraph: graph, waves, nodes, manifest, sidecars, capsules, threatBoundary: 'transaction lock coordinates trusted pipeline writers; privileged filesystem replacement is outside the local-workspace authority model' };
  return freeze({ ...body, planDigest: canonicalHash(body) });
}
export const planBlueprint = compilePlan;
export const compileBlueprintPlan = compilePlan;

function validatePlanInMemory(plan, inputs) {
  const rebuilt = compilePlan(inputs);
  if (canonicalJson(plan) !== canonicalJson(rebuilt)) fail('PLAN_RECOMPILE_MISMATCH');
  return plan;
}

export function validatePlan(plan, inputs) {
  if (typeof inputs?.planDir !== 'string' || !inputs.planDir) fail('PLAN_DIRECTORY_REQUIRED');
  const checked = verifyPlanDirectory(inputs.planDir, inputs);
  if (canonicalJson(plan) !== canonicalJson(checked.plan)) fail('PLAN_DIRECTORY_MISMATCH');
  return plan;
}

function planArtifacts(plan) {
  const files = new Map([
    ['plan.json', `${canonicalJson(plan)}\n`],
    ['execution-graph.json', `${canonicalJson(plan.executionGraph)}\n`],
    ['waves.json', `${canonicalJson(plan.waves)}\n`],
    ['scaffold-manifest.json', `${canonicalJson(plan.manifest)}\n`],
    ['sidecars.json', `${canonicalJson(plan.sidecars)}\n`],
  ]);
  for (const capsule of plan.capsules) for (const [name, bytes] of Object.entries(capsule.files)) files.set(`capsules/${capsule.id}/${name}`, bytes);
  return files;
}
function writeExact(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) { if (!fs.statSync(file).isFile() || !fs.readFileSync(file).equals(Buffer.from(bytes))) fail('ARTIFACT_BYTE_MISMATCH', { file }); return false; }
  fs.writeFileSync(file, bytes, { flag: 'wx' }); return true;
}
export function writePlanDirectory(planDir, plan, inputs) {
  validatePlanInMemory(plan, inputs); const root = path.resolve(planDir);
  for (const [relative, bytes] of planArtifacts(plan)) writeExact(path.join(root, ...relative.split('/')), bytes);
  verifyPlanDirectory(root, inputs); return freeze({ planDir: root, planDigest: plan.planDigest });
}
export const writePlan = writePlanDirectory;

export function readPlanDirectory(planDir) {
  try { return JSON.parse(fs.readFileSync(path.join(path.resolve(planDir), 'plan.json'), 'utf8')); } catch { fail('PLAN_DIRECTORY_INVALID'); }
}
export const readPlan = readPlanDirectory;

export function verifyPlanDirectory(planDir, inputs) {
  const root = path.resolve(planDir), plan = readPlanDirectory(root); validatePlanInMemory(plan, inputs);
  for (const [relative, expected] of planArtifacts(plan)) {
    const target = path.join(root, ...relative.split('/'));
    if (!fs.existsSync(target) || !fs.readFileSync(target).equals(Buffer.from(expected))) fail('PLAN_ARTIFACT_MISMATCH', { relative });
  }
  const dirs = plan.capsules.map((capsule) => path.join(root, 'capsules', capsule.id));
  for (const dir of dirs) {
    const peers = dirs.filter((item) => item !== dir);
    try { preflightCapsules({ capsuleDir: dir, parallelCapsuleDirs: peers }); compileWorkerCommand({ capsuleDir: dir, parallelCapsuleDirs: peers }); }
    catch (error) { fail('CAPSULE_PREFLIGHT_FAILED', { cause: error.code ?? error.message }); }
  }
  return freeze({ valid: true, planDigest: plan.planDigest, plan });
}
export const verifyPlan = verifyPlanDirectory;

function processAlive(pid) { if (!Number.isSafeInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } }
function readStrictJson(file, code) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { fail(code); } }
function objectIdentity(file) { const stat = fs.statSync(file); return { dev: String(stat.dev), ino: String(stat.ino), size: stat.size }; }
function sameObject(file, identity) { try { const current = objectIdentity(file); return current.dev === identity?.dev && current.ino === identity?.ino && current.size === identity?.size; } catch { return false; } }
function acquireLock(lockPath, owner) {
  try { fs.mkdirSync(lockPath); if (owner !== undefined) durableWrite(path.join(lockPath, 'owner.json'), `${canonicalJson(owner)}\n`, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (owner === undefined) fail('PIPELINE_LOCKED');
    const existing = readStrictJson(path.join(lockPath, 'owner.json'), 'LOCK_IDENTITY_UNCERTAIN');
    if (!ownKeys(existing, ['schemaVersion', 'pid', 'transactionId', 'planDigest', 'workspaceIdentity']) || existing.schemaVersion !== 1) fail('LOCK_IDENTITY_UNCERTAIN');
    if (processAlive(existing.pid)) fail('PIPELINE_LOCKED');
    return existing;
  }
  return undefined;
}
function durableWrite(file, bytes, flag = 'w') { const handle = fs.openSync(file, flag); try { fs.writeFileSync(handle, bytes); try { fs.fsyncSync(handle); } catch {} } finally { fs.closeSync(handle); } }
function journalWrite(file, value) { const temp = `${file}.${process.pid}.${randomUUID()}.tmp`; durableWrite(temp, `${canonicalJson(value)}\n`, 'wx'); fs.renameSync(temp, file); }

function validJournal(journal, owner, expected) {
  if (!ownKeys(journal, ['schemaVersion', 'transactionId', 'planDigest', 'workspaceIdentity', 'state', 'records']) || journal.schemaVersion !== 1 || journal.transactionId !== owner.transactionId || journal.planDigest !== expected.planDigest || journal.planDigest !== owner.planDigest || journal.workspaceIdentity !== expected.authorization.workspaceIdentity || journal.workspaceIdentity !== owner.workspaceIdentity || !['prepared', 'publishing'].includes(journal.state) || !Array.isArray(journal.records)) fail('RECOVERY_BINDING_MISMATCH');
  return journal;
}
function verifyRecord(record) {
  if (record?.state === 'existing') {
    if (!ownKeys(record, ['path', 'target', 'digest', 'state', 'targetIdentity']) || !DIGEST.test(record.digest ?? '') || typeof record.target !== 'string') fail('RECOVERY_JOURNAL_INVALID');
    return;
  }
  if (!ownKeys(record, ['path', 'target', 'temp', 'digest', 'state', 'tempIdentity'], ['targetIdentity']) || !['prepared', 'created'].includes(record.state) || !DIGEST.test(record.digest ?? '') || typeof record.target !== 'string' || typeof record.temp !== 'string') fail('RECOVERY_JOURNAL_INVALID');
}
function removeKnown(file, identity, digest) {
  if (!fs.existsSync(file)) return;
  if (!sameObject(file, identity) || !fs.statSync(file).isFile() || sha256Bytes(fs.readFileSync(file)) !== digest) fail('FOREIGN_REPLACEMENT_REFUSED', { file });
  fs.rmSync(file);
}
function resumeTransaction(journalPath, lockPath, owner, expected, root, publications) {
  const journal = validJournal(readStrictJson(journalPath, 'RECOVERY_JOURNAL_INVALID'), owner, expected);
  const allowed = new Map(publications.map((item) => [portableKey(item.relative), sha256Bytes(item.bytes)]));
  const created = [], unchanged = [];
  if (journal.records.length !== allowed.size || new Set(journal.records.map((item) => portableKey(item.path))).size !== journal.records.length) fail('RECOVERY_OPERATION_SET_MISMATCH');
  for (const record of journal.records) {
    verifyRecord(record); canonicalPathIdentity(record.path, root);
    if (allowed.get(portableKey(record.path)) !== record.digest) fail('RECOVERY_OPERATION_SET_MISMATCH', { path: record.path });
    if (record.state === 'existing') {
      if (!sameObject(record.target, record.targetIdentity) || sha256Bytes(fs.readFileSync(record.target)) !== record.digest) fail('FOREIGN_REPLACEMENT_REFUSED', { path: record.path });
      unchanged.push(record.path);
    } else if (record.state === 'prepared') {
      if (fs.existsSync(record.target)) {
        if (!record.targetIdentity || !sameObject(record.target, record.targetIdentity) || sha256Bytes(fs.readFileSync(record.target)) !== record.digest) fail('FOREIGN_REPLACEMENT_REFUSED', { path: record.path });
        if (fs.existsSync(record.temp)) removeKnown(record.temp, record.tempIdentity, record.digest);
      } else {
        if (!fs.existsSync(record.temp) || !sameObject(record.temp, record.tempIdentity) || sha256Bytes(fs.readFileSync(record.temp)) !== record.digest) fail('RECOVERY_TEMP_MISMATCH', { path: record.path });
        fs.linkSync(record.temp, record.target); record.targetIdentity = objectIdentity(record.target); removeKnown(record.temp, record.tempIdentity, record.digest);
      }
      record.state = 'created'; journal.state = 'publishing'; journalWrite(journalPath, journal);
      created.push(record.path);
    } else {
      if (!record.targetIdentity || !sameObject(record.target, record.targetIdentity) || sha256Bytes(fs.readFileSync(record.target)) !== record.digest) fail('FOREIGN_REPLACEMENT_REFUSED', { path: record.path });
      created.push(record.path);
    }
  }
  fs.rmSync(journalPath); fs.rmSync(lockPath, { recursive: true });
  return freeze({ created, unchanged });
}

export function materializeScaffold({ blueprint, policy, gate, receipts, findingsRoot, planDir, workspaceRoot }) {
  if (typeof planDir !== 'string' || !planDir) fail('PLAN_DIRECTORY_REQUIRED');
  const root = resolveWorkspaceRoot(workspaceRoot);
  const inputs = { blueprint, policy, gate, receipts, findingsRoot, workspaceRoot };
  const verified = verifyPlanDirectory(planDir, inputs), expected = verified.plan;
  if (expected.authorization.workspaceIdentity !== workspaceAuthorization(workspaceRoot).identity) fail('WORKSPACE_AUTHORIZATION_MISMATCH');
  const rootDir = path.join(root.absoluteWorkspaceRoot, '.orchestrator', 'blueprints', blueprint.blueprintId);
  const lockPath = path.join(rootDir, 'materialization.lock'), journalPath = path.join(rootDir, 'materialization.journal.json');
  const publications = blueprint.files.map((file) => ({ relative: file.path, bytes: file.stub })).concat(expected.sidecars.map((sidecar) => ({ relative: sidecar.path, bytes: sidecar.bytes })));
  fs.mkdirSync(rootDir, { recursive: true });
  const owner = { schemaVersion: 1, pid: process.pid, transactionId: randomUUID(), planDigest: expected.planDigest, workspaceIdentity: expected.authorization.workspaceIdentity };
  const staleOwner = acquireLock(lockPath, owner);
  if (staleOwner) {
    if (!fs.existsSync(journalPath)) fail('RECOVERY_JOURNAL_MISSING');
    const recovered = resumeTransaction(journalPath, lockPath, staleOwner, expected, root, publications);
    return freeze({ status: 'RECOVERED', planDigest: expected.planDigest, ...recovered, threatBoundary: expected.threatBoundary });
  }
  const records = [];
  try {
    for (const publication of publications) {
      portableKey(publication.relative); const identity = canonicalPathIdentity(publication.relative, root); const target = identity.declaredAbsolutePath;
      if (fs.existsSync(target)) {
        if (!fs.statSync(target).isFile() || !fs.readFileSync(target).equals(Buffer.from(publication.bytes))) fail('MATERIALIZATION_CONFLICT', { path: publication.relative });
       records.push({ path: publication.relative, target, digest: sha256Bytes(publication.bytes), state: 'existing', targetIdentity: objectIdentity(target) }); continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const temp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
      durableWrite(temp, publication.bytes, 'wx');
      records.push({ path: publication.relative, target, temp, digest: sha256Bytes(publication.bytes), state: 'prepared', tempIdentity: objectIdentity(temp) });
    }
    journalWrite(journalPath, { schemaVersion: 1, transactionId: owner.transactionId, planDigest: expected.planDigest, workspaceIdentity: expected.authorization.workspaceIdentity, state: 'prepared', records });
    for (const record of records.filter((item) => item.state === 'prepared')) {
      canonicalPathIdentity(record.path, root); fs.linkSync(record.temp, record.target); record.targetIdentity = objectIdentity(record.target); removeKnown(record.temp, record.tempIdentity, record.digest); record.state = 'created';
      const finalIdentity = canonicalPathIdentity(record.path, root, { mustExist: true });
      if (finalIdentity.canonicalAbsolutePath !== canonicalPathIdentity(record.path, root).canonicalAbsolutePath || sha256Bytes(fs.readFileSync(record.target)) !== record.digest) fail('POST_WRITE_VERIFICATION_FAILED', { path: record.path });
      journalWrite(journalPath, { schemaVersion: 1, transactionId: owner.transactionId, planDigest: expected.planDigest, workspaceIdentity: expected.authorization.workspaceIdentity, state: 'publishing', records });
    }
    fs.rmSync(journalPath); fs.rmSync(lockPath, { recursive: true });
    return freeze({ status: 'MATERIALIZED', planDigest: expected.planDigest, created: records.filter((r) => r.state === 'created').map((r) => r.path), unchanged: records.filter((r) => r.state === 'existing').map((r) => r.path), threatBoundary: expected.threatBoundary });
  } catch (error) {
    for (const record of [...records].reverse()) {
      try {
        if (record.temp) removeKnown(record.temp, record.tempIdentity, record.digest);
        if (record.state === 'created') removeKnown(record.target, record.targetIdentity, record.digest);
      } catch (rollbackError) { if (rollbackError instanceof BlueprintError) error.rollbackError = rollbackError.code; }
    }
    try { fs.rmSync(journalPath); } catch {}
    try { fs.rmSync(lockPath, { recursive: true }); } catch {}
    throw error;
  }
}
export const materialize = materializeScaffold;

function acquireAttemptLedgerLock(lock, planDigest, ledgerPath) {
  const owner = { schemaVersion: 1, pid: process.pid, transactionId: randomUUID(), planDigest, workspaceIdentity: canonicalHash({ ledgerPath }) };
  const stale = acquireLock(lock, owner);
  if (!stale) return;
  if (!Number.isSafeInteger(stale.pid) || stale.pid <= 0 || typeof stale.transactionId !== 'string' || !stale.transactionId || !DIGEST.test(stale.planDigest ?? '') || stale.workspaceIdentity !== owner.workspaceIdentity) fail('LOCK_IDENTITY_UNCERTAIN');
  let entries;
  try { entries = fs.readdirSync(lock); } catch { fail('LOCK_IDENTITY_UNCERTAIN'); }
  if (entries.length !== 1 || entries[0] !== 'owner.json') fail('LOCK_IDENTITY_UNCERTAIN');
  const recovery = `${lock}.stale-${process.pid}-${randomUUID()}`;
  try { fs.renameSync(lock, recovery); } catch { fail('PIPELINE_LOCKED'); }
  try {
    const moved = readStrictJson(path.join(recovery, 'owner.json'), 'LOCK_IDENTITY_UNCERTAIN');
    if (canonicalJson(moved) !== canonicalJson(stale) || processAlive(moved.pid)) fail('LOCK_IDENTITY_UNCERTAIN');
    fs.rmSync(recovery, { recursive: true });
    acquireLock(lock, owner);
  } catch (error) {
    try { if (fs.existsSync(recovery) && !fs.existsSync(lock)) fs.renameSync(recovery, lock); } catch {}
    throw error;
  }
}
function validateAttemptLedger(state, plan) {
  if (!ownKeys(state, ['schemaVersion', 'planDigest', 'nodes']) || state.schemaVersion !== ATTEMPT_LEDGER_SCHEMA_VERSION || state.planDigest !== plan.planDigest || !state.nodes || typeof state.nodes !== 'object' || Array.isArray(state.nodes)) fail('ATTEMPT_LEDGER_INVALID');
  const contracts = new Map(plan.nodes.map((node) => [node.id, node])), attemptIds = new Set(), resultDigests = new Set();
  for (const [nodeId, node] of Object.entries(state.nodes)) {
    const contract = contracts.get(nodeId);
    if (!contract || !ownKeys(node, ['retryCap', 'status', 'attempts']) || node.retryCap !== contract.retryCap || !['READY', 'RUNNING', 'SUCCEEDED', 'ESCALATED'].includes(node.status) || !Array.isArray(node.attempts)) fail('ATTEMPT_LEDGER_INVALID');
    for (let index = 0; index < node.attempts.length; index += 1) {
      const attempt = node.attempts[index], terminal = attempt?.status === 'FAILED' || attempt?.status === 'SUCCEEDED';
      if (!ownKeys(attempt, ['attemptId', 'ordinal', 'status'], terminal ? ['resultDigest', 'failureReason'] : []) || typeof attempt.attemptId !== 'string' || !attempt.attemptId || attempt.ordinal !== index + 1 || !['RUNNING', 'FAILED', 'SUCCEEDED'].includes(attempt.status) || (terminal && !DIGEST.test(attempt.resultDigest ?? '')) || (!terminal && Object.hasOwn(attempt, 'resultDigest')) || (attempt.failureReason !== undefined && (attempt.status !== 'FAILED' || !['budget_exceeded', 'usage_unobserved'].includes(attempt.failureReason))) || attemptIds.has(attempt.attemptId) || (terminal && resultDigests.has(attempt.resultDigest))) fail('ATTEMPT_LEDGER_INVALID');
      attemptIds.add(attempt.attemptId); if (terminal) resultDigests.add(attempt.resultDigest);
    }
    const statuses = node.attempts.map((attempt) => attempt.status), last = statuses.at(-1), terminalUsageFailureIndex = node.attempts.findIndex((attempt) => ['budget_exceeded', 'usage_unobserved'].includes(attempt.failureReason)), hasTerminalUsageFailure = terminalUsageFailureIndex >= 0;
    const consistent = node.status === 'READY' ? !hasTerminalUsageFailure && statuses.every((status) => status === 'FAILED') && statuses.length <= node.retryCap
      : node.status === 'RUNNING' ? !hasTerminalUsageFailure && last === 'RUNNING' && statuses.slice(0, -1).every((status) => status === 'FAILED')
        : node.status === 'SUCCEEDED' ? !hasTerminalUsageFailure && last === 'SUCCEEDED' && statuses.slice(0, -1).every((status) => status === 'FAILED')
          : statuses.every((status) => status === 'FAILED') && ((!hasTerminalUsageFailure && statuses.length === node.retryCap + 1) || terminalUsageFailureIndex === node.attempts.length - 1);
    if (!consistent || node.attempts.length > node.retryCap + 1) fail('ATTEMPT_LEDGER_INVALID');
  }
  for (const [nodeId, node] of Object.entries(state.nodes)) {
    if (node.attempts.length > 0 && contracts.get(nodeId).dependsOn.some((dependency) => state.nodes[dependency]?.status !== 'SUCCEEDED')) fail('ATTEMPT_LEDGER_INVALID');
  }
  return state;
}
function withLedgerLock(file, plan, callback, planMismatchCode = 'ATTEMPT_LEDGER_INVALID') {
  const absolute = path.resolve(file), lock = `${absolute}.lock`; fs.mkdirSync(path.dirname(absolute), { recursive: true }); acquireAttemptLedgerLock(lock, plan.planDigest, absolute);
  try {
    let state;
    try { state = fs.existsSync(absolute) ? JSON.parse(fs.readFileSync(absolute, 'utf8')) : undefined; }
    catch { fail('ATTEMPT_LEDGER_INVALID'); }
    if (state !== undefined) {
      if (state?.planDigest !== plan.planDigest) fail(planMismatchCode);
      validateAttemptLedger(state, plan);
    }
    const result = callback(state); journalWrite(absolute, result.state); return result.value;
  }
  finally { fs.rmSync(path.join(lock, 'owner.json')); fs.rmdirSync(lock); }
}
function authoritativeNode(plan, nodeId) {
  if (!plan || typeof plan !== 'object' || plan.planDigest !== canonicalHash(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'planDigest'))) || !Array.isArray(plan.nodes)) fail('ATTEMPT_PLAN_INVALID');
  const node = plan.nodes.find((item) => item.id === nodeId); if (!node) fail('ATTEMPT_NODE_UNDECLARED'); return node;
}
export function beginNodeAttempt(args) {
  if (!ownKeys(args, ['ledgerPath', 'plan', 'nodeId'], ['attemptId'])) fail('ATTEMPT_INVALID');
  const { ledgerPath, plan, nodeId, attemptId = randomUUID() } = args;
  const contract = authoritativeNode(plan, nodeId), retryCap = contract.retryCap;
  if (typeof nodeId !== 'string' || !nodeId || typeof attemptId !== 'string' || !attemptId) fail('ATTEMPT_INVALID');
  return withLedgerLock(ledgerPath, plan, (current) => {
    const state = current ?? { schemaVersion: ATTEMPT_LEDGER_SCHEMA_VERSION, planDigest: plan.planDigest, nodes: {} };
    validateAttemptLedger(state, plan);
    if (contract.dependsOn.some((dependency) => state.nodes[dependency]?.status !== 'SUCCEEDED')) fail('ATTEMPT_DEPENDENCIES_INCOMPLETE');
    const node = state.nodes[nodeId] ?? { retryCap, status: 'READY', attempts: [] };
    if (node.retryCap !== retryCap) fail('RETRY_CAP_MUTATED');
    if (node.status === 'RUNNING') fail('ATTEMPT_ALREADY_RUNNING');
    if (node.status === 'SUCCEEDED') fail('ATTEMPT_TERMINAL');
    if (node.status === 'ESCALATED' || node.attempts.length >= retryCap + 1) { node.status = 'ESCALATED'; state.nodes[nodeId] = node; return { state, value: freeze({ nodeId, status: 'ESCALATED', attempts: node.attempts.length }) }; }
    if (Object.values(state.nodes).some((entry) => entry.attempts?.some((attempt) => attempt.attemptId === attemptId))) fail('ATTEMPT_ID_REPLAY');
    node.attempts.push({ attemptId, ordinal: node.attempts.length + 1, status: 'RUNNING' }); node.status = 'RUNNING'; state.nodes[nodeId] = node;
    return { state, value: freeze({ nodeId, attemptId, ordinal: node.attempts.length, status: 'RUNNING' }) };
  });
}
export const beginAttempt = beginNodeAttempt;
export function completeNodeAttempt({ ledgerPath, plan, nodeId, attemptId, resultDigest, outcome }) {
  authoritativeNode(plan, nodeId);
  if (!DIGEST.test(resultDigest ?? '') || !['succeeded', 'failed', 'budget_exceeded', 'usage_unobserved'].includes(outcome)) fail('ATTEMPT_RESULT_INVALID');
  return withLedgerLock(ledgerPath, plan, (state) => {
    if (state?.planDigest !== plan.planDigest) fail('ATTEMPT_PLAN_MISMATCH');
    const node = state?.nodes?.[nodeId], attempt = node?.attempts?.find((item) => item.attemptId === attemptId);
    if (!node || node.status !== 'RUNNING' || !attempt || attempt.status !== 'RUNNING') fail('ATTEMPT_NOT_RUNNING');
    if (Object.values(state.nodes).some((entry) => entry.attempts?.some((item) => item.resultDigest === resultDigest))) fail('RESULT_DIGEST_REPLAY');
    attempt.status = outcome === 'succeeded' ? 'SUCCEEDED' : 'FAILED'; attempt.resultDigest = resultDigest;
    if (['budget_exceeded', 'usage_unobserved'].includes(outcome)) attempt.failureReason = outcome;
    node.status = outcome === 'succeeded' ? 'SUCCEEDED' : (['budget_exceeded', 'usage_unobserved'].includes(outcome) || node.attempts.length >= node.retryCap + 1 ? 'ESCALATED' : 'READY');
    return { state, value: freeze({ nodeId, attemptId, status: node.status, attempts: node.attempts.length }) };
  }, 'ATTEMPT_PLAN_MISMATCH');
}
export const completeAttempt = completeNodeAttempt;
export function readAttemptLedger(ledgerPath, plan) {
  let state; try { state = JSON.parse(fs.readFileSync(path.resolve(ledgerPath), 'utf8')); } catch { fail('ATTEMPT_LEDGER_INVALID'); }
  if (plan !== undefined) {
    if (!plan || typeof plan !== 'object' || plan.planDigest !== canonicalHash(Object.fromEntries(Object.entries(plan).filter(([key]) => key !== 'planDigest'))) || !Array.isArray(plan.nodes)) fail('ATTEMPT_PLAN_INVALID');
    validateAttemptLedger(state, plan);
  }
  return state;
}

function compareGraph({ blueprint, policy, observedGraph }, phase) {
  validateBlueprint(blueprint, policy);
  const graphObject = observedGraph && typeof observedGraph === 'object' && !Array.isArray(observedGraph);
  const hasEdges = graphObject && Object.hasOwn(observedGraph, 'edges');
  const hasLinks = graphObject && Object.hasOwn(observedGraph, 'links');
  const rawGraphifyKeys = ['nodes', 'edges', 'hyperedges', 'input_tokens', 'output_tokens'];
  const rawGraphify = graphObject && hasEdges && !hasLinks && !Object.hasOwn(observedGraph, 'directed') && !Object.hasOwn(observedGraph, 'edgeDirection') && rawGraphifyKeys.every((key) => Object.hasOwn(observedGraph, key)) && Object.keys(observedGraph).every((key) => rawGraphifyKeys.includes(key)) && Array.isArray(observedGraph.hyperedges) && Number.isFinite(observedGraph.input_tokens) && observedGraph.input_tokens >= 0 && Number.isFinite(observedGraph.output_tokens) && observedGraph.output_tokens >= 0;
  const nativeGraphify = hasLinks || rawGraphify;
  const directionValid = graphObject && (nativeGraphify
    ? (rawGraphify || typeof observedGraph.directed === 'boolean')
    : observedGraph.directed === true && observedGraph.edgeDirection === blueprint.graphPolicy.edgeDirection);
  if (!graphObject || !directionValid || (Object.hasOwn(observedGraph, 'edgeDirection') && observedGraph.edgeDirection !== blueprint.graphPolicy.edgeDirection) || !Array.isArray(observedGraph.nodes) || hasEdges === hasLinks) fail('OBSERVED_GRAPH_INVALID');
  const observedEdges = hasLinks ? observedGraph.links : observedGraph.edges;
  if (!Array.isArray(observedEdges)) fail('OBSERVED_GRAPH_INVALID');
  const declared = new Map(blueprint.files.map((file) => [portableKey(file.path), file.path]));
  const mapped = new Map(), nodeIds = new Set(), nodesById = new Map(), nodeFiles = new Map(), edgeIds = new Set(), errors = [];
  for (const node of observedGraph.nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node) || typeof node.id !== 'string' || !node.id || nodeIds.has(node.id)) fail('OBSERVED_GRAPH_INVALID');
    nodeIds.add(node.id); nodesById.set(node.id, node);
    // Graphify may add semantic/concept nodes without source provenance. They
    // are outside the file projection and cannot establish a file dependency.
    if (typeof node.source_file !== 'string' || node.source_file.length === 0) continue;
    let key; try { key = portableKey(node.source_file, 'OBSERVED_SOURCE_INVALID'); } catch (error) { errors.push({ code: error.code, nodeId: node.id }); continue; }
    const mappedSource = mapped.get(key);
    if (mappedSource !== undefined && mappedSource !== node.source_file) errors.push({ code: 'DUPLICATE_SOURCE_MAPPING', source: node.source_file }); else mapped.set(key, node.source_file);
    if (declared.has(key) && declared.get(key) !== node.source_file) errors.push({ code: 'DUPLICATE_SOURCE_MAPPING', source: node.source_file });
    if (declared.has(key)) nodeFiles.set(node.id, declared.get(key));
    if (!declared.has(key) && phase === undefined) errors.push({ code: 'UNEXPECTED_SOURCE_FILE', source: node.source_file });
  }
  for (const [key, source] of declared) if (!mapped.has(key)) errors.push({ code: 'DECLARED_FILE_MISSING', source });
  const expected = new Set(); for (const file of blueprint.files) for (const dep of file.dependsOn) expected.add(`${portableKey(file.path)}->${portableKey(dep)}`);
  const actual = new Set();
  for (const edge of observedEdges) {
    if (!edge || typeof edge !== 'object' || Array.isArray(edge) || typeof edge.source !== 'string' || typeof edge.target !== 'string' || !nodeIds.has(edge.source) || !nodeIds.has(edge.target)) { errors.push({ code: 'DANGLING_EDGE' }); continue; }
    if (nativeGraphify) {
      if (typeof edge.relation !== 'string' || edge.relation.length === 0) fail('OBSERVED_GRAPH_INVALID');
      if (!GRAPHIFY_DEPENDENCY_RELATIONS.includes(edge.relation)) continue;
    }
    if (edge.source === edge.target) { errors.push({ code: 'SELF_LOOP', nodeId: edge.source }); continue; }
    const sourceNode = nodesById.get(edge.source), targetNode = nodesById.get(edge.target), edgeId = canonicalJson([edge.source, edge.target]);
    if (!nativeGraphify && edgeIds.has(edgeId)) { errors.push({ code: 'DUPLICATE_EDGE', edge: edgeId }); continue; }
    edgeIds.add(edgeId);
    if (!nodeFiles.has(edge.source) || !nodeFiles.has(edge.target)) continue;
    try {
      const sourceKey = portableKey(nodeFiles.get(edge.source) ?? sourceNode.source_file), targetKey = portableKey(nodeFiles.get(edge.target) ?? targetNode.source_file);
      if (sourceKey !== targetKey) actual.add(`${sourceKey}->${targetKey}`);
    } catch { errors.push({ code: 'EDGE_SOURCE_INVALID' }); }
  }
  const missingEdges = phase === 'structure' ? [] : [...expected].filter((edge) => !actual.has(edge)).sort();
  const unexpectedEdges = phase === 'structure' ? [] : [...actual].filter((edge) => !expected.has(edge)).sort();
  const body = { schemaVersion: OBSERVED_GRAPH_REPORT_VERSION, ...(phase === undefined ? {} : { phase }), direction: 'source-depends-on-target', matches: errors.length === 0 && missingEdges.length === 0 && unexpectedEdges.length === 0, missingEdges, unexpectedEdges, errors: errors.sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b))) };
  return freeze({ ...body, reportDigest: canonicalHash(body) });
}
export function compareObservedGraph(args) { return compareGraph(args); }
export function compareObservedGraphPhase(args) {
  if (!args || !['structure', 'dependencies'].includes(args.phase)) fail('OBSERVED_GRAPH_PHASE_INVALID');
  return compareGraph(args, args.phase);
}
export const compareScaffoldGraph = compareObservedGraphPhase;
export const comparePhasedObservedGraph = compareObservedGraphPhase;
export const compareDeclaredToObserved = compareObservedGraph;
export function compareObservedGraphFile({ blueprint, policy, graphPath }) {
  let observedGraph; try { observedGraph = JSON.parse(fs.readFileSync(graphPath, 'utf8')); } catch { fail('OBSERVED_GRAPH_UNREADABLE'); }
  return compareObservedGraph({ blueprint, policy, observedGraph });
}
