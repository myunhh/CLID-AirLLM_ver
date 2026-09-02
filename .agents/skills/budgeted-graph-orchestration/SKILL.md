---
name: budgeted-graph-orchestration
description: Use for every non-trivial task that may require repository exploration, planning, code changes, multiple files, dependencies, or verification. The main orchestrator must classify the task, consult the project graph when available, propose execution stages to the human, wait for approval, then execute an acyclic task graph with bounded task capsules, centralized integration, and independent verification. Skip delegation for trivial one-step work, but still classify and verify it.
---

# Budgeted Graph Orchestration

The main thread owns intent, decisions, stage approval, integration, and the final report. Subagents own bounded evidence or implementation tasks only.

## Choose the execution shape

Choose the lightest lane that preserves the requested guarantees:

- **Read-only lightweight lane:** collect deterministic evidence first; give each independent agent one command-only capsule with exact reads, outputs, skill paths, and no inherited chat. Run non-overlapping capsules concurrently. A full DAG is optional unless dependencies, durable audit, or a gate require it.
- **Governed mutation lane:** use bounded capsules, an execution DAG for real dependencies or parallel ownership, centralized integration, and an independent Judge. Security-sensitive or external actions always use this lane.

Model-call count is telemetry, not an optimization limit. Prefer safe parallel calls for independent work and reduce serial turns that repeatedly inject a growing transcript.

The layers have separate jobs: Graphify provides source and impact evidence; the DAG schedules approved work; a node-local loop bounds execution and retry; an independent Judge records verification verdicts; the human retains final authority. Read `references/execution-graph.md` only when the approved work needs a DAG.

## Mandatory gate

Before mutating files on a non-trivial task:

1. Classify the task as S, M, L, or XL using `references/protocol.md`.
2. If `graphify-out/graph.json` exists, query it for the requested behavior and affected areas. If it does not exist and the task is M or larger, propose graph initialization as a stage.
3. Produce a stage proposal with scope, agents, files or communities, acceptance commands, and estimated budget.
4. Ask the human which stages to run. Recommend the smallest safe pipeline.
5. Wait for approval. Approval of a plan does not authorize push, merge, publish, credential changes, or other external actions.

S tasks may use a compact approval question. Pure answers and read-only inspection do not require a mutation gate.

S-grade work inside an approved node stays inside that node unless it introduces a new gate or parallel write boundary. The bounded node-local Bridge behavior and hard-stop rules are in `references/protocol.md`.

## Model routing

Keep the main orchestrator on `gpt-5.6-sol` by default and apply the task-shape routing table in `references/protocol.md`. Explicit user model requests override the table. Record requested and observed model, reasoning, and fast state; never infer `/fast` activation from prompt text alone.

## Execution pipeline

After approval:

1. Create `.orchestrator/tasks/<task-id>/` with the files described in `references/task-capsule.md`.
2. Preflight capsule reads, writes, forbidden paths, and parallel overlap. Compile a `/fast` command-only prompt with `.orchestrator/harness/command-worker.mjs`; specify the approved skill paths and use no inherited conversation.
3. Assign explicit ownership. A worker must not modify files outside its ownership list or alter acceptance criteria.
4. Use separate worktrees for parallel writers when practical. Read-only explorers may share the main worktree.
5. Require every worker to return `RESULT.md` data: status, files changed, commands run, evidence, remaining risk, and budget use.
6. The main orchestrator integrates results and resolves conflicts. Workers never merge or push.
7. An independent read-only judge runs deterministic acceptance checks and inspects the diff. The builder cannot judge its own work. For a read-only lightweight lane, one final Judge is enough unless the user requests per-node audit receipts.
8. After code changes, run `graphify update .` when a project graph exists, then query affected nodes or paths.
9. Present the human with the outcome and any next external action requiring approval.

When a task includes a compatibility cutover, capture pre-cutover acceptance before mutation, retain exact recoverable originals, and verify an explicit idempotent rollback as a separate evidence scenario.

When approved work requires an execution DAG, use the deterministic controller described in `references/execution-graph.md`. Store runtime artifacts under `.orchestrator/runs/<run-id>/`; never write execution events into `graphify-out/graph.json`. A controller may establish machine-verifiable evidence, but only the human advances explicit human gates or grants external-action authority.

## Hard stops

Stop and return control to the main orchestrator when any of these occurs:

- budget exhausted;
- ownership boundary would be crossed;
- acceptance criteria appear wrong or need editing;
- two failed implementation retries for M/L work;
- graph evidence conflicts with direct source evidence;
- security, data loss, credential, publication, merge, or payment authority is needed.

Do not convert a hard stop into an improvised workaround.

## Context discipline

- Task packets contain objective facts and exact file references, not the full chat transcript.
- Full tool output stays in an artifact; handoffs use typed evidence digests with exact math, hashes, exit status, anomalies, and a narrow re-read handle.
- Explorers return summaries with file and symbol citations, not raw logs.
- Workers receive only prerequisites that are already settled.
- The main orchestrator may interrupt a worker that exceeds its task boundary or repeats an unproductive action.
- Human judgment owns the final switch. Machine verification establishes evidence, not product acceptance.

## References

- Classification and budgets: `references/protocol.md`
- Capsule schema: `references/task-capsule.md`
- Execution DAG runtime: `references/execution-graph.md`
- Human stage prompt: `references/human-gate.md`
