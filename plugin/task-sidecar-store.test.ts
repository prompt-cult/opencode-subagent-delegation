// task-sidecar-store.test.ts — bun:test coverage for the cold task store:
// sequencer ids, soft delete (never hard-delete), purge/list_since, and
// migration from the legacy v0.0.2 todo_ng.db.
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { Database } from "bun:sqlite"
import { TaskSidecarStore, taskSidecarDbPath, legacyTodoNgDbPath } from "./task-sidecar-store"

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "task-sidecar-test-"))
  process.env.VPS_GRAPEVINE_HOME = home
})

afterEach(() => {
  delete process.env.VPS_GRAPEVINE_HOME
  rmSync(home, { recursive: true, force: true })
})

describe("TaskSidecarStore", () => {
  test("add returns globally-unique autoincrement ids (the sequencer)", () => {
    const s = new TaskSidecarStore()
    const a = s.add({ todo: "first" })
    const b = s.add({ todo: "second" })
    expect(a.id).toBe(1)
    expect(b.id).toBe(2)
    expect(a.status).toBe("pending")
    expect(a.deleted).toBe(0)
    s.close()
  })

  test("ids continue across store instances (survives restart)", () => {
    const s1 = new TaskSidecarStore()
    s1.add({ todo: "one" })
    s1.close()
    const s2 = new TaskSidecarStore()
    const b = s2.add({ todo: "two" })
    expect(b.id).toBe(2)
    s2.close()
  })

  test("db path is task_sidecar_store.db, NOT todo_ng.db", () => {
    expect(taskSidecarDbPath()).toBe(join(home, "task_sidecar_store.db"))
    expect(legacyTodoNgDbPath()).toBe(join(home, "todo_ng.db"))
  })

  test("get/list skip nothing initially, ascending by id", () => {
    const s = new TaskSidecarStore()
    s.add({ todo: "a" })
    s.add({ todo: "b" })
    const rows = s.list()
    expect(rows.map((r) => r.todo)).toEqual(["a", "b"])
    s.close()
  })

  test("update patches status and keeps the record (cancelled keeps too)", () => {
    const s = new TaskSidecarStore()
    const r = s.add({ todo: "work" })
    s.update(r.id, { status: "cancelled" })
    expect(s.get(r.id)!.status).toBe("cancelled")
    expect(s.get(r.id)!.todo).toBe("work")
    s.close()
  })

  test("linkMd writes the living doc and records md_path", () => {
    const s = new TaskSidecarStore()
    const r = s.add({ todo: "spec" })
    const p = join(home, "tickets", "spec.md")
    const out = s.linkMd(r.id, p, "# spec")
    expect(out!.md_path).toBe(p)
    expect(s.get(r.id)!.md_path).toBe(p)
    s.close()
  })

  test("invalid status/priority rejected", () => {
    const s = new TaskSidecarStore()
    expect(() => s.add({ todo: "x", status: "done" })).toThrow(/status must be one of/)
    expect(() => s.add({ todo: "x", priority: "urgent" })).toThrow(/priority must be one of/)
    s.close()
  })

  test("purgeOlderThan LAZY soft deletes only older rows; nothing hard-deleted", () => {
    const s = new TaskSidecarStore()
    const old = s.add({ todo: "old" })
    const fresh = s.add({ todo: "fresh" })
    // rewind the old row's created_at
    s.db.run("UPDATE task_sidecar SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", [old.id])
    const n = s.purgeOlderThan("2026-01-01T00:00:00.000Z")
    expect(n).toBe(1)
    expect(s.get(old.id)).toBeUndefined()
    expect(s.get(fresh.id)).toBeDefined()
    // still in the store as a soft-deleted record
    expect(s.get(old.id, { include_deleted: true })!.deleted).toBe(1)
    s.close()
  })

  test("listSince respects soft delete; show_deleted includes them", () => {
    const s = new TaskSidecarStore()
    const a = s.add({ todo: "a" })
    const b = s.add({ todo: "b" })
    s.db.run("UPDATE task_sidecar SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", [a.id])
    s.purgeOlderThan("2026-01-01T00:00:00.000Z")
    const since = s.listSince("2019-01-01T00:00:00.000Z")
    expect(since.map((r) => r.id)).toEqual([b.id])
    const all = s.listSince("2019-01-01T00:00:00.000Z", { show_deleted: true })
    expect(all.map((r) => r.id)).toEqual([a.id, b.id])
    s.close()
  })

  test("update cannot resurrect a soft-deleted row", () => {
    const s = new TaskSidecarStore()
    const r = s.add({ todo: "x" })
    s.db.run("UPDATE task_sidecar SET created_at = '2020-01-01T00:00:00.000Z' WHERE id = ?", [r.id])
    s.purgeOlderThan("2026-01-01T00:00:00.000Z")
    expect(s.update(r.id, { status: "completed" })).toBeUndefined()
    s.close()
  })

  test("migrates legacy todo_ng.db rows into a fresh store (legacy file untouched)", () => {
    const legacyPath = legacyTodoNgDbPath()
    const legacy = new Database(legacyPath)
    legacy.exec(`CREATE TABLE IF NOT EXISTS todo_ng (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      todo TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      priority TEXT NOT NULL DEFAULT 'medium',
      session_id TEXT, md_path TEXT);`)
    legacy.run("INSERT INTO todo_ng (created_at, updated_at, todo, status) VALUES ('2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','legacy task','pending')")
    legacy.close()
    const s = new TaskSidecarStore()
    const migrated = s.get(1)
    expect(migrated!.todo).toBe("legacy task")
    expect(migrated!.deleted).toBe(0)
    // sequencer continues after migrated max id
    expect(s.add({ todo: "next" }).id).toBe(2)
    // legacy file still on disk
    expect(new Database(legacyPath).query("SELECT COUNT(*) AS n FROM todo_ng").get()).toEqual({ n: 1 })
    s.close()
  })
})
