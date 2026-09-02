---
name: skill-library
description: "Select and attach canonical on-demand skills from the project catalog for the current task. Use when a request names a retained ECC, Superpowers, or other LIBRARY capability; when DAILY skills do not fully cover the work; or when a specialized catalog entry would materially improve the result."
---

# Dynamic Skill Library

The project keeps always-discoverable skills in `.agents/skills/` and one
canonical on-demand entry per skill name in `.skills/library/`. Attaching a
skill means reading and following it for the current task, not reinstalling it.

## Attach skills for a task

1. Follow the repository's `AGENTS.md` skill-loading policy first.
2. Resolve the repository root. In this harness it is `C:\vsc`.
3. Evaluate whether an available DAILY skill fully covers the request. If it
   does, do not search the library merely to add more context.
4. Otherwise read `<repo-root>/.skills/catalog.json`. Search only canonical
   `name` and `description` fields; do not open every library entry.
5. Prefer an exact named match. For capability matching, select the narrowest
   canonical entry or minimal set of non-overlapping entries that fully covers
   the task.
6. Announce in commentary which LIBRARY skill is being attached, why it
   matches, and the order when more than one is required.
7. Read each selected `SKILL.md` completely before taking task actions. Resolve
   relative resources from that skill directory and load only the resources
   required by the active workflow.
8. Apply the selected instructions for the current task, subject to system,
   developer, user, and repository instructions.
9. Re-evaluate on the next user request. Do not carry a LIBRARY skill forward
   unless the new request independently triggers it or names it again.

## Boundaries

- Never load the entire library into context.
- Never auto-load `.skills/archive/alternate-variants/`. Read an archived
  variant only when the user explicitly asks to compare, restore, or audit it.
- Treat bundled scripts as inactive files until the selected skill explicitly
  needs one. Loading does not authorize package installation, hooks,
  credentials access, network writes, or external mutations.
- If no canonical entry matches, continue with ordinary tools or attach a
  discovery skill such as `find-skills` or `skill-scout` when appropriate.
