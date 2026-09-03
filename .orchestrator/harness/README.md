# Canonical orchestration harness

`.orchestrator/harness/` is the only project-owned runtime for event storage, graph execution, admission, verification, and Bridge behavior. It does not import plugin caches, external profiles, or credentials. The automated scaffold lane launches only explicitly configured Graphify and agent-provider subprocesses.

For the whole-repository map and the boundary between runtime, capability
selection, routing, compatibility, and evidence, see the
[`docs/HARNESS-DIRECTORY-STRUCTURE.md`](../../docs/HARNESS-DIRECTORY-STRUCTURE.md).
This README remains the canonical invocation guide for the runtime and shim
cutover only.

Use `node .orchestrator/harness/bridge-launcher.mjs doctor` to inspect the selected interpreter without installation. Every Python test and Bridge execution must use `bridge-launcher.mjs`; never invoke ambient Python directly.

## Lightweight command lane

Read-only evidence work does not need a full run DAG unless it has real dependencies, durable-audit requirements, or a gate. Collect deterministically first, then compile one narrow command per independent agent:

```text
node .orchestrator/harness/command-worker.mjs compile --capsule <capsule-dir> --parallel <peer-capsule> --skill <SKILL.md>
# Add --fast only when the user explicitly requests accelerated mode.
```

The compiler validates canonical read/write identities, forbidden paths, and exact or parent/child parallel write overlap before emitting a prompt. The prompt forbids worker planning/delegation, lists canonical read roots and owned writes, and contains capsule hashes instead of inherited conversation. Ordinary mode is the default. Only the explicit API option or CLI `--fast` adds the acceleration directive, and provider-observed state remains separate evidence.

Independent, non-overlapping agents may run concurrently without an arbitrary model-call cap. The optimization target is serial transcript replay and oversized handoffs, not useful parallel calls. Keep complete tool output in an artifact and hand off typed digests.

Usage can be audited without retaining conversation content:

```text
node .orchestrator/harness/token-audit.mjs codex <rollout.jsonl>
node .orchestrator/harness/token-audit.mjs claude <result.json>
npm --prefix .orchestrator/harness run test:light
```

`bridge-launcher.mjs run-budgeted` remains the strict four-dimension admission lane for `tokens`, `toolCalls`, `wallSeconds`, and `processes`. The lightweight scaffold automation hard-stops elapsed wall time and its process tree, requires token telemetry for a successful provider response, and rejects post-observed token overages; current provider output does not expose a trustworthy tool-call or concurrent-process count, so those two blueprint fields are passed to the worker contract but are not claimed as hard runtime meters. Optional provider-level `usageDetails` is a content-free sidecar and never changes admission capacity.

## Contract-first virtual scaffold

`scaffold-pipeline.mjs` turns an approved architecture contract into a
deterministic scaffold and execution packet. The fail-closed order is:

```text
trusted policy -> blueprint validation -> independent review quorum
  -> digest-bound gate -> deterministic plan -> verified materialization
  -> mandatory structural Graphify gate -> maximum-safe waves
  -> bounded verified node attempts -> mandatory dependency Graphify gate
  -> independent Judge
```

The trusted policy, not blueprint self-claims, supplies task classification,
ambiguity signals, reserved roots, review quorum, and maximum retry policy.
Every review receipt names a declared non-builder Judge and binds the exact
blueprint, policy/quorum, nonce, and findings artifact bytes. Planning and
materialization replay those receipts; a gate JSON assembled without them is
not sufficient.

Run the stages explicitly:

```text
node .orchestrator/harness/scaffold-pipeline.mjs validate <blueprint.json> <policy.json>
node .orchestrator/harness/scaffold-pipeline.mjs gate <blueprint.json> <policy.json> <gate.json> <receipt.json...>
node .orchestrator/harness/scaffold-pipeline.mjs plan <blueprint.json> <policy.json> <gate.json> <workspace-root> <plan-dir>
node .orchestrator/harness/scaffold-pipeline.mjs materialize <blueprint.json> <policy.json> <gate.json> <workspace-root> <plan-dir>
node .orchestrator/harness/scaffold-pipeline.mjs attempt-begin <plan-dir> <ledger-dir> <node-id> <attempt-id>
node .orchestrator/harness/scaffold-pipeline.mjs attempt-complete <plan-dir> <ledger-dir> <node-id> <attempt-id> <pass|fail> <result-artifact>
node .orchestrator/harness/scaffold-pipeline.mjs graph-diff <blueprint.json> <policy.json> <observed-graph.json>
node .orchestrator/harness/scaffold-pipeline.mjs orchestrate <blueprint.json> <policy.json> <gate.json> <workspace-root> <plan-dir> [--runtime-config <json>] [--fast]
```

For `orchestrate`, `<plan-dir>` is the trusted control plane and must resolve
outside `<workspace-root>`; this prevents a workspace-write coding agent from
altering future capsules, the attempt ledger, or runtime events. The manual
`plan` and `materialize` primitives retain their existing path behavior.

`plan` writes the v2 execution graph, deterministic `waves.json`, manifest,
sidecars, and six-file command-only capsules before product agents run.
`materialize` recompiles and byte-verifies that plan against the real workspace,
then exclusively publishes concise `IMPLEMENTATION_REQUIRED` stubs and detailed
contract sidecars. Its journal can resume recorded local work after an
interruption; differing or identity-uncertain files are preserved and rejected.
Locks and Judge names are local workflow assertions, not authentication against
a privileged filesystem actor.

Each blueprint file may bind `skillPaths` and `verificationCommands`. Selected
skill paths are workspace-relative, become explicit read authority, and are
named in the worker prompt; workers do not discover or attach additional
skills. Verification commands are `{ "command": "...", "args": [...],
"cwd": "optional/relative/path" }` argument vectors. They remain optional for
the legacy manual primitives, while `orchestrate` requires at least one per
file and executes them without a shell.

The legacy stage commands remain model-free primitives. `orchestrate` composes
them into one resumable command: it creates or verifies the plan, materializes
stubs, runs a fresh code-only structural graph gate, dispatches each maximum
disjoint ready wave, runs gate-bound verification commands with bounded retry,
and requires a fresh dependency graph match before returning `COMPLETE`.
Coding agents own only their product file; the orchestrator writes result
evidence. Workspace hashes detect additions, removals, type changes, or edits
outside the active wave before later stages can start. The append-only event
chain binds resume to the same plan, gate, policy, workspace, runtime config,
and requested execution mode. Each worker receives the exact contract sidecar
as a required read; a retry additionally receives only its own prior result
evidence.

The default adapter sends the compiled prompt to `codex exec --ephemeral` over
stdin and invokes Graphify with argument arrays and no shell. A strict runtime
config can substitute fake or local executables for deterministic testing.
Accelerated mode is never inferred from blueprint, capsule, environment, or
configuration content; only the explicit `--fast` request enables it. Node
retries remain local to the plan-bound attempt ledger and never add a back-edge
to the outer DAG.

For the manual `graph-diff` command, the observed graph remains explicit input
and the comparator neither creates nor updates it. The automated lane writes
fresh pre/post Graphify output below the plan runtime directory, never this
global harness root. Both lanes accept Graphify's native node-link JSON (`links`) as well as the
compact harness form (`edges`). Graphify may store its NetworkX container as
undirected while preserving each link's original source/target order; the
blueprint's file DAG remains explicitly directed. Native comparison projects
only `imports`, `imports_from`, and `re_exports` links, so cross-file calls or
semantic references cannot masquerade as declared file dependencies. A symbol
graph may contain several nodes and links per source file; comparison collapses
those to declared file dependencies, ignores same-file links and
provenance-free semantic nodes, and rejects missing, reversed, unexpected,
aliased, dangling, or dependency self-loop relationships. In a target project
that already has a Graphify graph, build or update it through that project's
approved Graphify workflow, then pass that `graphify-out/graph.json` path to
`graph-diff`. Manual comparison is closed-world for attributed source files: scope the
observed graph to the scaffold, or enumerate every attributed file in that
graph in the blueprint. Unlisted attributed files are intentionally reported
as `UNEXPECTED_SOURCE_FILE`. Automated structural and dependency gates project
the larger target graph to declared files: the first proves every scaffold file
is indexed without requiring stub imports, while the second requires the exact
declared inter-file dependency set.

Run the focused acceptance suite with:

```text
npm --prefix .orchestrator/harness run test:scaffold
```

## Legacy shim cutover

After canonical acceptance succeeds, make the legacy compatibility entry points thin delegates with this reversible sequence:

```text
node .orchestrator/harness/shim-cutover.mjs snapshot
node .orchestrator/harness/shim-cutover.mjs install
node .orchestrator/harness/shim-cutover.mjs test
node .orchestrator/harness/shim-cutover.mjs verify
```

`snapshot` saves and verifies exact bytes, SHA-256, and length in fixed `*.pre-harness-v2` backups before either shim changes. `install` replaces each shim atomically from a same-directory temporary file. On install or verification failure it restores both originals; an unrecoverable rollback reports `SHIM_RECOVERY_REQUIRED` and retains recovery artifacts.

Use `node .orchestrator/harness/shim-cutover.mjs restore` for an explicit rollback. Restore keeps the manifest and backups and is idempotent. The installed shims delegate only to the launcher-selected canonical Bridge or Node verifier and forward their exit status.

`shim-cutover.mjs test` first runs the launcher’s `run-shim-tests`, then asks `bridge-launcher.mjs doctor` for its selected interpreter and uses that selected invocation for both installed legacy entrypoints. It checks canonical help delegation and forwarded `2`/`1` failure exits. An unexpected test failure restores both original entries before returning its stable failure.
