# opencode-subagent-delegation

A skill + companion plugin pair for [opencode](https://opencode.ai): delegate
major todo items to subagents while keeping the orchestrator's context lean.

- `skills/opencode-subagent-delegation/SKILL.md` — the delegation workflow:
  break a plan into numbered ticket files, delegate each ticket to a subagent,
  gate commits on verified-green work (`wip:` prefix until the feature set is
  complete).
- `plugin/todo-protocol.ts` — rewrites the `todowrite` tool description to the
  flush/deque protocol (slug ids `item00`, Dewey-decimal insertion `item05.5`,
  bottom-default appends, footer items for discovered constraints, parallel
  `in_progress` for parallel subagents) and strips the shipped serial-todo
  prompt bullets.

## Division of responsibility

The plugin owns todo **list mechanics** (what a write means, how items are
identified and ordered). The skill owns **process** (plan → tickets →
delegation → commit gating). Where both speak, the tool description governs
list mechanics and the skill governs workflow.

## Install

Skill — make it discoverable by opencode's skill loader:

```sh
git clone https://github.com/prompt-cult/opencode-subagent-delegation
mkdir -p ~/.config/opencode/skills
ln -s "$(pwd)/opencode-subagent-delegation/skills/opencode-subagent-delegation" ~/.config/opencode/skills/
```

(or add the repo to `skills.paths` in `opencode.json(c)`).

Plugin — copy it into the plugin folder and list it in the global config:

```sh
cp opencode-subagent-delegation/plugin/todo-protocol.ts ~/.config/opencode/plugin/
```

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugin": ["./plugin/todo-protocol.ts"]
}
```

Restart opencode — plugins and skills load once at startup.

Verify: ask the running agent to quote the first sentence of its `todowrite`
tool description. It must begin "Maintain the session todo list." If it does
not, the plugin is not loaded.

## Scratch convention

v0.0.3+: the sidecar is NOT a todo list — the built-in `todowrite` list is
the hot, ordered set. The sidecar (`task_sidecar` custom tool) is COLD
storage: task detail (living md docs) plus the GLOBAL SEQUENCER (its
autoincrement id is the only global task number). DB at
`${VPS_GRAPEVINE_HOME:-~/.vps-grapevine}/task_sidecar_store.db`. Access
pattern: insert one row, read one row, lazy soft delete — nothing is ever
hard-deleted.

v0.0.4: the statuses are MIRRORED, mechanically. The plugin hooks every
`todowrite` flush: an item whose content starts with `N:` carries the global
sidecar id, and the flush sets row N's status to the item's status
(`completed` closes the row, `cancelled` soft-closes it). Models cannot
forget to close rows — closing the todo item IS closing the row. Rows not
referenced by the flush (parked, other sessions) are never touched.
Manual `task_sidecar update status=...` is only for rows outside the
built-in list. See the skill's setup step for the opencode.jsonc permission
whitelist and the call sequence. The old repo `.tmp/` convention below is
retained only for cancelled-attempt files (`.tmp/attic/`); `.tmp/*` is
gitignored; `.tmp/keep` keeps the folder in git. Nothing in scratch is
history: work belongs in git, in the todo list, or moved out of the way.
