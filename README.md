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

v0.0.2+: ticket files (`itemNN.md`) and their living documents are written
through the `todo_ng` custom tool into a durable SQLite sidecar at
`${VPS_GRAPEVINE_HOME:-~/.vps-grapevine}/todo_ng.db` (global autoincrement
ids; `md_path` points at the living doc the tool writes). See the skill's
setup step for the opencode.jsonc permission whitelist. The old repo
`.tmp/` convention below is retained only for cancelled-attempt files
(`.tmp/attic/`); `.tmp/*` is gitignored; `.tmp/keep` keeps the folder in
git. Nothing in scratch is history: work belongs in git, in the todo
list, or moved out of the way.
