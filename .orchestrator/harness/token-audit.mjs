#!/usr/bin/env node
import fs from 'node:fs';
import { parseCodexUsageJsonl } from './lib/providers/codex-usage.mjs';
import { parseClaudeUsageResult } from './lib/providers/claude-usage.mjs';
import { UsageLedger } from './lib/usage-ledger.mjs';

const [provider, file] = process.argv.slice(2);
if (!['codex', 'claude'].includes(provider) || !file) {
  process.stderr.write('Usage: node token-audit.mjs <codex|claude> <usage-file>\n');
  process.exitCode = 2;
} else {
  const source = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(file, 'utf8');
  const ledger = new UsageLedger();
  let anomalies = [];
  if (provider === 'codex') {
    const parsed = parseCodexUsageJsonl(source);
    parsed.records.forEach((record) => ledger.add(record));
    anomalies = parsed.anomalies;
  } else ledger.add(parseClaudeUsageResult(JSON.parse(source)));
  const records = ledger.records();
  const identities = (field) => [...new Set(records.flatMap((record) => Array.isArray(record[field]) ? record[field] : record[field] === undefined ? [] : [record[field]]))].sort();
  process.stdout.write(`${JSON.stringify({ version: 1, provider, ...ledger.summary(), anomalies, requestedModels: identities('requestedModel'), observedModels: identities('observedModels').length ? identities('observedModels') : identities('observedModel'), requestedFastStates: identities('requestedFast'), observedFastStates: identities('observedFast'), fastModeReasons: identities('fastModeReason') })}\n`);
}
