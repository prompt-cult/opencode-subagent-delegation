// task-sidecar-store — durable task detail store backed by a SQLite sidecar.
// THIS IS NOT A TODO LIST. The built-in todowrite list is the hot, ordered
// todo list. This store is COLD storage: the fat record (living md docs) for
// each task, plus the GLOBAL SEQUENCER (its autoincrement id is the only
// global task number). Access pattern: insert one row, read one row, lazy
// soft delete — rows are never hard-deleted. Framework-free (bun:sqlite +
// node:fs) so it can be unit-tested with bun:test without loading opencode.
// The plugin wrapper in task-sidecar.ts is the only consumer.
import { Database } from "bun:sqlite"
import { mkdirSync, writeFileSync, existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"

export interface TaskSidecarRow {
  id: number
  created_at: string
  updated_at: string
  todo: string
  status: string
  priority: string
  session_id: string | null
  md_path: string | null
  deleted: number
}

export interface AddInput {
  todo: string
  status?: string
  priority?: string
  session_id?: string | null
}

export interface UpdateInput {
  todo?: string
  status?: string
  priority?: string
  session_id?: string | null
}

export interface ListFilter {
  session_id?: string
  status?: string
  show_deleted?: boolean
}

const STATUSES = new Set(["pending", "in_progress", "completed", "cancelled"])
const PRIORITIES = new Set(["high", "medium", "low"])

export function taskSidecarDbPath(): string {
  const root = process.env.VPS_GRAPEVINE_HOME || join(homedir(), ".vps-grapevine")
  return join(root, "task_sidecar_store.db")
}

export function legacyTodoNgDbPath(): string {
  const root = process.env.VPS_GRAPEVINE_HOME || join(homedir(), ".vps-grapevine")
  return join(root, "todo_ng.db")
}

export class TaskSidecarStore {
  private db: Database

  constructor(dbPath: string = taskSidecarDbPath()) {
    mkdirSync(dirname(dbPath), { recursive: true })
    const isFresh = !existsSync(dbPath)
    this.db = new Database(dbPath)
    this.db.exec("PRAGMA journal_mode = WAL;")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_sidecar (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        todo TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        priority TEXT NOT NULL DEFAULT 'medium',
        session_id TEXT,
        md_path TEXT,
        deleted INTEGER NOT NULL DEFAULT 0
      );
    `)
    if (isFresh) this.migrateLegacy()
  }

  // migrateLegacy ports rows from the old todo_ng.db (v0.0.2) if it exists
  // and this fresh store is empty. The legacy file is left untouched.
  private migrateLegacy() {
    const legacyPath = legacyTodoNgDbPath()
    if (!existsSync(legacyPath)) return
    const legacy = new Database(legacyPath, { readonly: true })
    try {
      const table = legacy
        .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'todo_ng'")
        .get() as { name: string } | null
      if (!table) return
      const count = (this.db.query("SELECT COUNT(*) AS n FROM task_sidecar").get() as { n: number }).n
      if (count > 0) return
      const rows = legacy.query("SELECT * FROM todo_ng ORDER BY id").all() as Array<Record<string, unknown>>
      for (const r of rows) {
        this.db.run(
          `INSERT INTO task_sidecar (id, created_at, updated_at, todo, status, priority, session_id, md_path, deleted)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
          [r.id, r.created_at, r.updated_at, r.todo, r.status, r.priority, r.session_id ?? null, r.md_path ?? null],
        )
      }
    } finally {
      legacy.close()
    }
  }

  private now(): string {
    return new Date().toISOString()
  }

  private assertStatus(status?: string) {
    if (status !== undefined && !STATUSES.has(status))
      throw new Error(`status must be one of ${[...STATUSES].join("|")}, got "${status}"`)
  }

  private assertPriority(priority?: string) {
    if (priority !== undefined && !PRIORITIES.has(priority))
      throw new Error(`priority must be one of ${[...PRIORITIES].join("|")}, got "${priority}"`)
  }

  // add is the GLOBAL SEQUENCER: it returns the permanent, globally unique
  // task id. Use that id as the item number in the built-in todo list.
  add(input: AddInput): TaskSidecarRow {
    this.assertStatus(input.status)
    this.assertPriority(input.priority)
    const ts = this.now()
    this.db.run(
      `INSERT INTO task_sidecar (created_at, updated_at, todo, status, priority, session_id, md_path, deleted)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 0)`,
      [
        ts,
        ts,
        input.todo,
        input.status ?? "pending",
        input.priority ?? "medium",
        input.session_id ?? null,
      ],
    )
    return this.get(Number(this.db.query("SELECT last_insert_rowid() AS id").get()!.id))!
  }

  get(id: number, opts: { include_deleted?: boolean } = {}): TaskSidecarRow | undefined {
    const sql = `SELECT * FROM task_sidecar WHERE id = ? ${opts.include_deleted ? "" : "AND deleted = 0"}`
    return (this.db.query(sql).get(id) as TaskSidecarRow | null) ?? undefined
  }

  list(filter: ListFilter = {}): TaskSidecarRow[] {
    const where: string[] = []
    const params: unknown[] = []
    if (!filter.show_deleted) where.push("deleted = 0")
    if (filter.session_id !== undefined) {
      where.push("session_id = ?")
      params.push(filter.session_id)
    }
    if (filter.status !== undefined) {
      where.push("status = ?")
      params.push(filter.status)
    }
    const sql = `SELECT * FROM task_sidecar ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id`
    return this.db.query(sql).all(...params) as TaskSidecarRow[]
  }

  // listSince returns rows created at or after the ISO ts, ascending by id,
  // respecting soft delete unless show_deleted is set.
  listSince(since: string, filter: { show_deleted?: boolean } = {}): TaskSidecarRow[] {
    const where = ["created_at >= ?"]
    const params: unknown[] = [since]
    if (!filter.show_deleted) where.push("deleted = 0")
    const sql = `SELECT * FROM task_sidecar WHERE ${where.join(" AND ")} ORDER BY id`
    return this.db.query(sql).all(...params) as TaskSidecarRow[]
  }

  update(id: number, input: UpdateInput): TaskSidecarRow | undefined {
    this.assertStatus(input.status)
    this.assertPriority(input.priority)
    const current = this.get(id)
    if (!current) return undefined
    this.db.run(
      `UPDATE task_sidecar
          SET todo = ?, status = ?, priority = ?, session_id = ?, updated_at = ?
        WHERE id = ? AND deleted = 0`,
      [
        input.todo ?? current.todo,
        input.status ?? current.status,
        input.priority ?? current.priority,
        input.session_id !== undefined ? input.session_id : current.session_id,
        this.now(),
        id,
      ],
    )
    return this.get(id)
  }

  // linkMd writes the item's living document to mdPath and records the path.
  // The file content is passed in so the store stays the single writer.
  linkMd(id: number, mdPath: string, content: string): TaskSidecarRow | undefined {
    mkdirSync(dirname(mdPath), { recursive: true })
    writeFileSync(mdPath, content)
    const updated = this.update(id, {})
    this.db.run("UPDATE task_sidecar SET md_path = ?, updated_at = ? WHERE id = ?", [
      mdPath,
      this.now(),
      id,
    ])
    return this.get(id)
  }

  // purgeOlderThan LAZY SOFT DELETES every row created before the ISO ts
  // (one-row-at-a-time semantics, batched). Nothing is hard-deleted, ever.
  // Returns the number of rows soft-deleted.
  purgeOlderThan(before: string): number {
    return this.db
      .run("UPDATE task_sidecar SET deleted = 1, updated_at = ? WHERE created_at < ? AND deleted = 0", [
        this.now(),
        before,
      ])
      .changes
  }

  close() {
    this.db.close()
  }
}
