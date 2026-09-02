---
name: skill-library
description: "Select and attach canonical project or installed-plugin skills on demand. Use when the DAILY kernel does not cover a task or the request names a retained specialized capability."
---

# Dynamic Skill Library

The project keeps a small always-discoverable kernel in `.agents/skills/`,
canonical project skills in `.skills/library/`, and installed plugin skill
metadata in `.skills/plugin-catalog.json`. Attaching means reading and following
the selected `SKILL.md` for this task; it does not reinstall or enable anything.

## Attach skills for a task

1. Follow the repository's `AGENTS.md` skill-loading policy first.
2. Resolve the repository root. In this harness it is `C:\vsc`.
3. Evaluate whether an available DAILY skill fully covers the request. If it
   does, do not search the library merely to add more context.
4. Search both catalogs with the bounded helper, which reads them locally but
   returns at most five ranked candidates:
   `node <repo-root>/.agents/skills/skill-library/scripts/find-skill.mjs --query
   <capability words> --limit 5`. Quoting is optional, which keeps the command
   reliable through Windows shell fallbacks. Use `--scope project` or `--scope plugin` when the
   source is already known. Do not use broad `rg`, `Get-Content`, `type`, or
   equivalent commands on a whole catalog, and never print or load either full
   catalog into model context.
5. Prefer an exact named match. For capability matching, inspect only the few
   candidate names and descriptions, then choose the narrowest canonical entry
   or minimal non-overlapping set that fully covers the task.
6. Announce in commentary which on-demand skill is being attached, why it
   matches, and the order when more than one is required.
7. For a project entry, resolve `.skills/library/<name>/SKILL.md`. For a plugin
   entry, first verify `resolved_skill_md` exists, its SHA-256 matches, and the
   visible name equals `<plugin_id>:<frontmatter name>`. If an update causes
   drift, expand only that entry's `resolver_glob`, select the newest matching
   installed version, verify its frontmatter name, and announce the drift.
8. Read each selected `SKILL.md` completely before taking task actions. Resolve
   relative resources from that skill directory and load only the resources
   required by the active workflow.
9. Apply the selected instructions for the current task, subject to system,
   developer, user, and repository instructions.
10. Re-evaluate on the next user request. Do not carry an on-demand skill forward
   unless the new request independently triggers it or names it again.

## Boundaries

- Never load the entire library into context.
- Never auto-load `.skills/archive/alternate-variants/`. Read an archived
  variant only when the user explicitly asks to compare, restore, or audit it.
- Plugin skill metadata being disabled in the model catalog does not disable
  the plugin's tools, apps, or connections. Do not edit plugin caches while
  resolving or attaching a skill.
- Treat bundled scripts as inactive files until the selected skill explicitly
  needs one. Loading does not authorize package installation, hooks,
  credentials access, network writes, or external mutations.
- If no canonical entry matches, continue with ordinary tools or attach a
  discovery skill such as `find-skills` or `skill-scout` when appropriate.
