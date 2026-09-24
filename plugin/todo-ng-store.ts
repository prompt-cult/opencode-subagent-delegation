// todo-ng-store — durable cross-session todo store backed by a SQLite sidecar
// DB. Deliberately framework-free (only bun:sqlite + node:fs) so it can be
// unit-tested with bun:test without loading opencode. The plugin wrapper in
// todo-ng.ts is the only consumer.
import { Database } from "bun:sqlite"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"

export interface TodoNgRow {
  id: number
  created_at: string
  updated_at: string
  todo: string
  status: string
  priority: string
  session_id: string | null
  md_path: string | null
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

const STATUSES = new Set(["pending", "in_progress", "completed", "cancelled"])
const PRIORITIES = new Set(["high", "medium", "low"])

export function todoNgDbPath(): string {
  const root = process.env.VPS_GRAPEVINE_HOME || join(homedir(), ".vps-grapevine")
  return join(root, "todo_ng.db")
}

export class TodoNgStore {
  private db: Database

  constructor(dbPath: string = todoNgDbPath()) {
    mkdirSync(dirname(dbPath), { recursive: true })
    this.db = new Database(dbPath)
    this.db.exec("PRAGMA journal_mode = WAL;")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS todo_ng (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        todo TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        priority TEXT NOT NULL DEFAULT 'medium',
        session_id TEXT,
        md_path TEXT
      );
    `)
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

  add(input: AddInput): TodoNgRow {
    this.assertStatus(input.status)
    this.assertPriority(input.priority)
    const ts = this.now()
    this.db.run(
      `INSERT INTO todo_ng (created_at, updated_at, todo, status, priority, session_id, md_path)
       VALUES (?, ?, ?, ?, ?, ?, NULL)`,
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

  get(id: number): TodoNgRow | undefined {
    return (this.db.query("SELECT * FROM todo_ng WHERE id = ?").get(id) as TodoNgRow | null) ?? undefined
  }

  list(filter: { session_id?: string; status?: string } = {}): TodoNgRow[] {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.session_id !== undefined) {
      where.push("session_id = ?")
      params.push(filter.session_id)
    }
    if (filter.status !== undefined) {
      where.push("status = ?")
      params.push(filter.status)
    }
    const sql = `SELECT * FROM todo_ng ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id`
    return this.db.query(sql).all(...params) as TodoNgRow[]
  }

  update(id: number, input: UpdateInput): TodoNgRow | undefined {
    this.assertStatus(input.status)
    this.assertPriority(input.priority)
    const current = this.get(id)
    if (!current) return undefined
    this.db.run(
      `UPDATE todo_ng
         SET todo = ?, status = ?, priority = ?, session_id = ?, updated_at = ?
       WHERE id = ?`,
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
  linkMd(id: number, mdPath: string, content: string): TodoNgRow | undefined {
    mkdirSync(dirname(mdPath), { recursive: true })
    writeFileSync(mdPath, content)
    const updated = this.update(id, {})
    this.db.run("UPDATE todo_ng SET md_path = ?, updated_at = ? WHERE id = ?", [
      mdPath,
      this.now(),
      id,
    ])
    return this.get(id)
  }

  remove(id: number): boolean {
    return this.db.run("DELETE FROM todo_ng WHERE id = ?", [id]).changes > 0
  }

  close() {
    this.db.close()
  }
}
