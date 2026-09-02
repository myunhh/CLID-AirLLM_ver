# Execution graph runtime v2

Use a DAG only after approval when work has real dependencies, parallel ownership, a join, durable audit requirements, or a human gate. Graphify supplies source relationships; this controller schedules approved work and records hash-chained evidence. Neither replaces human authority.

## Canonical commands

Run from the repository root:

```text
node .orchestrator/harness/orchestrator-graph.mjs validate <definition.json>
node .orchestrator/harness/orchestrator-graph.mjs init <definition.json> <run-dir>
node .orchestrator/harness/orchestrator-graph.mjs render <run-dir> [--output <graph.mmd>]
node .orchestrator/harness/orchestrator-graph.mjs ready <run-dir>
node .orchestrator/harness/orchestrator-graph.mjs transition <run-dir> <node-id> RUNNING
node .orchestrator/harness/orchestrator-graph.mjs transition <run-dir> <node-id> VERIFYING
node .orchestrator/harness/orchestrator-graph.mjs submit-verdict <run-dir> <judge-receipt.json>
node .orchestrator/harness/orchestrator-graph.mjs approve-gate <run-dir> <human-approval.json>
node .orchestrator/harness/orchestrator-graph.mjs status <run-dir>
```

Caller-supplied `--actor-role` is deliberately rejected; it is not authentication. Judge and human authority enter only through digest-bound, nonce-bound receipt commands.

## Definition and state

A v2 definition has `schemaVersion: 2`, a `runId`, unique `builders`, independent `judges`, and nodes with:

```json
{
  "id": "implementation",
  "dependsOn": [],
  "builderIds": ["worker-a"],
  "acceptance": ["node --test tests/feature.test.mjs exits 0"],
  "budgets": {"tokens": 8000, "toolCalls": 12, "wallSeconds": 600, "processes": 1},
  "capsule": ".orchestrator/tasks/feature",
  "judgeNonce": "unique-single-use-value",
  "resultArtifactRef": "artifacts/feature.md"
}
```

The legal controller transitions are:

```text
PENDING -> RUNNING | BLOCKED
BLOCKED -> RUNNING
RUNNING -> VERIFYING | BLOCKED
VERIFYING -> SUCCEEDED | FAILED  (only through submit-verdict)
```

Dependencies must all be `SUCCEEDED` before a pending node becomes ready. Current v2 has no post-verification retry transition: use the capsule retry allowance while the node is `RUNNING`, and do not enter `VERIFYING` until local evidence is complete.

Human gates are separate `humanGates` entries containing an action digest and unique nonce. `approve-gate` validates and consumes the bound receipt once; it does not authorize any action outside the declared digest.

## Artifacts, audit, and recovery

`init` creates `<run-dir>/execution-graph.json`, `events.jsonl`, and `checkpoint.json`. The definition is copied with acceptance digests and then immutable. Result artifacts and receipts must remain inside the run; absolute, missing, symlink-escaping, or digest-mismatched results fail closed. `events.jsonl` is append-only and hash-chained, while the checkpoint is a recoverable projection.

Use one controller process per run. Never rewrite events, acceptance, dependencies, or nonces. Compatibility cutovers occur only after canonical acceptance, with exact backup hashes, atomic replacement, failure restoration, and an idempotent rollback test. Publication, merge, credentials, payments, and other consequential actions remain human-owned.
