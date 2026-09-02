import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { compileWorkerCommand } from '../command-worker.mjs';
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
test('compiler emits deterministic fast command-only prompt', (t) => {
  const capsuleDir = createCapsule(t);
  const first = compileWorkerCommand({ capsuleDir }); const second = compileWorkerCommand({ capsuleDir });
  assert.equal(first, second);
  assert.ok(first.startsWith('/fast\n'));
  assert.match(first, /Code and test only/u);
  assert.match(first, /Do not plan, replan, delegate, or expand scope/u);
});
test('CLI prints only the bounded prompt and returns stable usage failures', (t) => {
  const file = path.join(here, '..', 'command-worker.mjs');
  const capsuleDir = createCapsule(t);
  const success = spawnSync(process.execPath, [file, 'compile', '--capsule', capsuleDir, '--skill', path.join(capsuleDir, 'TASK.md')], { encoding: 'utf8' });
  assert.equal(success.status, 0); assert.ok(success.stdout.startsWith('/fast\n')); assert.match(success.stdout, /Authorized skills: .*TASK\.md/u); assert.equal(success.stderr, '');
  const usage = spawnSync(process.execPath, [file, 'compile'], { encoding: 'utf8' });
  assert.equal(usage.status, 2); assert.equal(usage.stdout, ''); assert.equal(usage.stderr, 'USAGE\n');
});
