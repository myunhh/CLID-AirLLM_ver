# Classification and budgets

## Model routing

The main thread remains on `gpt-5.6-sol` by default. Model selection for bounded subagents is task-specific rather than determined only by the S/M/L/XL class:

| Task characteristics | Default model | Route examples |
|----------------------|---------------|----------------|
| Efficient, high-volume, low-risk | `gpt-5.6-luna` | Read-only exploration, evidence collection, indexing, simple classification, repetitive checks |
| Balanced, scoped implementation | `gpt-5.6-terra` | Routine coding, tests, formatting, debugging, bounded refactors |
| Ambiguous, high-impact, or judgment-heavy | `gpt-5.6-sol` | Architecture, security, migrations, cross-module integration, independent judging |

Escalate Luna to Terra for implementation or substantial synthesis. Escalate Terra to Sol when risk, ambiguity, or impact exceeds the capsule assumptions. Explicit user model overrides always win for the agent they address, and the orchestrator must record the override in the task capsule rather than silently normalizing it.

## S — bounded local change

- Typical scope: one or two files, one obvious behavior.
- Context packet: task statement, ownership, acceptance, and at most one recent parent turn.
- Tool budget: 10 calls.
- Retry budget: one implementation retry.
- Pipeline: orchestrator -> single executor -> deterministic verification.

## M — multi-file feature or defect

- Typical scope: three to eight files or one graph community.
- Context packet: task statement, graph query, selected file excerpts, ownership, acceptance, and at most two recent parent turns.
- Tool budget: 25 calls per worker.
- Retry budget: two implementation retries.
- Pipeline: graph/explorer -> planner -> worker(s) -> integrator -> independent judge.

## L — cross-module change

- Typical scope: more than eight files, multiple graph communities, migration, or integration boundary.
- Context packet: one capsule per subtask, never the entire parent history; at most three recent parent turns when unavoidable.
- Tool budget: 40 calls per worker.
- Retry budget: two implementation retries, then human escalation.
- Pipeline: graph mapping -> DAG plan -> human stage gate -> isolated workers -> integrator -> independent judges -> graph impact check.

## XL — architecture, security, destructive, or externally consequential

- No automatic execution.
- Produce evidence, alternatives, boundaries, rollback, and staged acceptance criteria.
- Human approval is required at every consequential stage.

Budgets are controller limits, not model context-window settings. The orchestrator enforces them by restricting inputs, counting actions, interrupting drift, and refusing extra retries.

Model-call count is not a quality or efficiency cap. Parallelize independent, non-overlapping capsules when capacity permits; optimize repeated serial transcript replay, redundant reads, and unbounded returned output. Record requested versus observed model, reasoning, and fast state so `/fast` is never a silent fallback claim.

For an S-grade action already inside an approved node, use the node-local Bridge only when its live launcher and ownership lock are available. Keep it in the current node, poll its bounded result, and tear down descendants before releasing locks. If it needs a new human gate, cross-node write boundary, or unavailable containment, stop and escalate instead of improvising.

## Execution graph sizing

Use an execution graph only when approved stages contain a real dependency, join, parallel ownership boundary, or human gate. Do not manufacture nodes for one-step work. Each task node must have one bounded capsule, explicit write ownership, immutable acceptance criteria, and a non-negative retry cap. A larger S/M/L/XL class does not justify an unbounded node or retry budget.

The outer graph must remain acyclic. Retry behavior belongs inside a node-local state machine and cannot add a back-edge to the outer graph. When verification exhausts a node's retry cap, transition it to `ESCALATED` and return judgment to the human or main orchestrator.

For rollback-sensitive compatibility work, acceptance includes canonical pre-cutover checks, exact backup byte/hash validation, atomic replacement, failure restoration, explicit restoration, and a second restoration proving idempotence.

Ready nodes may execute in parallel only when neither depends on the other and their normalized `writeFiles` ownership does not overlap. Converging work uses an explicit join node whose dependencies must all be `SUCCEEDED` before it becomes ready.

For read-only work without a durable-audit requirement, deterministic collection plus command-only parallel agents and one final independent Judge supersedes the heavier M/L pipeline descriptions above. Mutation and external-action work never uses that shortcut.
