import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileWorkerCommand, parseCompileArguments } from '../command-worker.mjs';
const here = path.dirname(fileURLToPath(import.meta.url));
function createCapsule(t) {
  const worktreePath = fs.mkdtempSync(path.join(os.tmpdir(), 'command-worker-'));
  const capsuleDir = path.join(worktreePath, 'capsule');
  const ownership = {
    worktreePath,
    allowedReadRoots: [capsuleDir],
    allowedWriteFiles: [path.join(capsuleDir, 'RESULT.md')],
    forbiddenPaths: [path.join(worktreePath, 'forbidden')]
  };
  fs.mkdirSync(capsuleDir);
  for (const [name, contents] of Object.entries({
    'TASK.md': 'Code and test only.\n',
    'ACCEPTANCE.md': 'The fixture is valid.\n',
    'BUDGET.json': '{"tokens":1000,"toolCalls":2,"retryLimit":0,"wallSeconds":60,"processes":1,"contextForkTurns":0,"escalationRule":"Stop on failure."}\n',
    'CONTEXT.md': 'Runtime fixture.\n',
    'OWNERSHIP.json': `${JSON.stringify(ownership)}\n`,
    'RESULT.md': 'Status: READY\n'
  })) fs.writeFileSync(path.join(capsuleDir, name), contents);
  t.after(() => fs.rmSync(worktreePath, { recursive: true, force: true }));
  return capsuleDir;
}
test('compiler emits deterministic standard command-only prompt by default', (t) => {
  const capsuleDir = createCapsule(t);
  const first = compileWorkerCommand({ capsuleDir }); const second = compileWorkerCommand({ capsuleDir });
  assert.equal(first, second);
  assert.ok(!first.startsWith('/fast\n'));
  assert.doesNotMatch(first, /\/fast/u);
  assert.match(first, /Code and test only/u);
  assert.match(first, /Do not plan, replan, delegate, or expand scope/u);
  assert.match(first, /Before coding, read every listed required specification\/evidence path and every selected SKILL\.md, then execute the capsule contract/u);
});
test('compiler emits one acceleration directive only when explicitly requested', (t) => {
  const capsuleDir = createCapsule(t);
  const prompt = compileWorkerCommand({ capsuleDir, fast: true });
  assert.equal(prompt.match(/\/fast/g)?.length, 1);
  assert.ok(prompt.startsWith('/fast\n'));
});
test('compiler exposes ownership read roots while preflighting requested reads', (t) => {
  const capsuleDir = createCapsule(t);
  const requested = path.join(capsuleDir, 'TASK.md'), prompt = compileWorkerCommand({ capsuleDir, reads: [requested] });
  const authorizedReads = prompt.split('\n').find((line) => line.startsWith('Authorized reads: '));
  assert.ok(authorizedReads);
  assert.ok(!authorizedReads.endsWith('TASK.md'));
  const canonicalRequested = fs.realpathSync.native(requested);
  const expectedRequested = process.platform === 'win32' ? canonicalRequested.toLocaleLowerCase('en-US') : canonicalRequested;
  assert.equal(prompt.split('\n').find((line) => line.startsWith('Required specification/evidence reads: ')), `Required specification/evidence reads: ${expectedRequested}`);
  assert.equal(prompt.split('\n').find((line) => line.startsWith('Capsule budget: ')), 'Capsule budget: {"tokens":1000,"toolCalls":2,"retryLimit":0,"wallSeconds":60,"processes":1,"contextForkTurns":0,"escalationRule":"Stop on failure."}');
  assert.equal(prompt.split('\n').find((line) => line.startsWith('Authorized skills: ')), 'Authorized skills: ');
  assert.throws(() => compileWorkerCommand({ capsuleDir, reads: [path.dirname(capsuleDir)] }), { code: 'READ_NOT_ALLOWED' });
});
test('compiler emits preflighted canonical skills relative to the capsule worktree', (t) => {
  const capsuleDir = createCapsule(t);
  const worktreePath = path.dirname(capsuleDir);
  const unrelatedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'command-worker-cwd-'));
  const originalCwd = process.cwd();
  t.after(() => { process.chdir(originalCwd); fs.rmSync(unrelatedCwd, { recursive: true, force: true }); });
  const firstSkill = path.join(capsuleDir, 'ACCEPTANCE.md');
  const secondSkill = path.join(capsuleDir, 'TASK.md');
  const canonical = (file) => {
    const resolved = fs.realpathSync.native(file);
    return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
  };
  process.chdir(unrelatedCwd);
  const prompt = compileWorkerCommand({
    capsuleDir,
    reads: [path.join(capsuleDir, 'CONTEXT.md')],
    skillPaths: [path.relative(worktreePath, firstSkill), path.relative(worktreePath, secondSkill)]
  });
  const authorizedSkills = prompt.split('\n').find((line) => line.startsWith('Authorized skills: '));
  assert.equal(authorizedSkills, `Authorized skills: ${canonical(firstSkill)}, ${canonical(secondSkill)}`);
  assert.equal(prompt.split('\n').find((line) => line.startsWith('Required specification/evidence reads: ')), `Required specification/evidence reads: ${canonical(path.join(capsuleDir, 'CONTEXT.md'))}`);
});
test('CLI prints only the bounded prompt and returns stable usage failures', (t) => {
  const file = path.join(here, '..', 'command-worker.mjs');
  const capsuleDir = createCapsule(t);
  const success = spawnSync(process.execPath, [file, 'compile', '--capsule', capsuleDir, '--skill', path.join(capsuleDir, 'TASK.md')], { encoding: 'utf8' });
  assert.equal(success.status, 0); assert.ok(!success.stdout.startsWith('/fast\n')); assert.match(success.stdout, /Authorized skills: .*task\.md/iu); assert.equal(success.stderr, '');
  const fast = spawnSync(process.execPath, [file, 'compile', '--fast', '--capsule', capsuleDir], { encoding: 'utf8' });
  assert.equal(fast.status, 0); assert.equal(fast.stdout.match(/\/fast/g)?.length, 1);
  const usage = spawnSync(process.execPath, [file, 'compile'], { encoding: 'utf8' });
  assert.equal(usage.status, 2); assert.equal(usage.stdout, ''); assert.equal(usage.stderr, 'USAGE\n');
  assert.equal(parseCompileArguments(['compile', '--capsule', capsuleDir, '--fast']).fast, true);
  assert.throws(() => parseCompileArguments(['compile', '--capsule', capsuleDir, '--fast', '--fast']), { message: 'USAGE' });
});
