# Task capsule schema

Create `.orchestrator/tasks/<task-id>/` containing exactly:

- `TASK.md`: objective, parent/dependencies, and non-goals.
- `CONTEXT.md`: settled decisions and exact source references, never a raw chat dump.
- `OWNERSHIP.json`: `worktreePath`, allowed read roots, exact write files, and forbidden paths.
- `ACCEPTANCE.md`: deterministic commands, expected exits, invariants, and anti-Goodhart boundaries.
- `BUDGET.json`: token/tool/process/time guidance, retry limit, zero-history fork, and escalation rule.
- `RESULT.md`: status, changed files, commands/exits, evidence, risks, and budget used.

Suggested reporting states are `READY`, `RUNNING`, `BLOCKED`, `BUDGET_EXHAUSTED`, `AWAITING_JUDGE`, and `VERIFIED`. Only the orchestrator records `VERIFIED` after independent evidence.

## Command-only preflight

Before spawning a worker, compile its bounded prompt and validate path identities:

```text
node .orchestrator/harness/command-worker.mjs compile --capsule <capsule-dir> [--parallel <peer-capsule>] [--read <path>] [--write <path>] [--skill <SKILL.md>]
```

The prompt starts `/fast`, forbids planning/delegation/scope expansion, and carries capsule hashes rather than parent conversation. Omitted `--write` means all exact owned writes; explicit values narrow that set. The orchestrator still supplies model and reasoning settings to the native agent call and later compares them with observed metadata. Never treat prompt text as proof that fast mode activated.

## Execution-graph linkage (runtime v2)

For each node, copy the capsule's settled contract into the v2 definition before `init`:

- `builderIds` names declared builders; a Judge cannot be one of them.
- `acceptance` is hashed during initialization.
- `budgets` contains exactly positive `tokens`, `toolCalls`, `wallSeconds`, and `processes` values.
- `capsule` points to the six-file directory.
- `judgeNonce` is unique and single-use.
- `resultArtifactRef` is relative to the run directory and must resolve to a real file inside it.

The initialized `execution-graph.json` and acceptance digests are immutable. Capsule `RESULT.md` is a worker handoff; the Judge binds a separate run-confined result artifact by SHA-256. Current v2 exposes no retry transition after `VERIFYING`, so complete any permitted node-local retry before entering verification.
