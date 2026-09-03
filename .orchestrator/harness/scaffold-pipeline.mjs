#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { sha256Bytes } from './lib/canonical-json.mjs';
import {
  BlueprintError,
  validateBlueprint,
  createGateAttestation,
  compilePlan,
  writePlanDirectory,
  materializeScaffold,
  readPlanDirectory,
  beginNodeAttempt,
  completeNodeAttempt,
  compareObservedGraph,
} from './lib/blueprint-scaffold.mjs';
import { runScaffoldAutomation } from './lib/automation-run.mjs';

const HELP = `Usage: scaffold-pipeline <command> [arguments]

Commands:
  validate <blueprint.json> <policy.json>
  gate <blueprint.json> <policy.json> <output.json> <receipt.json...>
  plan <blueprint.json> <policy.json> <gate.json> <workspace-root> <plan-dir>
  materialize <blueprint.json> <policy.json> <gate.json> <workspace-root> <plan-dir>
  attempt-begin <plan-dir> <ledger-dir> <node-id> <attempt-id>
  attempt-complete <plan-dir> <ledger-dir> <node-id> <attempt-id> <pass|fail> <result-artifact>
  graph-diff <blueprint.json> <policy.json> <observed-graph.json>
  orchestrate <blueprint.json> <policy.json> <gate.json> <workspace-root> <plan-dir> [--runtime-config <json>] [--fast]
`;

class UsageError extends Error { constructor(message) { super(message); this.code = 'USAGE'; } }
const usage = (message) => { throw new UsageError(message); };
const json = (value) => `${JSON.stringify(value)}\n`;

function readJson(file, code = 'INPUT_UNREADABLE') {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { throw new BlueprintError(code, { file }); }
}
function writeJson(file, value) {
  const target = path.resolve(file);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, json(value), { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new BlueprintError('OUTPUT_EXISTS', { file });
    throw error;
  }
}
function exactly(args, count) { if (args.length !== count) usage('invalid arguments'); }
function bundleFrom(file) {
  const bundle = readJson(file, 'GATE_BUNDLE_UNREADABLE');
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle) || Object.keys(bundle).sort().join(',') !== 'findingsRoot,gate,receipts' || !Array.isArray(bundle.receipts) || typeof bundle.findingsRoot !== 'string' || !bundle.findingsRoot) throw new BlueprintError('GATE_BUNDLE_INVALID');
  return bundle;
}
function sharedFindingsRoot(receiptPaths) {
  const roots = [...new Set(receiptPaths.map((file) => path.dirname(path.resolve(file))))];
  if (roots.length !== 1) throw new BlueprintError('FINDINGS_ROOT_AMBIGUOUS');
  return roots[0];
}
function inputs(blueprintFile, policyFile, bundleFile, workspaceRoot) {
  const bundle = bundleFrom(bundleFile);
  return { blueprint: readJson(blueprintFile), policy: readJson(policyFile), ...bundle, workspaceRoot };
}

function orchestrationArguments(args) {
  if (args.length < 5) usage('orchestrate requires five positional arguments');
  const positional = args.slice(0, 5), options = { fast: false };
  for (let index = 5; index < args.length;) {
    if (args[index] === '--fast') {
      if (options.fast) usage('duplicate --fast');
      options.fast = true; index += 1; continue;
    }
    if (args[index] === '--runtime-config' && typeof args[index + 1] === 'string' && !args[index + 1].startsWith('--')) {
      if (options.runtimeConfigFile) usage('duplicate --runtime-config');
      options.runtimeConfigFile = args[index + 1]; index += 2; continue;
    }
    usage('invalid orchestrate arguments');
  }
  return { positional, ...options };
}

async function run(argv) {
  const [command, ...args] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') { if (args.length) usage('help takes no arguments'); process.stdout.write(HELP); return 0; }
  if (command === 'validate') {
    exactly(args, 2); validateBlueprint(readJson(args[0]), readJson(args[1])); process.stdout.write(json({ status: 'VALID' })); return 0;
  }
  if (command === 'gate') {
    if (args.length < 4) usage('gate requires at least one receipt');
    const [blueprintFile, policyFile, outputFile, ...receiptFiles] = args;
    const blueprint = readJson(blueprintFile), policy = readJson(policyFile), findingsRoot = sharedFindingsRoot(receiptFiles);
    const receipts = receiptFiles.map((file) => readJson(file, 'RECEIPT_UNREADABLE'));
    const gate = createGateAttestation({ blueprint, policy, receipts, findingsRoot });
    writeJson(outputFile, { gate, receipts, findingsRoot });
    process.stdout.write(json({ status: 'GATED', attestationDigest: gate.attestationDigest })); return 0;
  }
  if (command === 'plan') {
    exactly(args, 5); const [blueprintFile, policyFile, bundleFile, workspaceRoot, planDir] = args;
    const plan = compilePlan(inputs(blueprintFile, policyFile, bundleFile, workspaceRoot));
    const result = writePlanDirectory(planDir, plan, inputs(blueprintFile, policyFile, bundleFile, workspaceRoot));
    process.stdout.write(json({ status: 'PLANNED', ...result })); return 0;
  }
  if (command === 'materialize') {
    exactly(args, 5); const [blueprintFile, policyFile, bundleFile, workspaceRoot, planDir] = args;
    const result = materializeScaffold({ ...inputs(blueprintFile, policyFile, bundleFile, workspaceRoot), planDir });
    process.stdout.write(json(result)); return 0;
  }
  if (command === 'attempt-begin') {
    exactly(args, 4); const [planDir, ledgerDir, nodeId, attemptId] = args;
    const result = beginNodeAttempt({ plan: readPlanDirectory(planDir), ledgerPath: path.join(path.resolve(ledgerDir), 'attempt-ledger.json'), nodeId, attemptId });
    process.stdout.write(json(result)); return result.status === 'ESCALATED' ? 1 : 0;
  }
  if (command === 'attempt-complete') {
    exactly(args, 6); const [planDir, ledgerDir, nodeId, attemptId, outcome, artifact] = args;
    if (!['pass', 'fail'].includes(outcome)) usage('attempt outcome must be pass or fail');
    let bytes; try { bytes = fs.readFileSync(artifact); } catch { throw new BlueprintError('RESULT_ARTIFACT_UNREADABLE', { file: artifact }); }
    const result = completeNodeAttempt({ plan: readPlanDirectory(planDir), ledgerPath: path.join(path.resolve(ledgerDir), 'attempt-ledger.json'), nodeId, attemptId, outcome: outcome === 'pass' ? 'succeeded' : 'failed', resultDigest: sha256Bytes(bytes) });
    process.stdout.write(json(result)); return 0;
  }
  if (command === 'graph-diff') {
    exactly(args, 3); const report = compareObservedGraph({ blueprint: readJson(args[0]), policy: readJson(args[1]), observedGraph: readJson(args[2], 'OBSERVED_GRAPH_UNREADABLE') });
    process.stdout.write(json(report)); return report.matches ? 0 : 1;
  }
  if (command === 'orchestrate') {
    const parsed = orchestrationArguments(args);
    const [blueprintFile, policyFile, bundleFile, workspaceRoot, planDir] = parsed.positional;
    const runtimeConfig = parsed.runtimeConfigFile ? readJson(parsed.runtimeConfigFile, 'RUNTIME_CONFIG_UNREADABLE') : undefined;
    const result = await runScaffoldAutomation({ ...inputs(blueprintFile, policyFile, bundleFile, workspaceRoot), planDir, runtimeConfig, fast: parsed.fast });
    process.stdout.write(json(result)); return 0;
  }
  usage('unknown command');
}

try { process.exitCode = await run(process.argv.slice(2)); }
catch (error) {
  const usageFailure = error instanceof UsageError;
  const code = usageFailure ? error.code : (error instanceof BlueprintError || typeof error?.code === 'string' ? error.code : 'INTERNAL_ERROR');
  process.stderr.write(json({ error: { code, details: usageFailure ? undefined : error.details } }));
  process.exitCode = usageFailure ? 2 : 1;
}
