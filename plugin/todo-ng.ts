// todo-ng — durable cross-session todo store as an opencode custom tool.
// Wraps TodoNgStore (plugin/todo-ng-store.ts), a SQLite sidecar DB at
// ${VPS_GRAPEVINE_HOME:-~/.vps-grapevine}/todo_ng.db. Unlike the per-session
// todowrite list, todo_ng rows survive sessions, compaction and repo .tmp
// cleanups; each row can point at its living document via link_md.
import { tool } from "@opencode-ai/plugin"
import { TodoNgStore, todoNgDbPath } from "./todo-ng-store"

let store: TodoNgStore | undefined
function getStore(): TodoNgStore {
  if (!store) store = new TodoNgStore(todoNgDbPath())
  return store
}

const TODO_NG_DESCRIPTION = `Durable cross-session todo store (global SQLite sidecar, autoincrement ids). Unlike the per-session todowrite list, rows here survive restarts, compaction and repo scratch cleanups. Actions:
- add: new row (todo required; optional status/priority). Returns the permanent id.
- list: all rows (optional status filter), oldest-first by id.
- get: one row by id.
- update: patch status/priority/todo by id. cancelled keeps the record.
- link_md: write the item's living document (md_path + md_content) and record the path on the row.
The fat record for an item is its living document; write/amend it via link_md, not by stuffing prose into the todo text.`

export default (async () => ({
  tool: {
    todo_ng: tool({
      description: TODO_NG_DESCRIPTION,
      args: {
        action: tool.schema.string().describe("add | list | get | update | link_md"),
        id: tool.schema.number().optional().describe("row id (get/update/link_md)"),
        todo: tool.schema.string().optional().describe("todo line (add; optional on update)"),
        status: tool.schema.string().optional().describe("pending | in_progress | completed | cancelled"),
        priority: tool.schema.string().optional().describe("high | medium | low"),
        session_id: tool.schema.string().optional().describe("opencode session id (optional)"),
        md_path: tool.schema.string().optional().describe("living doc path (link_md)"),
        md_content: tool.schema.string().optional().describe("living doc content (link_md)"),
      },
      async execute(args) {
        const s = getStore()
        try {
          switch (args.action) {
            case "add": {
              if (!args.todo) throw new Error("add requires 'todo'")
              const row = s.add({
                todo: args.todo,
                status: args.status,
                priority: args.priority,
                session_id: args.session_id ?? null,
              })
              return JSON.stringify(row, null, 2)
            }
            case "list":
              return JSON.stringify(s.list({ status: args.status }), null, 2)
            case "get": {
              if (args.id === undefined) throw new Error("get requires 'id'")
              const row = s.get(args.id)
              if (!row) throw new Error(`no todo_ng row with id ${args.id}`)
              return JSON.stringify(row, null, 2)
            }
            case "update": {
              if (args.id === undefined) throw new Error("update requires 'id'")
              const row = s.update(args.id, {
                todo: args.todo,
                status: args.status,
                priority: args.priority,
                session_id: args.session_id,
              })
              if (!row) throw new Error(`no todo_ng row with id ${args.id}`)
              return JSON.stringify(row, null, 2)
            }
            case "link_md": {
              if (args.id === undefined || !args.md_path || args.md_content === undefined)
                throw new Error("link_md requires 'id', 'md_path' and 'md_content'")
              const row = s.linkMd(args.id, args.md_path, args.md_content)
              if (!row) throw new Error(`no todo_ng row with id ${args.id}`)
              return JSON.stringify(row, null, 2)
            }
            default:
              throw new Error(`unknown action "${args.action}" (use add|list|get|update|link_md)`)
          }
        } catch (e) {
          return `todo_ng error: ${(e as Error).message}`
        }
      },
    }),
  },
}))
