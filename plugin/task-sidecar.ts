// task-sidecar — the COLD side: durable task detail store + global sequencer
// as an opencode custom tool. Wraps TaskSidecarStore
// (plugin/task-sidecar-store.ts), a SQLite sidecar DB at
// ${VPS_GRAPEVINE_HOME:-~/.vps-grapevine}/task_sidecar_store.db. THIS IS NOT
// THE TODO LIST: the built-in todowrite list is the hot, ordered set; this is
// cold blob storage for task detail (living md docs) plus the global issue
// sequencer. Rows survive sessions, restarts, compaction and repo cleanups;
// rows are never hard-deleted — lazy soft delete only.
import { tool } from "@opencode-ai/plugin"
import { TaskSidecarStore, taskSidecarDbPath } from "./task-sidecar-store"

let store: TaskSidecarStore | undefined
function getStore(): TaskSidecarStore {
  if (!store) store = new TaskSidecarStore(taskSidecarDbPath())
  return store
}

const TASK_SIDECAR_DESCRIPTION = `Cold task-detail store + global sequencer (SQLite sidecar, global autoincrement ids). THIS IS NOT THE TODO LIST: the built-in todowrite tool is the live, ordered todo list (the hot set). This store is the cold storage of task detail (the "bucket of md") and the global sequencer that assigns task numbers. NEVER read the DB directly; these rules are the API.

Rules:
- Access pattern: INSERT one row, READ one row, LAZY SOFT DELETE. Nothing is ever hard-deleted; superseded work is marked completed/cancelled via update.
- The autoincrement id IS the task number (creation sequence, not order — ordering/reordering lives in the built-in todo list).

Call sequence (allocating a new task):
1) task_sidecar add (todo = one-line blob) -> returns the permanent id N [the sequencer]
2) todowrite: insert/update the built-in list with description "N: <task>" — the id is the item number
3) task_sidecar link_md id=N md_path=<living doc> md_content=<fat record: full spec, decisions, amendments>

Later:
- task_sidecar update id=N status=completed|cancelled (keeps the record)
- task_sidecar link_md again to amend the living doc

Recovery (crashed session): task_sidecar list, see what is pending/in_progress vs completed, rebuild your built-in todo list from that.

Actions:
- add: new row (todo required; optional status/priority). Returns the permanent id.
- list: rows (optional status/session_id filter; show_deleted to include soft-deleted), ascending by id.
- get: one row by id (skips soft-deleted; show_deleted includes).
- update: patch status/priority/todo by id. cancelled keeps the record.
- link_md: write the task's living document (md_path + md_content) and record the path on the row.
- purge_older_than: LAZY soft delete all rows created before 'before' (ISO ts). Returns the count.
- list_since: rows created at/after 'since' (ISO ts), ascending, respecting soft delete; show_deleted includes them.
The fat record for a task is its living document; write/amend it via link_md, not by stuffing prose into the todo text.`

export default (async () => ({
  tool: {
    task_sidecar: tool({
      description: TASK_SIDECAR_DESCRIPTION,
      args: {
        action: tool.schema
          .string()
          .describe("add | list | get | update | link_md | purge_older_than | list_since"),
        id: tool.schema.number().optional().describe("task id (get/update/link_md)"),
        todo: tool.schema.string().optional().describe("one-line task blob (add; optional on update)"),
        status: tool.schema.string().optional().describe("pending | in_progress | completed | cancelled"),
        priority: tool.schema.string().optional().describe("high | medium | low"),
        session_id: tool.schema.string().optional().describe("opencode session id (optional)"),
        md_path: tool.schema.string().optional().describe("living doc path (link_md)"),
        md_content: tool.schema.string().optional().describe("living doc content (link_md)"),
        before: tool.schema.string().optional().describe("ISO ts — purge_older_than soft-deletes rows created before this"),
        since: tool.schema.string().optional().describe("ISO ts — list_since returns rows created at/after this"),
        show_deleted: tool.schema.boolean().optional().describe("include soft-deleted rows (list/get/list_since)"),
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
              return JSON.stringify(
                s.list({
                  status: args.status,
                  session_id: args.session_id,
                  show_deleted: args.show_deleted,
                }),
                null,
                2,
              )
            case "get": {
              if (args.id === undefined) throw new Error("get requires 'id'")
              const row = s.get(args.id, { include_deleted: args.show_deleted })
              if (!row) throw new Error(`no task_sidecar row with id ${args.id}`)
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
              if (!row) throw new Error(`no task_sidecar row with id ${args.id}`)
              return JSON.stringify(row, null, 2)
            }
            case "link_md": {
              if (args.id === undefined || !args.md_path || args.md_content === undefined)
                throw new Error("link_md requires 'id', 'md_path' and 'md_content'")
              const row = s.linkMd(args.id, args.md_path, args.md_content)
              if (!row) throw new Error(`no task_sidecar row with id ${args.id}`)
              return JSON.stringify(row, null, 2)
            }
            case "purge_older_than": {
              if (!args.before) throw new Error("purge_older_than requires 'before' (ISO ts)")
              const n = s.purgeOlderThan(args.before)
              return JSON.stringify({ soft_deleted: n }, null, 2)
            }
            case "list_since": {
              if (!args.since) throw new Error("list_since requires 'since' (ISO ts)")
              const rows = s.listSince(args.since, { show_deleted: args.show_deleted })
              return JSON.stringify(rows, null, 2)
            }
            default:
              throw new Error(
                `unknown action "${args.action}" (use add|list|get|update|link_md|purge_older_than|list_since)`,
              )
          }
        } catch (e) {
          return `task_sidecar error: ${(e as Error).message}`
        }
      },
    }),
  },
}))
