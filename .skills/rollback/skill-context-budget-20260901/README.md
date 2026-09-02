# Project skill loading policy

This harness uses a two-tier skill system:

- **DAILY** skills are automatically discoverable under `.agents/skills/`.
- **LIBRARY** skills are canonical on-demand entries under
  `.skills/library/<skill-name>/`.

The structure was generated on 2026-09-01 and is designed to attach the
smallest relevant skill set for each task without loading the full library.

## DAILY

`.agents/skills/` contains 28 discoverable skills:

- 26 pinned LazyCodex skills;
- the Codex-specific Graphify skill; and
- `skill-library`, the dynamic task router.

LazyCodex plugin hooks, telemetry, MCP configuration, and plugin-level
installers were excluded. Graphify's Python package, hooks, and automatic
`AGENTS.md` installer were not run.

## Canonical LIBRARY

`.skills/library/` contains 88 direct child skill directories, one canonical
on-demand directory per skill name. The former `agents-user` and `codex-user`
management buckets are no longer part of the active library layout.

The original 98 entries contained nine duplicate names:

- Five had the same instruction body. The former `agents-user` version is the
  canonical entry because it also carries Codex UI metadata.
- Four had substantive instruction differences: `eval-harness`,
  `strategic-compact`, `tdd-workflow`, and `verification-loop`. Their richer
  `codex-user` versions are canonical.

The nine non-canonical originals remain inactive under
`.skills/archive/alternate-variants/`. They are preserved for comparison and
rollback but are never loaded automatically.

The former `codex-user` Graphify copy is archived there as a tenth inactive
alternative. Its canonical entry is the DAILY Graphify skill under
`.agents/skills/graphify`, so no active skill name exists in both tiers.

No standalone installation named `superpowers` was found during inventory. A
future installation can be added as another canonical library entry.

## Task-based dynamic attachment

`AGENTS.md` defines the session policy. For every task, Codex:

1. evaluates the DAILY skills already available;
2. searches only names and descriptions in `.skills/catalog.json` when a
   specialized retained capability may apply;
3. selects the smallest canonical skill set that covers the task;
4. announces the selected skill and reason in commentary;
5. reads each selected `SKILL.md` completely before task actions; and
6. reads only the supporting references required by the active workflow.

Library skills are attached for the current task only and are re-evaluated on
the next request. Loading a skill does not authorize its scripts, hooks,
package installs, credential access, network writes, or external mutations.

## Catalog, provenance, and rollback

- `catalog.json` contains 28 DAILY entries, 88 canonical on-demand entries,
  and ten inactive alternatives.
- `sources.lock.json` pins the LazyCodex and Graphify upstream commits.
- `rollback.json` records original paths, current paths, file counts, and tree
  hashes.
- `rollback/agents-user-junctions/` preserves the 39 original ECC junctions.
- `C:\Users\picom\.codex\skills\.system` remains protected and unchanged.
- Orca/OpenAI plugin caches were not modified.

Review upstream changes and bundled scripts before updating a pinned source.
Do not update from a floating branch name alone.
