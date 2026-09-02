import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readCapsule, preflightCapsules } from './lib/capsule-preflight.mjs';

const ordered = ['TASK.md', 'ACCEPTANCE.md', 'BUDGET.json', 'CONTEXT.md', 'OWNERSHIP.json', 'RESULT.md'];
export function compileWorkerCommand({ capsuleDir, parallelCapsuleDirs = [], reads = [], writes, skillPaths = [] } = {}) {
  const preflight = preflightCapsules({ capsuleDir, parallelCapsuleDirs, reads: [...reads, ...skillPaths], writes });
  const capsule = readCapsule(capsuleDir);
  const sources = ordered.map((name) => `${name} sha256=${createHash('sha256').update(capsule.files[name]).digest('hex')}`).join('\n');
  return `/fast\nYou are a command-only worker. Code and test only. Do not plan, replan, delegate, or expand scope.\nCapsule: ${capsule.root}\nAuthorized reads: ${preflight.reads.join(', ')}\nAuthorized skills: ${skillPaths.map((item) => path.resolve(item)).join(', ')}\nOwned writes: ${preflight.writes.join(', ')}\nSources:\n${sources}\nExecute only the capsule instructions and stop on ownership violation.`;
}

export function parseCompileArguments(argv) {
  const result = { parallelCapsuleDirs: [], reads: [], skillPaths: [] };
  const keys = new Map([['--capsule', 'capsuleDir'], ['--parallel', 'parallelCapsuleDirs'], ['--read', 'reads'], ['--write', 'writes'], ['--skill', 'skillPaths']]);
  if (argv[0] !== 'compile') throw new TypeError('USAGE');
  for (let index = 1; index < argv.length; index += 2) {
    const destination = keys.get(argv[index]); const value = argv[index + 1];
    if (!destination || !value || value.startsWith('--')) throw new TypeError('USAGE');
    if (destination === 'capsuleDir') { if (result.capsuleDir) throw new TypeError('USAGE'); result.capsuleDir = value; }
    else { result[destination] ??= []; result[destination].push(value); }
  }
  if (!result.capsuleDir) throw new TypeError('USAGE');
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.stdout.write(`${compileWorkerCommand(parseCompileArguments(process.argv.slice(2)))}\n`); }
  catch (error) { process.stderr.write(`${error.code ?? error.message}\n`); process.exitCode = error instanceof TypeError ? 2 : 1; }
}
