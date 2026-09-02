import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { preflightCapsules } from '../lib/capsule-preflight.mjs';

function capsule(root, writes, reads = [root], worktreePath = path.dirname(root)) {
  fs.mkdirSync(root, { recursive: true });
  for (const name of ['ACCEPTANCE.md', 'CONTEXT.md', 'RESULT.md', 'TASK.md']) fs.writeFileSync(path.join(root, name), 'x');
  fs.writeFileSync(path.join(root, 'BUDGET.json'), '{}');
  fs.mkdirSync(path.join(root, 'forbidden'), { recursive: true });
  fs.writeFileSync(path.join(root, 'OWNERSHIP.json'), JSON.stringify({ worktreePath, allowedReadRoots: reads, allowedWriteFiles: writes, forbiddenPaths: [path.join(root, 'forbidden')] }));
}
test('preflight rejects unowned and overlapping writes before execution', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-preflight-'));
  try {
    const one = path.join(root, 'one'); const two = path.join(root, 'two'); const target = path.join(root, 'owned.mjs');
    capsule(one, [target], [root], root); capsule(two, [target], [root], root);
    assert.throws(() => preflightCapsules({ capsuleDir: one, writes: [path.join(root, 'other.mjs')] }), { code: 'WRITE_NOT_OWNED' });
    assert.throws(() => preflightCapsules({ capsuleDir: one, parallelCapsuleDirs: [two] }), { code: 'PARALLEL_WRITE_OVERLAP' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('preflight rejects unapproved or forbidden reads and forbidden writes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-preflight-'));
  try {
    const one = path.join(root, 'one'); const owned = path.join(one, 'owned.mjs'); const forbidden = path.join(one, 'forbidden', 'blocked.mjs');
    capsule(one, [owned], [one], root);
    assert.throws(() => preflightCapsules({ capsuleDir: one, reads: [path.join(root, 'outside.txt')] }), { code: 'READ_NOT_ALLOWED' });
    assert.throws(() => preflightCapsules({ capsuleDir: one, reads: [forbidden] }), { code: 'READ_FORBIDDEN' });
    assert.throws(() => preflightCapsules({ capsuleDir: one, writes: [forbidden] }), { code: 'WRITE_FORBIDDEN' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('canonical identities reject link escapes and detect aliased peer writes', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-preflight-'));
  try {
    const one = path.join(root, 'one'); const two = path.join(root, 'two'); const shared = path.join(root, 'shared'); const alias = path.join(root, 'alias');
    fs.mkdirSync(shared); capsule(one, [path.join(shared, 'file.mjs')], [root], root); capsule(two, [path.join(alias, 'file.mjs')], [root], root);
    try { fs.symlinkSync(shared, alias, process.platform === 'win32' ? 'junction' : 'dir'); } catch { t.skip('link creation unsupported on this platform'); return; }
    assert.throws(() => preflightCapsules({ capsuleDir: one, parallelCapsuleDirs: [two] }), { code: 'PARALLEL_WRITE_OVERLAP' });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-outside-')); const escape = path.join(root, 'escape');
    fs.symlinkSync(outside, escape, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => preflightCapsules({ capsuleDir: one, reads: [path.join(escape, 'secret.txt')] }), { code: 'READ_FORBIDDEN' });
    fs.rmSync(outside, { recursive: true, force: true });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
