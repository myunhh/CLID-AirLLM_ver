# Capability-selection guide

For the complete repository map and the relationship between capability
selection, runtime, routing, compatibility, and evidence, see
[`docs/HARNESS-DIRECTORY-STRUCTURE.md`](../docs/HARNESS-DIRECTORY-STRUCTURE.md).
This guide deliberately covers only the `.skills/` capability plane.

## Selection boundaries

`AGENTS.md` governs task routing. The DAILY kernel lives in
`.agents/skills/`; it is evaluated first. When the kernel does not cover a
task, `skill-library` performs a targeted local search of names and
descriptions in `catalog.json` or `plugin-catalog.json`, resolves one
canonical entry, and reads only that entry's `SKILL.md`. The bounded lookup is
implemented by the DAILY router's `scripts/find-skill.mjs`; executing the
lookup does not execute a matched skill or expand the task's authority.

`.skills/library/` contains canonical on-demand skill bodies. The catalog is
the source of truth for the active inventory and its paths. Do not load the
library wholesale, and do not auto-load
`.skills/archive/alternate-variants/`; archived alternatives exist only for
comparison and rollback.

## Plugin metadata, provenance, and rollback

`plugin-catalog.json` records installed-plugin skill metadata, resolver globs,
and integrity values. Its disabled model-catalog metadata does not disable a
plugin's tools, apps, or connections. The router verifies the resolved path,
frontmatter name, and SHA-256 before reading a selected plugin skill; plugin
caches remain read-only provenance. Resolved plugin paths can be
machine-specific absolute cache paths. After an install or update, detect and
announce path/hash drift and resolve the newest matching installed version;
never repair drift by rewriting a plugin cache.

`sources.lock.json` pins upstream provenance. `rollback.json` and
`rollback/` record prior paths, material, and digests for recovery. Review
upstream changes before updating a pinned source; do not replace the catalog,
cache, or rollback records as part of ordinary task execution.

The `.skills/` plane is capability-selection data, not the orchestration
runtime. It is not runtime-imported and is not auto-loaded wholesale; reading
a skill does not authorize scripts, hooks, package installation, credential
access, network writes, or external mutation.
