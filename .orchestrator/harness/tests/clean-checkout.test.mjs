import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const node = process.execPath;
const copied = ['.orchestrator/harness', '.agents/skills/teammode', '.agents/skills/budgeted-graph-orchestration', '.codex/config.toml', '.codex/agents', 'docs/CODEX-NAVIGATION-GUIDE.md'];
const forbidden = /node:(?:net|http|https|tls|dgram)|from\s+['"](?:net|http|https|tls|dgram)['"]|openai-curated-remote|myunhh\.pem|graphify-out|\.codex[\\/]plugins/iu;
function command(cwd, args, env) { return spawnSync(node, args, { cwd, env, encoding: 'utf8', windowsHide: true }); }
function files(directory) { return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => { const resolved = path.join(directory, entry.name); return entry.isDirectory() ? files(resolved) : [resolved]; }); }
function copy(source, destination) { fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.cpSync(source, destination, { recursive: true, filter: (candidate) => !/[\\/](?:\.venv|__pycache__)(?:[\\/]|$)/u.test(candidate) }); }
function isolationEnv(home, guard) {
  const environment = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'appdata'), LOCALAPPDATA: path.join(home, 'localappdata'), PYTHONPATH: guard, NODE_OPTIONS: `--require=${path.join(guard, 'deny-network.cjs')}` };
  for (const key of ['ECC_HARNESS_PYTHON', 'CODEX_HOME', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) delete environment[key];
  return environment;
}
test('a clean temporary checkout confines runtime targets and succeeds with credentials, caches, and sockets unavailable', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ecc-clean-checkout-')); let removed = false;
  try {
    for (const relative of copied) copy(path.join(root, relative), path.join(sandbox, relative));
    const legacy = path.join(sandbox, '.orchestrator', 'kernel-bridge'); fs.mkdirSync(legacy, { recursive: true });
    for (const name of ['kernel_bridge.py', 'verify_events.py']) fs.copyFileSync(path.join(root, '.orchestrator', 'kernel-bridge', `${name}.pre-harness-v2`), path.join(legacy, name));
    const guard = path.join(sandbox, 'network-deny'); fs.mkdirSync(guard);
    fs.writeFileSync(path.join(guard, 'deny-network.cjs'), "for (const name of ['node:net','node:http','node:https','node:tls','node:dgram']) { const mod = require(name); for (const key of ['connect','request','get','createConnection','createSocket']) if (typeof mod[key] === 'function') mod[key] = () => { throw new Error('NETWORK_DENIED'); }; }\n");
    fs.writeFileSync(path.join(guard, 'sitecustomize.py'), "import socket\ndef denied(*args, **kwargs): raise RuntimeError('NETWORK_DENIED')\nsocket.socket = denied\n");
    const env = isolationEnv(path.join(sandbox, 'empty-home'), guard);
    assert.equal(fs.existsSync(path.join(sandbox, '.codex', 'plugins')), false, 'plugin caches are absent'); assert.equal(fs.existsSync(path.join(env.HOME, '.codex')), false, 'credential/config home is empty');
    const all = files(path.join(sandbox, '.orchestrator')).filter((file) => /\.(?:mjs|py)$/u.test(file) && !file.includes(`${path.sep}tests${path.sep}`));
    for (const file of all) {
      const source = fs.readFileSync(file, 'utf8'); assert.doesNotMatch(source, forbidden, file);
      for (const match of source.matchAll(/(?:from\s+|import\s*\(|require\()\s*['"](\.[^'"]+)['"]/gu)) { const target = path.resolve(path.dirname(file), match[1]); assert.ok(target.startsWith(path.join(sandbox, '.orchestrator', 'harness')) || file.startsWith(legacy), `confined import ${file} -> ${target}`); }
    }
    for (const args of [
      ['--check', '.orchestrator/harness/shim-cutover.mjs'], ['.orchestrator/harness/orchestrator-graph.mjs', '--help'], ['.orchestrator/harness/verify-events.mjs', '--help'],
      ['.orchestrator/harness/shim-cutover.mjs', 'snapshot'], ['.orchestrator/harness/shim-cutover.mjs', 'install'], ['.orchestrator/harness/shim-cutover.mjs', 'test'], ['.orchestrator/harness/shim-cutover.mjs', 'verify'],
      ['.orchestrator/harness/tests/acceptance.mjs', '--phase', 'canonical'],
    ]) { const result = command(sandbox, args, env); assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}`); }
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); removed = !fs.existsSync(sandbox); }
  assert.equal(removed, true, 'temporary isolated checkout cleaned');
});
