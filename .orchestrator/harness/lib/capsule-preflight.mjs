import fs from 'node:fs';
import path from 'node:path';
import { canonicalPathIdentity, resolveWorkspaceRoot } from './path-identity.mjs';

export class CapsulePreflightError extends Error {
  constructor(code, details = {}) { super(code); this.name = 'CapsulePreflightError'; this.code = code; this.details = details; }
}
const six = ['ACCEPTANCE.md', 'BUDGET.json', 'CONTEXT.md', 'OWNERSHIP.json', 'RESULT.md', 'TASK.md'];
const childOf = (target, root) => target === root || target.startsWith(`${root}${path.sep}`);
function identity(value, root, code) {
  try { return canonicalPathIdentity(value, root); }
  catch (error) { throw new CapsulePreflightError(code, { path: value, pathCode: error.code }); }
}
function policyIdentity(value, root) {
  try { return canonicalPathIdentity(value, root); }
  catch (error) { if (error.code === 'PATH_OUTSIDE_WORKSPACE' || error.code === 'PATH_REPARSE_ESCAPE') return null; throw new CapsulePreflightError('OWNERSHIP_INVALID', { path: value, pathCode: error.code }); }
}

export function readCapsule(capsuleDir) {
  const root = path.resolve(capsuleDir);
  const files = Object.fromEntries(six.map((name) => [name, fs.readFileSync(path.join(root, name), 'utf8')]));
  let ownership;
  try { ownership = JSON.parse(files['OWNERSHIP.json']); } catch { throw new CapsulePreflightError('OWNERSHIP_INVALID'); }
  if (typeof ownership.worktreePath !== 'string' || !Array.isArray(ownership.allowedReadRoots) || !Array.isArray(ownership.allowedWriteFiles) || !Array.isArray(ownership.forbiddenPaths)) throw new CapsulePreflightError('OWNERSHIP_INVALID');
  return Object.freeze({ root, files: Object.freeze(files), ownership });
}

export function preflightCapsules({ capsuleDir, parallelCapsuleDirs = [], reads = [], writes } = {}) {
  const capsule = readCapsule(capsuleDir);
  let workspace;
  try { workspace = resolveWorkspaceRoot(capsule.ownership.worktreePath); } catch (error) { throw new CapsulePreflightError('OWNERSHIP_INVALID', { pathCode: error.code }); }
  const allowed = capsule.ownership.allowedWriteFiles.map((item) => identity(item, workspace, 'OWNERSHIP_INVALID').canonicalAbsolutePath);
  const readable = capsule.ownership.allowedReadRoots.map((item) => identity(item, workspace, 'OWNERSHIP_INVALID').canonicalAbsolutePath);
  const forbidden = capsule.ownership.forbiddenPaths.map((item) => policyIdentity(item, workspace)).filter(Boolean).map((item) => item.canonicalAbsolutePath);
  const requestedReads = reads.map((item) => identity(item, workspace, 'READ_FORBIDDEN'));
  const requested = (writes ?? capsule.ownership.allowedWriteFiles).map((item) => identity(item, workspace, 'WRITE_FORBIDDEN'));
  for (const target of requestedReads) {
    if (forbidden.some((root) => childOf(target.canonicalAbsolutePath, root))) throw new CapsulePreflightError('READ_FORBIDDEN', { target: target.declaredPath });
    if (!readable.some((root) => childOf(target.canonicalAbsolutePath, root))) throw new CapsulePreflightError('READ_NOT_ALLOWED', { target: target.declaredPath });
  }
  for (const target of requested) {
    if (forbidden.some((root) => childOf(target.canonicalAbsolutePath, root))) throw new CapsulePreflightError('WRITE_FORBIDDEN', { target: target.declaredPath });
    if (!allowed.includes(target.canonicalAbsolutePath)) throw new CapsulePreflightError('WRITE_NOT_OWNED', { target: target.declaredPath });
  }
  for (const peerDir of parallelCapsuleDirs) {
    const peer = readCapsule(peerDir);
    let peerWorkspace;
    try { peerWorkspace = resolveWorkspaceRoot(peer.ownership.worktreePath); } catch (error) { throw new CapsulePreflightError('OWNERSHIP_INVALID', { pathCode: error.code }); }
    const peerWrites = new Set(peer.ownership.allowedWriteFiles.map((item) => identity(item, peerWorkspace, 'OWNERSHIP_INVALID').canonicalAbsolutePath));
    const overlap = requested.find((target) => peerWrites.has(target.canonicalAbsolutePath));
    if (overlap) throw new CapsulePreflightError('PARALLEL_WRITE_OVERLAP', { target: overlap.declaredPath, peer: peer.root });
  }
  return Object.freeze({ capsule, reads: Object.freeze(requestedReads.map((item) => item.canonicalAbsolutePath)), writes: Object.freeze(requested.map((item) => item.canonicalAbsolutePath)) });
}
