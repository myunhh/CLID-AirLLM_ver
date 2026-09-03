import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const readJson = (...parts) => JSON.parse(read(...parts));
const directoryNames = (...parts) => fs.readdirSync(path.join(root, ...parts), { withFileTypes: true })
  .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const assertMarkdownLink = (sourceParts, relativeTarget) => {
  const sourceFile = path.join(root, ...sourceParts);
  const sourceText = fs.readFileSync(sourceFile, 'utf8');
  assert.ok(sourceText.includes(`](${relativeTarget})`), `${sourceParts.join('/')} -> ${relativeTarget}`);
  assert.ok(fs.statSync(path.resolve(path.dirname(sourceFile), relativeTarget)).isFile(), relativeTarget);
};
const runtimeSourceFiles = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const resolved = path.join(directory, entry.name);
  if (entry.isDirectory()) return entry.name === 'tests' ? [] : runtimeSourceFiles(resolved);
  return /\.(?:mjs|py)$/u.test(entry.name) ? [resolved] : [];
});

test('harness documentation declares canonical runtime, launcher-only Python, and reversible shim cutover', () => {
  const readme = fs.readFileSync(path.join(root, '.orchestrator', 'harness', 'README.md'), 'utf8');
  const navigation = fs.readFileSync(path.join(root, 'docs', 'CODEX-NAVIGATION-GUIDE.md'), 'utf8');
  const protocol = fs.readFileSync(path.join(root, '.agents', 'skills', 'budgeted-graph-orchestration', 'references', 'protocol.md'), 'utf8');
  assert.match(readme, /only project-owned runtime/iu);
  assert.match(navigation, /ownership map[\s\S]*acceptance criteria/iu);
  assert.match(protocol, /bounded capsule[\s\S]*immutable acceptance criteria/iu);
  assert.match(readme, /bridge-launcher\.mjs/u);
  assert.match(readme, /snapshot.*install.*verify.*restore/is);
  assert.match(readme, /never.*ambient Python/is);
  assert.equal(fs.existsSync(path.join(root, 'graphify-out')), false, 'global harness root must not contain graphify-out');
});

test('canonical directory map covers repository planes and its narrow entrypoints link back', () => {
  const map = read('docs', 'HARNESS-DIRECTORY-STRUCTURE.md');
  const requiredSections = ['Planes and boundaries', 'Capability selection', 'Canonical runtime and compatibility', 'Execution state and evidence', 'Request-to-verdict flow', 'Documentation entrypoints'];
  const requiredPaths = ['AGENTS.md', '.agents/', '.skills/', '.codex/', '.orchestrator/', 'definitions/', 'tasks/', 'runs/', 'harness/', 'kernel-bridge/', '.omo/', 'evidence/', 'docs/', 'prime-agent/', 'tmp/', 'myenv*/'];
  const requiredDirectories = ['.agents', '.agents/skills', '.skills', '.skills/library', '.skills/archive/alternate-variants', '.skills/rollback', '.codex', '.codex/agents', '.orchestrator', '.orchestrator/definitions', '.orchestrator/tasks', '.orchestrator/runs', '.orchestrator/harness', '.orchestrator/kernel-bridge', '.omo', '.omo/evidence', 'docs'];
  const entrypoints = [
    { source: ['.orchestrator', 'harness', 'README.md'], link: '../../docs/HARNESS-DIRECTORY-STRUCTURE.md' },
    { source: ['.skills', 'README.md'], link: '../docs/HARNESS-DIRECTORY-STRUCTURE.md' },
    { source: ['docs', 'CODEX-NAVIGATION-GUIDE.md'], link: 'HARNESS-DIRECTORY-STRUCTURE.md' },
  ];
  assert.match(map, /^# ECC Harness Directory Structure$/mu);
  for (const section of requiredSections) assert.match(map, new RegExp(`^## ${section}$`, 'mu'));
  for (const entry of requiredPaths) assert.ok(map.includes(entry), entry);
  for (const directory of requiredDirectories) assert.ok(fs.statSync(path.join(root, directory)).isDirectory(), directory);
  assert.match(map, /not runtime-imported[\s\S]*not auto-loaded wholesale/iu);
  assert.match(map, /nested checkout[\s\S]*distinct target repository/iu);
  assert.match(map, /specific exclusions[\s\S]*not[\s\S]*assumed ignored/iu);
  assert.match(map, /hooks\.json[\s\S]*Graphify executable[\s\S]*user profile/iu);
  assert.match(map, /request[\s\S]*DAILY kernel[\s\S]*DAG[\s\S]*Bridge[\s\S]*events[\s\S]*Judge/iu);
  for (const entrypoint of entrypoints) {
    assertMarkdownLink(entrypoint.source, entrypoint.link);
  }
  for (const link of ['../.orchestrator/harness/README.md', '../.skills/README.md', 'CODEX-NAVIGATION-GUIDE.md']) {
    assertMarkdownLink(['docs', 'HARNESS-DIRECTORY-STRUCTURE.md'], link);
  }
});

test('catalogs, directories, provenance, and rollback records agree dynamically', () => {
  const catalog = readJson('.skills', 'catalog.json');
  const plugins = readJson('.skills', 'plugin-catalog.json');
  const rollback = readJson('.skills', 'rollback.json');
  const sources = readJson('.skills', 'sources.lock.json');
  const agentsPolicy = read('AGENTS.md');
  const expectedDaily = catalog.daily.map((entry) => entry.name).sort();
  const expectedLibrary = catalog.library.map((entry) => entry.name).sort();

  assert.deepEqual(directoryNames('.agents', 'skills'), expectedDaily);
  assert.deepEqual(directoryNames('.skills', 'library'), expectedLibrary);
  assert.equal(new Set(expectedDaily).size, expectedDaily.length);
  assert.equal(new Set(expectedLibrary).size, expectedLibrary.length);
  for (const entry of [...catalog.daily, ...catalog.library]) {
    assert.equal(typeof entry.path, 'string');
    assert.ok(fs.statSync(path.join(root, entry.path)).isDirectory(), entry.path);
    assert.ok(fs.statSync(path.join(root, entry.path, 'SKILL.md')).isFile(), `${entry.path}/SKILL.md`);
  }

  assert.equal(catalog.policy.daily_root, '.agents/skills');
  assert.equal(catalog.policy.library_root, '.skills/library');
  assert.equal(catalog.policy.archive_root, '.skills/archive/alternate-variants');
  assert.equal(catalog.policy.plugin_catalog, '.skills/plugin-catalog.json');
  const policyDailyBlock = agentsPolicy.match(/ten foundational skills:\s*([\s\S]*?)\n2\./u);
  assert.ok(policyDailyBlock, 'AGENTS.md DAILY skill block');
  const policyDaily = [...policyDailyBlock[1].matchAll(/`([^`]+)`/gu)].map((match) => match[1]).sort();
  assert.deepEqual(policyDaily, expectedDaily);
  assert.ok(Array.isArray(catalog.alternates) && catalog.alternates.length > 0);
  for (const alternate of catalog.alternates) {
    assert.equal(alternate.active, false);
    assert.ok(fs.statSync(path.join(root, alternate.path)).isDirectory(), alternate.path);
    assert.ok(fs.statSync(path.join(root, alternate.canonical_path)).isDirectory(), alternate.canonical_path);
  }

  const pluginKeys = ['visible_name', 'frontmatter_description', 'plugin_id', 'plugin_family', 'installed_version', 'resolved_skill_md', 'resolver_glob', 'sha256', 'enabled_in_model_catalog'];
  assert.ok(Array.isArray(plugins.skills) && plugins.skills.length > 0);
  for (const plugin of plugins.skills) {
    for (const key of pluginKeys) assert.ok(Object.hasOwn(plugin, key), `${plugin.visible_name} missing ${key}`);
    assert.equal(typeof plugin.visible_name, 'string');
    assert.equal(typeof plugin.resolver_glob, 'string');
    assert.match(plugin.sha256, /^[0-9a-f]{64}$/u);
    assert.equal(plugin.enabled_in_model_catalog, false);
    assert.ok(fs.statSync(plugin.resolved_skill_md).isFile(), plugin.resolved_skill_md);
    assert.equal(sha256(plugin.resolved_skill_md), plugin.sha256, plugin.visible_name);
  }

  assert.ok(Array.isArray(sources.collections) && sources.collections.length > 0);
  for (const source of sources.collections) {
    assert.equal(typeof source.repository, 'string');
    assert.match(source.commit, /^[0-9a-f]{40}$/u);
  }
  const lazycodex = sources.collections.find((source) => source.id === 'lazycodex-skills');
  assert.ok(lazycodex, 'lazycodex-skills provenance');
  const lazyDailyCount = catalog.daily.filter((entry) => entry.source === 'lazycodex').length;
  const lazyLibraryCount = catalog.library.filter((entry) => entry.canonical_source === 'lazycodex').length;
  assert.equal(lazycodex.skill_count, lazyDailyCount + lazyLibraryCount);
  assert.match(lazycodex.installed_layout, new RegExp(`${lazyDailyCount} foundational[\\s\\S]*${lazyLibraryCount} canonical`, 'iu'));
  for (const group of ['daily_moves', 'codex_user_moves', 'agents_user_moves']) assert.ok(Array.isArray(rollback[group]) && rollback[group].length > 0, group);
  assert.ok(fs.statSync(path.join(root, '.skills', 'rollback')).isDirectory());
});

test('runtime source stays separate from the capability-selection plane', () => {
  const map = read('docs', 'HARNESS-DIRECTORY-STRUCTURE.md');
  const skillGuide = read('.skills', 'README.md');
  const forbiddenRuntimeReferences = /(?:\.skills[\\/]|plugin-catalog\.json|openai-curated-remote|myunhh\.pem)/iu;
  assert.match(map, /only project-owned runtime/iu);
  assert.match(skillGuide, /not the orchestration\s+runtime/iu);
  for (const sourceFile of runtimeSourceFiles(path.join(root, '.orchestrator', 'harness'))) {
    assert.doesNotMatch(fs.readFileSync(sourceFile, 'utf8'), forbiddenRuntimeReferences, sourceFile);
  }
  for (const shim of ['kernel_bridge.py', 'verify_events.py', 'kernel_bridge.py.pre-harness-v2', 'verify_events.py.pre-harness-v2']) {
    const shimFile = path.join(root, '.orchestrator', 'kernel-bridge', shim);
    assert.doesNotMatch(fs.readFileSync(shimFile, 'utf8'), forbiddenRuntimeReferences, shimFile);
  }
});
