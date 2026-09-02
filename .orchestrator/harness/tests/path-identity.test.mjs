import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { assertPathIdentityUnchanged, canonicalPathIdentity, PathIdentityError, resolveWorkspaceRoot } from '../lib/path-identity.mjs';

function workspace(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-a-path-'));
  const root = path.join(parent, 'Workspace');
  fs.mkdirSync(path.join(root, 'Owned'), { recursive: true });
  fs.writeFileSync(path.join(root, 'Owned', 'File.txt'), 'x');
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return { parent, root };
}

function code(expected) {
  return (error) => error instanceof PathIdentityError && error.code === expected;
}

test('relative, absolute, separator, dot, and nonexistent suffix spellings converge', (t) => {
  const { root } = workspace(t);
  const rootIdentity = resolveWorkspaceRoot(root);
  const relative = canonicalPathIdentity(path.join('Owned', '.', 'Missing', '..', 'File.txt'), rootIdentity);
  const absolute = canonicalPathIdentity(path.join(root, 'Owned', 'File.txt'), rootIdentity);
  assert.equal(relative.canonicalAbsolutePath, absolute.canonicalAbsolutePath);
  assert.equal(relative.lockHash, absolute.lockHash);
  const missingA = canonicalPathIdentity(path.join('Owned', 'New', '..', 'New', 'child.txt'), rootIdentity);
  const missingB = canonicalPathIdentity(path.join(root, 'Owned', 'New', 'child.txt'), rootIdentity);
  assert.equal(missingA.lockHash, missingB.lockHash);
});

test('Windows case, slash, drive, and UNC aliases converge', { skip: process.platform !== 'win32' }, (t) => {
  const { root } = workspace(t);
  const driveVariant = root.replace(/^([A-Z]):/u, (_, drive) => `${drive.toLocaleLowerCase('en-US')}:`).toLocaleUpperCase('en-US');
  const spellings = [
    path.join(root, 'Owned', 'File.txt'),
    `${driveVariant.replaceAll('\\', '/').toLocaleLowerCase('en-US')}/owned/./file.txt`,
    path.join(root, 'OWNED', '..', 'Owned', 'FILE.TXT'),
  ].map((value) => canonicalPathIdentity(value, root));
  assert.equal(new Set(spellings.map((value) => value.lockHash)).size, 1);

  const parsed = path.parse(root);
  const uncRoot = `\\\\localhost\\${parsed.root[0]}$${root.slice(parsed.root.length - 1)}`;
  assert.equal(fs.existsSync(uncRoot), true, 'administrative localhost share required for deterministic UNC test');
  const uncA = canonicalPathIdentity(`${uncRoot}\\Owned\\File.txt`, uncRoot);
  const uncB = canonicalPathIdentity(`${uncRoot.toLocaleUpperCase('en-US').replaceAll('\\', '/')}//owned/./file.txt`, uncRoot);
  assert.equal(uncA.lockHash, uncB.lockHash);
});

test('POSIX case remains significant', { skip: process.platform === 'win32' }, (t) => {
  const { root } = workspace(t);
  fs.mkdirSync(path.join(root, 'owned'));
  fs.writeFileSync(path.join(root, 'owned', 'File.txt'), 'y');
  const upper = canonicalPathIdentity(path.join(root, 'Owned', 'File.txt'), root);
  const lower = canonicalPathIdentity(path.join(root, 'owned', 'File.txt'), root);
  assert.notEqual(upper.canonicalAbsolutePath, lower.canonicalAbsolutePath);
  assert.notEqual(upper.lockHash, lower.lockHash);
});

test('cross-root, cross-volume, device, NUL, glob, and UNC-outside-root reject without artifacts', (t) => {
  const { parent, root } = workspace(t);
  const marker = path.join(root, '.events.lock');
  const candidates = [
    [path.join(parent, 'outside.txt'), 'PATH_OUTSIDE_WORKSPACE'],
    ['bad\0path', 'PATH_NUL_FORBIDDEN'],
    ['Owned/*.txt', 'PATH_GLOB_FORBIDDEN'],
  ];
  if (process.platform === 'win32') {
    candidates.push(['Z:\\outside.txt', 'PATH_CROSS_VOLUME_FORBIDDEN']);
    candidates.push(['\\\\.\\pipe\\ecc-test', 'PATH_DEVICE_FORBIDDEN']);
    candidates.push(['\\\\localhost\\C$\\Windows', 'PATH_CROSS_VOLUME_FORBIDDEN']);
  }
  for (const [candidate, expected] of candidates) {
    assert.throws(() => canonicalPathIdentity(candidate, root), code(expected), candidate);
    assert.equal(fs.existsSync(marker), false);
  }
});

test('reparse aliases inside converge and reparse escapes reject', { skip: process.platform !== 'win32' }, (t) => {
  const { parent, root } = workspace(t);
  const insideTarget = path.join(root, 'Owned');
  const insideAlias = path.join(root, 'InsideAlias');
  const outsideTarget = path.join(parent, 'Outside');
  const outsideAlias = path.join(root, 'OutsideAlias');
  fs.mkdirSync(outsideTarget);
  fs.symlinkSync(insideTarget, insideAlias, 'junction');
  fs.symlinkSync(outsideTarget, outsideAlias, 'junction');
  const direct = canonicalPathIdentity(path.join(insideTarget, 'File.txt'), root);
  const alias = canonicalPathIdentity(path.join(insideAlias, 'File.txt'), root);
  assert.equal(direct.lockHash, alias.lockHash);
  assert.throws(() => canonicalPathIdentity(path.join(outsideAlias, 'new.txt'), root), code('PATH_REPARSE_ESCAPE'));
  assert.equal(fs.existsSync(path.join(root, '.events.lock')), false);
});

test('admission-time identity drift is rejected', { skip: process.platform !== 'win32' }, (t) => {
  const { parent, root } = workspace(t);
  const targetA = path.join(root, 'Owned');
  const targetB = path.join(root, 'Other');
  const alias = path.join(root, 'Alias');
  fs.mkdirSync(targetB);
  fs.symlinkSync(targetA, alias, 'junction');
  const identity = canonicalPathIdentity(path.join(alias, 'File.txt'), root);
  fs.rmSync(alias);
  fs.symlinkSync(targetB, alias, 'junction');
  assert.throws(() => assertPathIdentityUnchanged(identity, root), code('PATH_IDENTITY_DRIFT'));
  assert.equal(fs.existsSync(path.join(parent, '.events.lock')), false);
});
