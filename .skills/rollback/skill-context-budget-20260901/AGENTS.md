## Skill loading policy

Use the project-local two-tier skill layout for every user request:

1. Treat every skill under `.agents/skills/` as DAILY and automatically
   discoverable. This tier contains the pinned LazyCodex set, Graphify, and the
   `skill-library` router.
2. Evaluate DAILY skills first. When they do not fully cover the request, or a
   request names or clearly matches a retained capability, invoke
   `skill-library` and inspect only names and descriptions in
   `.skills/catalog.json`.
3. Attach the smallest canonical LIBRARY skill set that covers the task. Before
   taking task actions, announce the selected skills and order in commentary,
   read each selected `.skills/library/<name>/SKILL.md` completely, and load
   only the supporting references required by the active workflow.
4. Re-evaluate skill selection for every new request. Do not carry a LIBRARY
   skill into a later turn unless that request independently triggers it or the
   user names it again.
5. Never auto-load `.skills/archive/alternate-variants/` or the whole library.
   Loading a skill does not authorize scripts, hooks, package installs,
   credential access, network writes, or other external mutations.

The protected Codex system skills and plugin caches remain outside this
project policy. Provenance and recovery mappings live in `.skills/`.

## graphify

This folder is a global ECC harness source, not a target project. It intentionally does not contain a `graphify-out/` knowledge graph.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

For work in an actual target project, apply these rules relative to that project's root, and only when `graphify-out/graph.json` already exists there:

- For codebase questions, first run `graphify query "<question>"`. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually smaller than `GRAPH_REPORT.md` or raw source search output.
- Dirty graph artifacts are expected after hooks or incremental updates; they are not a reason to skip Graphify. Skip Graphify only when the task concerns stale or incorrect graph output, or the user explicitly says not to use it.
- If `graphify-out/wiki/index.md` exists, use it for broad navigation. Read `graphify-out/GRAPH_REPORT.md` only for broad architecture review or when query, path, and explain do not provide enough context.
- After modifying target-project code, run `graphify update .` only if that target project already has a graph and the task permits updating it. Never create a graph in this global harness merely to satisfy these instructions.

For ownership, evidence order, and PR diff packets, read `docs/CODEX-NAVIGATION-GUIDE.md`.
