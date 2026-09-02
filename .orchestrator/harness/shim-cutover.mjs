#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workspace = path.resolve(process.env.ECC_SHIM_CUTOVER_ROOT ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
const legacyDirectory = path.join(workspace, '.orchestrator', 'kernel-bridge');
const manifestPath = path.join(legacyDirectory, 'shim-cutover-manifest.json');
const names = ['kernel_bridge.py', 'verify_events.py'];
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const relative = (file) => path.relative(workspace, file).replaceAll('\\', '/');
const fail = (code) => Object.assign(new Error(code), { code });

function atomicWrite(file, bytes) {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.cutover-${process.pid}-${crypto.randomUUID()}`);
  let descriptor;
  try { descriptor = fs.openSync(temporary, 'wx'); fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
  try { fs.renameSync(temporary, file); } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
}
function readManifest() {
  if (!fs.existsSync(manifestPath)) throw fail('SHIM_SNAPSHOT_MISSING');
  try { return JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { throw fail('SHIM_RECOVERY_INCOMPATIBLE'); }
}
function validateManifest(manifest) {
  if (manifest?.version !== 1 || !Array.isArray(manifest.shims) || manifest.shims.length !== names.length) throw fail('SHIM_RECOVERY_INCOMPATIBLE');
  for (const name of names) {
    const entry = manifest.shims.find((candidate) => candidate.name === name);
    if (!entry || entry.targetPath !== `.orchestrator/kernel-bridge/${name}` || entry.backupPath !== `.orchestrator/kernel-bridge/${name}.pre-harness-v2` || !Number.isInteger(entry.byteLength) || entry.byteLength < 0 || !/^[0-9a-f]{64}$/u.test(entry.sha256 ?? '')) throw fail('SHIM_RECOVERY_INCOMPATIBLE');
  }
  return manifest;
}
function verifyBackups(manifest) {
  validateManifest(manifest);
  for (const entry of manifest.shims) {
    const backup = path.join(workspace, entry.backupPath);
    if (!fs.existsSync(backup)) throw fail('SHIM_BACKUP_MISSING');
    const bytes = fs.readFileSync(backup);
    if (bytes.length !== entry.byteLength || sha256(bytes) !== entry.sha256) throw fail('SHIM_BACKUP_MISMATCH');
  }
}
function shimFor(name) {
  if (name === 'kernel_bridge.py') return `"""Compatibility shim: delegate to the canonical launcher-selected Bridge."""\nimport subprocess\nimport sys\nfrom pathlib import Path\n\nlauncher = Path(__file__).resolve().parents[2] / ".orchestrator" / "harness" / "bridge-launcher.mjs"\nraise SystemExit(subprocess.run(["node", str(launcher), "python", *sys.argv[1:]], check=False).returncode)\n`;
  return `"""Compatibility shim: delegate verification to the canonical Node verifier."""\nimport subprocess\nimport sys\nfrom pathlib import Path\n\nverifier = Path(__file__).resolve().parents[2] / ".orchestrator" / "harness" / "verify-events.mjs"\nraise SystemExit(subprocess.run(["node", str(verifier), *sys.argv[1:]], check=False).returncode)\n`;
}
function snapshot() {
  const existing = fs.existsSync(manifestPath);
  const backups = names.map((name) => path.join(legacyDirectory, `${name}.pre-harness-v2`));
  if (existing || backups.some((backup) => fs.existsSync(backup))) {
    if (!existing) throw fail('SHIM_RECOVERY_INCOMPATIBLE');
    const manifest = validateManifest(readManifest()); verifyBackups(manifest); console.log(JSON.stringify({ ok: true, snapshot: 'already-present' })); return;
  }
  const entries = names.map((name) => {
    const target = path.join(legacyDirectory, name); if (!fs.existsSync(target)) throw fail('SHIM_TARGET_MISSING');
    const bytes = fs.readFileSync(target); const backup = path.join(legacyDirectory, `${name}.pre-harness-v2`); atomicWrite(backup, bytes);
    return { name, targetPath: relative(target), backupPath: relative(backup), byteLength: bytes.length, sha256: sha256(bytes) };
  });
  const manifest = { version: 1, phase: 'snapshotted', shims: entries };
  try { verifyBackups(manifest); atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`); }
  catch (error) { for (const backup of backups) fs.rmSync(backup, { force: true }); throw error; }
  console.log(JSON.stringify({ ok: true, snapshot: 'created' }));
}
function restoreInternal() {
  const manifest = validateManifest(readManifest()); verifyBackups(manifest);
  for (const entry of manifest.shims) atomicWrite(path.join(workspace, entry.targetPath), fs.readFileSync(path.join(workspace, entry.backupPath)));
}
function installInternal() {
  const manifest = validateManifest(readManifest()); verifyBackups(manifest);
  for (const entry of manifest.shims) atomicWrite(path.join(workspace, entry.targetPath), shimFor(entry.name));
  const installed = { ...manifest, phase: 'installed', shims: manifest.shims.map((entry) => ({ ...entry, shimSha256: sha256(Buffer.from(shimFor(entry.name))) })) };
  atomicWrite(manifestPath, `${JSON.stringify(installed, null, 2)}\n`);
}
function verifyInstalled() {
  const manifest = validateManifest(readManifest()); verifyBackups(manifest);
  if (manifest.phase !== 'installed') throw fail('SHIM_VERIFICATION_FAILED');
  for (const entry of manifest.shims) if (sha256(fs.readFileSync(path.join(workspace, entry.targetPath))) !== entry.shimSha256 || !fs.readFileSync(path.join(workspace, entry.targetPath), 'utf8').includes('Compatibility shim')) throw fail('SHIM_VERIFICATION_FAILED');
}
function selectedPython() {
  const launcher = path.join(workspace, '.orchestrator', 'harness', 'bridge-launcher.mjs');
  const result = spawnSync(process.execPath, [launcher, 'doctor'], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw fail('SHIM_LAUNCHER_SELECTION_FAILED');
  let report; try { report = JSON.parse(result.stdout.trim()); } catch { throw fail('SHIM_LAUNCHER_SELECTION_FAILED'); }
  if (typeof report.interpreter !== 'string' || !report.interpreter) throw fail('SHIM_LAUNCHER_SELECTION_FAILED');
  return report.interpreter === 'py -3' ? { command: 'py', prefix: ['-3'] } : { command: report.interpreter, prefix: [] };
}
function invokeSelected(entry, args) {
  const selected = selectedPython();
  return spawnSync(selected.command, [...selected.prefix, entry, ...args], { encoding: 'utf8', windowsHide: true });
}
function testInstalled() {
  verifyInstalled();
  if (process.env.ECC_SHIM_CUTOVER_TEST_INJECT_FAILURE === '1') throw fail('SHIM_TEST_INJECTED_FAILURE');
  const launcher = path.join(workspace, '.orchestrator', 'harness', 'bridge-launcher.mjs');
  const launcherTests = spawnSync(process.execPath, [launcher, 'run-shim-tests'], { encoding: 'utf8', windowsHide: true });
  if (launcherTests.status !== 0) throw fail('SHIM_LAUNCHER_TEST_FAILED');
  const kernel = path.join(legacyDirectory, 'kernel_bridge.py');
  const verifier = path.join(legacyDirectory, 'verify_events.py');
  const kernelHelp = invokeSelected(kernel, ['--help']);
  const verifierHelp = invokeSelected(verifier, ['--help']);
  const kernelFailure = invokeSelected(kernel, ['invalid-command']);
  const verifierFailure = invokeSelected(verifier, [path.join(legacyDirectory, 'missing.events.jsonl')]);
  if (kernelHelp.status !== 0 || !/usage:/iu.test(kernelHelp.stdout) || verifierHelp.status !== 0 || !/Usage: verify-events/u.test(verifierHelp.stdout) || kernelFailure.status !== 2 || verifierFailure.status !== 1) throw fail('SHIM_DELEGATION_OR_EXIT_FORWARDING_FAILED');
}
function guarded(action) {
  try { action(); console.log(JSON.stringify({ ok: true })); return 0; }
  catch (error) {
    if (!fs.existsSync(manifestPath)) { console.error(error.code ?? 'SHIM_CUTOVER_FAILED'); return 1; }
    try { restoreInternal(); } catch { console.error('SHIM_RECOVERY_REQUIRED'); return 3; }
    console.error(error.code ?? 'SHIM_CUTOVER_FAILED'); return 1;
  }
}
const command = process.argv[2];
try {
  let exitCode;
  if (command === 'snapshot') { snapshot(); exitCode = 0; }
  else if (command === 'install') exitCode = guarded(installInternal);
  else if (command === 'verify') exitCode = guarded(verifyInstalled);
  else if (command === 'test') exitCode = guarded(testInstalled);
  else if (command === 'restore') { try { restoreInternal(); console.log(JSON.stringify({ ok: true, restored: true })); exitCode = 0; } catch { console.error('SHIM_RECOVERY_REQUIRED'); exitCode = 3; } }
  else { console.error('USAGE: shim-cutover.mjs <snapshot|install|test|verify|restore>'); exitCode = 2; }
  process.exitCode = exitCode;
} catch (error) { console.error(error.code ?? 'SHIM_CUTOVER_FAILED'); process.exitCode = 1; }
