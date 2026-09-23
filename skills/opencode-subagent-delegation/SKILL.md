---
name: opencode-subagent-delegation
description: Use when working through a multi-item todo list of non-trivial engineering tasks — delegate each major item to a subagent with a written spec file, keep the orchestrator context lean, and gate commits on verified-green work with a wip prefix until the feature set is complete.
---

# Subagent Delegation Process

Major todo items are delegated to subagents to keep the orchestrator's context lean.

## Division of responsibility

The companion `todo-protocol` plugin owns the todo LIST mechanics — the flush
protocol, slug numbering, deque semantics, statuses, footer items — via the
rewritten `todowrite` tool description. This skill owns the WORKFLOW: turning a
plan into numbered ticket files, delegating each ticket to a subagent, and
gating commits on verified-green work. Where both speak, the tool description
governs list mechanics and this skill governs process.

## Setup (once per environment, with the user's permission)

1. **Companion plugin.** This skill requires the `todo-protocol` plugin
   (`plugin/todo-protocol.ts` in this repository). Verify it is loaded by asking
   the running agent to quote the first sentence of its `todowrite` tool
   description: it must begin "Maintain the session todo list." If it does not:
   copy `plugin/todo-protocol.ts` to `~/.config/opencode/plugin/`, add
   `"plugin": ["./plugin/todo-protocol.ts"]` to
   `~/.config/opencode/opencode.json(c)` (ask before modifying the user's
   config), and restart opencode.
2. **Scratch folder.** Tickets and living documents live inside the working
   repository under `.tmp/` so they survive compaction and no plan or spec ever
   needs a write outside the repo root. If the working repository has no
   `.tmp/` folder (look for `.tmp/keep`), ask the user for permission, then
   create it with a `keep` marker and add to the repo's `.gitignore`:
   `.tmp/*` and `!.tmp/keep`.

## Process

1. **Break the plan into items.** Decompose the user's plan into todo items and
   write one ticket file per item into the scratch folder: `item00.md`,
   `item01.md`, … The ticket file is the item's living document — the fat
   record: full spec, decisions, amendments. Number the todo items to match the
   ticket files: the todo `content` starts with the same slug as its file
   (`item00`). Dewey-decimal insertion files new items between existing ones
   (`item05.5` between `item05` and `item06`); write `item05.5.md` and never
   renumber existing files or items.
2. Follow the `todowrite` tool description for every list write: construct the
   whole list, flush once, batch status changes at natural boundaries.
3. Launch one agent per ticket. The agent must:
   - implement the work per the ticket (`itemNN.md`),
   - verify its work is green (run the relevant tests/builds),
   - `git add` its changes, but **NEVER `git commit`**.
4. On the agent's return, it reports whether the work was fully done or lists
   follow-on work. The orchestrator must then:
   - mark the todo item done,
   - add any follow-on work as new todo items with their own ticket files,
   - review the diff (`git status`, `git diff --cached`),
   - if the code is green with respect to the current tests (the current TDD bar),
     `git commit`. Use the message prefix `"wip: <summary>"` while the full feature
     set is not yet complete; use a normal message once it is.
5. In this manner subagents handle the majority of tool calls, keeping the
   orchestrator's context lean.
6. **No dangling work, ever.** Before each outer commit the orchestrator must
   check for and tear down dangling runs: processes started by cancelled or
   completed agent attempts (smoke servers, clients, simulators still running),
   and hung or wedged processes. Terminate clear orphans deliberately — never
   the operator's own deliberate, long-running jobs. Files produced by
   cancelled attempts move to a `.tmp/attic/` folder inside the workspace; at
   a milestone tidy-up, when the orchestrator asks, attic content moves to
   `/tmp/` to clean up. Nothing may be left: work is in git, in the todo
   list, moved out of the way, or terminated. (Laptop-specific detection
   tooling — brew-installed procs/pgrep scanners etc. — belongs in the
   repository's own tooling per its `AGENTS.md`; never embed laptop-specific
   tooling in this skill.)

## IMPORTANT — Keep the repository's AGENTS.md in sync

The repository's `AGENTS.md` should be updated to include an entry stating that
agents SHOULD prefer to use this skill wherever doing so does not overwrite any
other instructions in that `AGENTS.md` or the user's prior statements of preference.
