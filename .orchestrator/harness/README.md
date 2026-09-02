# Canonical orchestration harness

`.orchestrator/harness/` is the only project-owned runtime for event storage, graph execution, admission, verification, and Bridge behavior. It is self-contained: it does not import plugin caches, external profiles, credentials, or network services.

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
```

The compiler validates canonical read/write identities, forbidden paths, and parallel write overlap before emitting a prompt. The prompt begins `/fast`, forbids worker planning/delegation, names the authorized skills, and contains capsule hashes instead of inherited conversation. Native orchestration still supplies the requested model and reasoning settings. Compare those requested values with observed provider metadata; the prompt is not proof that fast mode activated.

Independent, non-overlapping agents may run concurrently without an arbitrary model-call cap. The optimization target is serial transcript replay and oversized handoffs, not useful parallel calls. Keep complete tool output in an artifact and hand off typed digests.

Usage can be audited without retaining conversation content:

```text
node .orchestrator/harness/token-audit.mjs codex <rollout.jsonl>
node .orchestrator/harness/token-audit.mjs claude <result.json>
npm --prefix .orchestrator/harness run test:light
```

`bridge-launcher.mjs run-budgeted` continues to enforce exactly `tokens`, `toolCalls`, `wallSeconds`, and `processes`. Optional provider-level `usageDetails` is a content-free sidecar and never changes admission capacity.

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
