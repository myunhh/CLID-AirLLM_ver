#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const node = process.execPath;
const commands = {
  canonical: [
    [node, ['--test', '.orchestrator/harness/tests/event-store.test.mjs']], [node, ['--test', '.orchestrator/harness/tests/path-identity.test.mjs']],
    [node, ['--test', '.orchestrator/harness/tests/integration.test.mjs']], [node, ['--test', '.orchestrator/harness/tests/migration.test.mjs']],
    [node, ['--test', '.orchestrator/harness/tests/authority.test.mjs']], [node, ['--test', '.orchestrator/harness/tests/cli-contract.test.mjs']],
    [node, ['--test', '.orchestrator/harness/tests/admission-budget.test.mjs']], [node, ['--test', '.orchestrator/harness/tests/model-routing.test.mjs']],
    [node, ['--test', '.orchestrator/harness/tests/usage-ledger.test.mjs', '.orchestrator/harness/tests/provider-usage.test.mjs']],
    [node, ['--test', '.orchestrator/harness/tests/execution-profile.test.mjs', '.orchestrator/harness/tests/capsule-preflight.test.mjs', '.orchestrator/harness/tests/evidence-digest.test.mjs', '.orchestrator/harness/tests/command-worker.test.mjs']],
    [node, ['--test', '.orchestrator/harness/tests/bridge-launcher.test.mjs']], [node, ['.orchestrator/harness/bridge-launcher.mjs', 'run-tests']],
    [node, ['--test', '.agents/skills/teammode/tests/team-state.test.mjs']], [node, ['--test', '.orchestrator/harness/tests/config-contract.test.mjs']],
    [node, ['--test', '.orchestrator/harness/tests/docs-contract.test.mjs']],
    [node, ['--test', '.orchestrator/harness/tests/blueprint-scaffold.test.mjs', '.orchestrator/harness/tests/automation-run.test.mjs']],
    [node, ['.orchestrator/harness/shim-cutover.mjs', 'test']],
  ],
  'controller-bridge-chain': [[node, ['--test', '.orchestrator/harness/tests/integration.test.mjs']]],
  'legacy-migration': [[node, ['--test', '.orchestrator/harness/tests/migration.test.mjs']]],
  authority: [[node, ['--test', '.orchestrator/harness/tests/authority.test.mjs']]],
  ownership: [[node, ['--test', '.orchestrator/harness/tests/clean-checkout.test.mjs']]],
  budgets: [[node, ['--test', '.orchestrator/harness/tests/admission-budget.test.mjs']]],
  'team-lifecycle': [[node, ['--test', '.agents/skills/teammode/tests/team-state.test.mjs']]],
  'runtime-isolation': [[node, ['--test', '.orchestrator/harness/tests/clean-checkout.test.mjs']]],
  'virtual-scaffold': [[node, ['--test', '.orchestrator/harness/tests/blueprint-scaffold.test.mjs', '.orchestrator/harness/tests/automation-run.test.mjs']]],
};
const flag = process.argv[2]; const key = flag === '--phase' || flag === '--case' ? process.argv[3] : undefined;
if (!commands[key]) { console.error('USAGE: acceptance.mjs --phase canonical | --case <name>'); process.exitCode = 2; }
else for (const [command, args] of commands[key]) { const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', windowsHide: true }); if (result.status !== 0) { process.exitCode = result.status ?? 1; break; } }
