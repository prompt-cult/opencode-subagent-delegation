// task-sidecar-store — durable task detail store backed by a SQLite sidecar.
// THIS IS NOT A TODO LIST. The built-in todowrite list is the hot, ordered
// todo list. This store is COLD storage: the fat record (living md docs) for
// each task, plus the GLOBAL SEQUENCER (its autoincrement id is the only
// global task number). Access pattern: insert one row, read one row, lazy
// soft delete — rows are never hard-deleted. Framework-free (bun:sqlite +
// node:fs) so it can be unit-tested with bun:test without loading opencode.
// The plugin wrapper in task-sidecar.ts is the only consumer.
//
// v0.0.4: the fat record's CONTENT lives IN the DB (md_content column).
// md_path is a legacy/annotation field only — the DB is the authoritative
// record and no handoff may pass a disk path as the transport.
import { Database } from "bun:sqlite"
import { mkdirSync, readFileSync, existsSync } from "node:fs"
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
  md_content: string | null
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
        md_content TEXT,
        deleted INTEGER NOT NULL DEFAULT 0
      );
    `)
    // v0.0.3 → v0.0.4 migration: add the md_content column to an existing
    // store, backfilling from md_path files so the DB becomes authoritative.
    const cols = (this.db.query(`PRAGMA table_info(task_sidecar)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    )
    if (!cols.includes("md_content")) {
      this.db.exec("ALTER TABLE task_sidecar ADD COLUMN md_content TEXT")
      const legacy = this.db
        .query("SELECT id, md_path FROM task_sidecar WHERE md_content IS NULL AND md_path IS NOT NULL")
        .all() as Array<{ id: number; md_path: string }>
      for (const row of legacy) {
        try {
          const content = readFileSync(row.md_path, "utf8")
          this.db.run("UPDATE task_sidecar SET md_content = ? WHERE id = ?", [content, row.id])
        } catch {
          // file gone: leave md_content NULL; the row keeps md_path as the hint
        }
      }
    }
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

  // linkMd stores the item's living document IN the DB (md_content) — the
  // record is the store, not a disk file. md_path may be supplied as an
  // optional annotation (e.g. a mirror path the user asked for); it is never
  // the transport: handoffs pass the row id and read md_content via get.
  linkMd(id: number, content: string, mdPath?: string): TaskSidecarRow | undefined {
    const current = this.get(id)
    if (!current) return undefined
    this.db.run("UPDATE task_sidecar SET md_content = ?, md_path = ?, updated_at = ? WHERE id = ?", [
      content,
      mdPath ?? current.md_path,
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

  // syncStatuses MIRRORS the built-in todo list onto the sidecar rows:
  // every todo item whose content starts with "N:" (or "N.") carries the
  // global sidecar id N, and the item's status is written to row N. Called
  // mechanically on every todowrite flush (see task-sidecar.ts), so closing
  // a todo item IS closing its row — the model cannot forget. Rows not
  // referenced by the flush (parked, other sessions) are never touched.
  // Returns the ids whose status changed.
  syncStatuses(items: Array<{ content?: unknown; status?: unknown }>): number[] {
    const changed: number[] = []
    for (const item of items) {
      if (typeof item?.content !== "string" || typeof item?.status !== "string") continue
      if (!STATUSES.has(item.status)) continue
      const m = item.content.match(/^\s*(\d+)\s*[.:)\]-]/)
      if (!m) continue
      const row = this.get(Number(m[1]))
      if (!row || row.status === item.status) continue
      this.update(row.id, { status: item.status })
      changed.push(row.id)
    }
    return changed
  }

  close() {
    this.db.close()
  }
}
