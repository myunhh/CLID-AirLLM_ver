import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const harness = path.resolve(import.meta.dirname, '..');
const cutover = path.join(harness, 'shim-cutover.mjs');
const legacy = path.resolve(harness, '..', 'kernel-bridge');
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
function run(root, command) {
  return spawnSync(process.execPath, [cutover, command], { encoding: 'utf8', env: { ...process.env, ECC_SHIM_CUTOVER_ROOT: root } });
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-shim-cutover-'));
  const directory = path.join(root, '.orchestrator', 'kernel-bridge');
  fs.mkdirSync(directory, { recursive: true });
  for (const name of ['kernel_bridge.py', 'verify_events.py']) fs.copyFileSync(path.join(legacy, name), path.join(directory, name));
  return root;
}
test('snapshot, atomic install, failure restoration, and explicit idempotent restore preserve exact legacy bytes', () => {
  const root = fixture();
  try {
    const targets = ['kernel_bridge.py', 'verify_events.py'].map((name) => path.join(root, '.orchestrator', 'kernel-bridge', name));
    const original = targets.map((target) => fs.readFileSync(target));
    let result = run(root, 'snapshot');
    assert.equal(result.status, 0, result.stderr);
    const manifestPath = path.join(root, '.orchestrator', 'kernel-bridge', 'shim-cutover-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    for (const [index, entry] of manifest.shims.entries()) {
      const backup = fs.readFileSync(path.join(root, entry.backupPath));
      assert.equal(entry.byteLength, original[index].length);
      assert.equal(entry.sha256, hash(original[index]));
      assert.deepEqual(backup, original[index]);
    }
    result = run(root, 'install');
    assert.equal(result.status, 0, result.stderr);
    result = run(root, 'verify');
    assert.equal(result.status, 0, result.stderr);
    for (const target of targets) assert.match(fs.readFileSync(target, 'utf8'), /bridge-launcher\.mjs|verify-events\.mjs/u);
    fs.writeFileSync(targets[0], 'broken');
    result = run(root, 'verify');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SHIM_VERIFICATION_FAILED/u);
    assert.deepEqual(fs.readFileSync(targets[0]), original[0]);
    assert.deepEqual(fs.readFileSync(targets[1]), original[1]);
    result = run(root, 'install');
    assert.equal(result.status, 0, result.stderr);
    result = run(root, 'restore');
    assert.equal(result.status, 0, result.stderr);
    result = run(root, 'restore');
    assert.equal(result.status, 0, result.stderr);
    for (const [index, target] of targets.entries()) assert.deepEqual(fs.readFileSync(target), original[index]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('installed live entrypoints use the launcher-selected interpreter and forward canonical exits', () => {
  const result = spawnSync(process.execPath, [cutover, 'test'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('a temp-fixture shim test failure restores both exact original entries', () => {
  const root = fixture();
  try {
    const targets = ['kernel_bridge.py', 'verify_events.py'].map((name) => path.join(root, '.orchestrator', 'kernel-bridge', name));
    const original = targets.map((target) => fs.readFileSync(target));
    assert.equal(run(root, 'snapshot').status, 0);
    assert.equal(run(root, 'install').status, 0);
    const result = spawnSync(process.execPath, [cutover, 'test'], { encoding: 'utf8', env: { ...process.env, ECC_SHIM_CUTOVER_ROOT: root, ECC_SHIM_CUTOVER_TEST_INJECT_FAILURE: '1' } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SHIM_TEST_INJECTED_FAILURE/u);
    for (const [index, target] of targets.entries()) assert.deepEqual(fs.readFileSync(target), original[index]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
