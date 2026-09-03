# ECC Harness Directory Structure

This is the canonical whole-repository map for the ECC harness. It describes
which plane owns a concern and how the planes connect; the narrower READMEs
link here instead of reproducing this tree.

## Planes and boundaries

```text
C:\\vsc\\
|-- AGENTS.md                         root policy and operating constraints
|-- .gitignore                        narrow, explicit local-file exclusions
|-- *.md                              harness proposals and decision context
|-- .agents/
|   `-- skills/                       DAILY capability kernel
|-- .skills/
|   |-- catalog.json                  capability-selection inventory
|   |-- plugin-catalog.json           installed-plugin skill inventory
|   |-- library/                      canonical on-demand skill bodies
|   |-- archive/alternate-variants/   inactive alternatives only
|   |-- rollback/                     recoverable original layout material
|   |-- rollback.json                 move, digest, and rollback record
|   |-- sources.lock.json             pinned upstream provenance
|   `-- README.md                     capability-selection guide
|-- .codex/
|   |-- config.toml                   safe project defaults and role routing
|   |-- agents/                       bounded role configuration
|   `-- hooks.json*                   machine-bound hook configuration/backup
|-- .orchestrator/
|   |-- definitions/                  approved execution-DAG definitions
|   |-- tasks/                        task capsules and their RESULT.md files
|   |-- runs/                         per-run definitions, event chains, receipts
|   |-- harness/                      canonical runtime, profiles, audit/command CLIs
|   `-- kernel-bridge/                compatibility entry points and backups
|-- .omo/
|   `-- evidence/                     attempt-level captured evidence
`-- docs/
    |-- HARNESS-DIRECTORY-STRUCTURE.md this canonical map
    `-- CODEX-NAVIGATION-GUIDE.md     focused navigation and handoff guide
|-- prime-agent/                      nested target repository; separate policy
|-- tmp/                              disposable local scratch material
|-- myenv*/                           ignored local Python environments
`-- private local files               ignored credentials/data where listed
```

The root policy files establish operating constraints before a task touches any
plane. Root proposal documents provide historical or design context; they do
not replace `AGENTS.md`, task capsules, or canonical runtime behavior.
`prime-agent/` is a nested checkout with its own `.git` and `AGENTS.md`; enter
it only as a distinct target repository and re-resolve its policy. `tmp/`,
local environments, and private data are not harness integration surfaces.
`.gitignore` lists only specific exclusions, so an unlisted local path must not
be assumed ignored or safe to publish.

## Capability selection

`.agents/skills/` is the small DAILY kernel: these foundational instructions
are available for ordinary task routing. `.skills/library/` is the canonical
on-demand library. A task uses the DAILY kernel first and calls the
`skill-library` router only when a narrowly matching library or plugin skill is
needed. The router reads targeted name and description fields in
`.skills/catalog.json` or `.skills/plugin-catalog.json`, resolves one canonical
entry, and then reads that entry's `SKILL.md`. Its local
`scripts/find-skill.mjs` performs this bounded catalog search; running that
kernel-owned helper does not execute the selected skill or grant new authority.

`.skills/plugin-catalog.json` is metadata about installed plugin skills. It
records resolver and integrity information while model-catalog skill metadata
remains disabled; plugin packages, tools, apps, and connections are not
changed by this catalog. Resolved plugin paths may be machine-specific cache
paths, so the router must re-check the selected path and SHA-256 after plugin
updates and report drift without rewriting the cache. `.skills/archive/alternate-variants/` is inactive and
never selected automatically. `.skills/rollback/`, `rollback.json`, and
`sources.lock.json` preserve rollback material and provenance for the active
layout.

The `.skills/` plane is capability-selection data: it is **not runtime-imported
and is not auto-loaded wholesale**. It neither supplies the harness runtime
nor authorizes scripts, hooks, package installation, credential access, network
writes, or external mutations.

## Canonical runtime and compatibility

`.orchestrator/harness/` is the only project-owned runtime. Its Node controller
owns DAG validation, admission, event storage, event verification, and Judge
receipt handling. `bridge-launcher.mjs` selects the Python interpreter for the
launcher-only Bridge facade; Python execution goes through that launcher.
The local `profiles/fast-v1.json`, `command-worker.mjs`, and `token-audit.mjs`
provide requested/observed execution metadata, preflighted command-only
handoffs, and content-free provider usage accounting. They neither import
external profiles nor change the four admission capacity dimensions.

`.orchestrator/kernel-bridge/` is a compatibility plane, not a second runtime.
Its legacy entry points delegate to the canonical harness after the reversible
shim cutover. The pre-harness backups and cutover manifest support explicit,
idempotent restoration. Compatibility shims therefore never become a source of
runtime policy or a dependency on `.skills/`, plugin caches, profiles,
credentials, or network services.

`.codex/` is the agent-routing plane. `config.toml` provides safe project
defaults and bounded role definitions; working MCP server definitions and
credentials remain outside the project configuration. `hooks.json` is a
separate machine-bound hook definition: the current Bash pre-tool hook invokes
a Graphify executable installed under the user profile. Treat that absolute
path as an explicit local dependency to review on each machine, not as a
portable runtime component or authorization for credentials or network writes.
The routing plane selects how agents are configured, while
`.orchestrator/harness/` executes the approved work graph.

For target-project creation work, the harness can compile a reviewed blueprint
into a dry-run plan and later materialize concise product stubs plus detailed
contract sidecars under that target's
`.orchestrator/blueprints/<blueprint-id>/`. This optional target-project output
is not a second runtime and is intentionally absent from this global harness
source tree. Its execution graph and maximum-safe waves schedule approved work;
the host agent runtime performs model dispatch. An observed source graph stays
separate and is supplied explicitly for declared-versus-observed comparison.

## Execution state and evidence

`.orchestrator/definitions/` holds reusable approved DAG definitions.
`.orchestrator/tasks/` holds bounded task capsules (task, context, ownership,
acceptance, budget, and result records). `.orchestrator/runs/` holds a concrete
run's execution graph, append-only event chain, and verification receipts.
`.omo/evidence/` holds captured attempt-level evidence when no active attempt
directory is supplied by the work loop. A task `RESULT.md` summarizes its
owned changes and points to the command outputs or evidence artifacts that
support acceptance.

## Request-to-verdict flow

```text
request
  -> AGENTS.md policy and working-tree/ownership checks
  -> DAILY kernel; targeted catalog lookup only when needed
  -> read-only: deterministic collection and preflighted parallel commands
  -> mutation/gated: trusted blueprint review, scaffold plan, approved DAG, capsules, and centralized integration
  -> Bridge through bridge-launcher.mjs when Python work is required
  -> content-free usage sidecar plus append-only events when requested
  -> one final Judge, or receipt-bound per-node Judge for the governed lane
```

Human approval remains the authority for plan stages and external actions. A
Judge verifies the declared acceptance evidence; it does not replace human
authority to publish, merge, change credentials, or make other external
changes.

## Documentation entrypoints

Use this document for repository-wide placement and relationships. Use
[`../.orchestrator/harness/README.md`](../.orchestrator/harness/README.md) for
runtime and shim-cutover invocation, [`../.skills/README.md`](../.skills/README.md)
for capability selection, and
[`CODEX-NAVIGATION-GUIDE.md`](CODEX-NAVIGATION-GUIDE.md) for scoped navigation,
ownership, evidence order, and handoff expectations.
