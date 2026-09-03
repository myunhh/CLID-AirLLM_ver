#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const [mode, controlFile, logFile, ...args] = process.argv.slice(2);
const control = JSON.parse(fs.readFileSync(controlFile, 'utf8'));
const log = (value) => { fs.mkdirSync(path.dirname(logFile), { recursive: true }); fs.appendFileSync(logFile, `${JSON.stringify(value)}\n`); };
const digest = (value) => createHash('sha256').update(value).digest('hex');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (mode === 'graphify') {
  log({ tool: 'graphify', argv: args, cwd: process.cwd() });
  if (control.graphifyExit) process.exit(control.graphifyExit);
  const output = args[args.indexOf('--out') + 1], phase = path.basename(output).startsWith('pre-') ? 'structure' : 'dependencies';
  if (control.graphifyMalformed) {
    fs.mkdirSync(path.join(output, 'graphify-out'), { recursive: true });
    fs.writeFileSync(path.join(output, 'graphify-out', 'graph.json'), '{');
  } else {
    const files = control.files.map((file, index) => ({ id: `file-${index}`, source_file: file.path }));
    const symbols = control.files.map((file, index) => ({ id: `symbol-${index}`, source_file: file.path, name: `symbol-${index}` }));
    const nodes = [...files, ...symbols];
    if (phase === 'structure' && control.structureMismatch) nodes.splice(nodes.findIndex((node) => node.id === 'file-0'), 1);
    const ids = new Map(control.files.map((file, index) => [file.path, `file-${index}`]));
    const edges = control.files.map((file, index) => ({ source: ids.get(file.path), target: `symbol-${index}`, relation: 'contains' }));
    control.files.forEach((file, index) => file.dependsOn.forEach((dependency, dependencyIndex) => edges.push({ source: `symbol-${index}`, target: ids.get(dependency), relation: (index + dependencyIndex) % 2 === 0 ? 'imports_from' : 'imports' })));
    if (phase === 'dependencies' && control.dependencyMismatch) edges.splice(0, edges.length, ...edges.filter((edge) => edge.relation === 'contains'));
    fs.mkdirSync(path.join(output, 'graphify-out'), { recursive: true });
    fs.writeFileSync(path.join(output, 'graphify-out', 'graph.json'), JSON.stringify({ nodes, edges, hyperedges: [], input_tokens: 0, output_tokens: 0 }));
  }
} else if (mode === 'dispatch') {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  const request = JSON.parse(input), ownership = JSON.parse(fs.readFileSync(path.join(request.capsuleDir, 'OWNERSHIP.json'), 'utf8'));
  const target = ownership.allowedWriteFiles[0], started = Date.now();
  const compiledFolded = request.compiledCommand.toLocaleLowerCase('en-US');
  const context = fs.readFileSync(path.join(request.capsuleDir, 'CONTEXT.md'), 'utf8'), contract = context.match(/^Contract: (.+)$/mu)?.[1];
  const contractPath = contract ? path.resolve(request.workspaceRoot, ...contract.split('/')) : null;
  const priorPath = request.previousResultArtifactRef ? path.resolve(request.workspaceRoot, ...request.previousResultArtifactRef.split('/')) : null;
  log({ tool: 'dispatch-start', nodeId: request.nodeId, target, started, fast: request.fast, fastDirectives: (request.compiledCommand.match(/^\/fast$/gmu) ?? []).length, previous: request.previousResultArtifactRef, contractReadSeen: contractPath ? compiledFolded.includes(contractPath.toLocaleLowerCase('en-US')) : false, priorEvidenceReadSeen: priorPath ? compiledFolded.includes(priorPath.toLocaleLowerCase('en-US')) : null, selectedSkillSeen: control.expectedSkill ? compiledFolded.includes(control.expectedSkill.toLocaleLowerCase('en-US')) : null, forbiddenSkillSeen: control.forbiddenSkill ? compiledFolded.includes(control.forbiddenSkill.toLocaleLowerCase('en-US')) : null });
  await delay(control.delays?.[target] ?? 0);
  const absolute = path.resolve(request.workspaceRoot, ...target.split('/'));
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, control.sources?.[target] ?? `export const implemented = ${JSON.stringify(target)};\n`);
  if (control.unownedWrite) fs.writeFileSync(path.resolve(request.workspaceRoot, control.unownedWrite), 'unowned\n');
  fs.mkdirSync(path.dirname(request.transportArtifactPath), { recursive: true });
  const transport = `${JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 }, requested_fast: request.fast, fast: request.fast })}\n`;
  fs.writeFileSync(request.transportArtifactPath, transport);
  log({ tool: 'dispatch-end', nodeId: request.nodeId, target, ended: Date.now() });
  const usage = (control.emptyUsage ? [] : (control.usageRecords ?? [{ inputTokens: 1, outputTokens: 1 }])).map((record) => ({ version: 1, provider: 'fake', ...record, requestedFast: request.fast }));
  const observedProfile = { model: control.observedModel ?? null, reasoning: control.observedReasoning ?? null, fast: Object.hasOwn(control, 'observedFast') ? control.observedFast : null };
  process.stdout.write(`${JSON.stringify({ schemaVersion: 1, status: 'succeeded', exitCode: 0, usage, observedProfile, transportDigest: control.badTransportDigest ? digest('wrong') : digest(transport) })}\n`);
} else if (mode === 'verify') {
  const [target] = args, stateFile = `${controlFile}.${target.replaceAll('/', '_')}.state`;
  log({ tool: 'verify', target, argv: args, cwd: process.cwd(), pid: process.pid });
  const delayed = control.verificationDelayedWriteOnce, delayedState = `${controlFile}.delayed-write.state`;
  if (delayed?.target === target && !fs.existsSync(delayedState)) { fs.writeFileSync(delayedState, 'started'); await delay(delayed.delayMs); fs.writeFileSync(delayed.sentinel, 'late write\n'); }
  await delay(control.verificationDelays?.[target] ?? 0);
  if (control.verifierWrite) fs.writeFileSync(path.resolve(process.cwd(), control.verifierWrite), 'verifier write\n');
  if (control.failVerificationAlways === target) process.exit(1);
  if (control.failVerificationOnce === target && !fs.existsSync(stateFile)) { fs.writeFileSync(stateFile, 'failed'); process.exit(1); }
  if (!fs.existsSync(path.resolve(process.cwd(), ...target.split('/')))) process.exit(2);
} else if (mode === 'codex') {
  let input = '';
  process.stdin.setEncoding('utf8'); for await (const chunk of process.stdin) input += chunk;
  log({ tool: 'codex', argv: args, cwd: process.cwd(), stdinDigest: digest(input) });
  if (control.codexChildSentinel) {
    const child = spawn(process.execPath, ['-e', `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(control.codexChildSentinel)}, 'alive'), 700)`], { stdio: 'ignore', windowsHide: true });
    child.unref(); await delay(3000);
  }
  process.stdout.write(`${JSON.stringify({ usage: { input_tokens: 1, output_tokens: 1 }, model: 'fake-codex' })}\n`);
} else {
  process.stderr.write('unknown fake mode\n'); process.exit(2);
}
