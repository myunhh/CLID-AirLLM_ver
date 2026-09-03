# Codex Navigation Guide

For the single whole-repository directory map, see
[`HARNESS-DIRECTORY-STRUCTURE.md`](HARNESS-DIRECTORY-STRUCTURE.md). This guide
keeps the narrower responsibility of safe navigation, ownership, evidence, and
handoff; it does not duplicate the repository tree.

## Scope and ownership

Treat the active worktree as the source of truth. Start by reading `AGENTS.md`, the assigned task capsule, and the working-tree status. Respect the ownership map in the capsule: modify only files explicitly assigned to you, preserve concurrent edits, and escalate an ownership conflict instead of resolving it by changing another worker's files.

This repository is a global ECC harness. Its files describe shared agent configuration and workflows; they are not evidence that every target project has the same layout, tools, or a Graphify graph. When operating in a target project, re-establish that project's root, instructions, and ownership boundaries before navigating its code.

## Evidence order

Gather the smallest reliable set of local evidence before proposing or making a change:

1. Read the task capsule and acceptance criteria.
2. Check the working-tree status and inspect only relevant diffs.
3. Read repository instructions and the directly affected files.
4. If the target project already has `graphify-out/graph.json`, query that graph before broad source searches; otherwise use `rg` and focused file reads.
5. Run the narrowest relevant verification, then inspect the resulting diff against the acceptance criteria.

For read-only work with independent evidence questions, use deterministic collectors and preflighted command-only agents in parallel. Do not add a DAG merely to count model calls; use one only for a real dependency, write boundary, durable audit, or gate. For mutation, keep the full approved capsule, integration, and independent-Judge workflow.

Do not create Graphify output while navigating this harness. In a target project, Graphify is conditional on an existing graph unless the human explicitly approves graph creation.

Invoking the approved virtual-scaffold `orchestrate` command is an explicit request to create fresh code-only pre/post Graphify artifacts for that named target. Its trusted plan directory must resolve outside the target workspace, and those artifacts belong below that external plan directory; the command must never create `graphify-out/` in this global harness root. Manual `plan` and `materialize` invocations retain their existing path behavior.

For the project-owned orchestration runtime, use `.orchestrator/harness/README.md` as the canonical invocation guide. Record the exact command, exit status, and artifact path for every acceptance or rollback scenario. Python/Bridge checks are launcher-mediated; do not substitute an ambient interpreter.

## PR diff packet

Before handoff, prepare a compact, evidence-backed packet containing:

- Scope: the requested objective and the owned files changed.
- Change summary: the behavioral or documentation effect of each changed area.
- Verification: exact checks run and their outcome; state clearly when no automated check applies.
- Diff review: confirmation that the diff contains no unrelated edits, credentials, generated artifacts, or ownership violations.
- Risks and follow-up: known limitations, deferred work, and any decision that still requires human approval.

Use file paths and concrete command outcomes rather than broad claims. External actions such as commits, pushes, pull requests, publishing, or configuration changes remain with the human unless explicitly approved.
