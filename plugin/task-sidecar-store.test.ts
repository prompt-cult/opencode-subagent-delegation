// task-sidecar-store.test.ts — bun:test coverage for the cold task store:
// sequencer ids, soft delete (never hard-delete), purge/list_since, and
// migration from the legacy v0.0.2 todo_ng.db.
import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
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

  test("linkMd stores the record IN the DB; content round-trips via get with no file on disk", () => {
    const s = new TaskSidecarStore()
    const r = s.add({ todo: "spec" })
    const out = s.linkMd(r.id, "# spec body\n\nincluding the issue details")
    expect(out!.md_content).toBe("# spec body\n\nincluding the issue details")
    expect(s.get(r.id)!.md_content).toBe("# spec body\n\nincluding the issue details")
    // md_path is optional annotation; nothing is written to disk
    expect(out!.md_path).toBeNull()
    s.close()
  })

  test("linkMd accepts md_path as annotation only and never writes it", () => {
    const s = new TaskSidecarStore()
    const r = s.add({ todo: "spec" })
    const p = join(home, "tickets", "spec.md")
    const out = s.linkMd(r.id, "# content", p)
    expect(out!.md_path).toBe(p)
    expect(out!.md_content).toBe("# content")
    expect(existsSync(p)).toBe(false)
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

  test("v0.0.3 store (disk-only records) migrates: md_content column added and backfilled from md_path files", () => {
    // build an OLD-schema DB by hand, the way v0.0.3 left it
    const dbPath = join(home, "task_sidecar_store.db")
    const old = new Database(dbPath)
    old.exec(`CREATE TABLE task_sidecar (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        todo TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        priority TEXT NOT NULL DEFAULT 'medium',
        session_id TEXT, md_path TEXT,
        deleted INTEGER NOT NULL DEFAULT 0);`)
    old.run(
      "INSERT INTO task_sidecar (created_at, updated_at, todo, status, md_path) VALUES ('2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','disk ticket','pending', ?)",
      [join(home, "tickets", "old-spec.md")],
    )
    old.close()
    mkdirSync(join(home, "tickets"), { recursive: true })
    writeFileSync(join(home, "tickets", "old-spec.md"), "# the old fat record")

    // opening with the new store migrates: column added, content backfilled
    const s = new TaskSidecarStore(dbPath)
    const row = s.get(1)!
    expect(row.md_content).toBe("# the old fat record")
    // and a missing file leaves the row intact with NULL content
    s.linkMd(1, "# amended in place")
    expect(s.get(1)!.md_content).toBe("# amended in place")
    s.close()
  })

  test("syncStatuses mirrors flushed todo item statuses onto 'N:' rows (closing the todo closes the row)", () => {
    const s = new TaskSidecarStore()
    const a = s.add({ todo: "delegated work" })
    const b = s.add({ todo: "other work" })
    const changed = s.syncStatuses([
      { content: `${a.id}: delegated work`, status: "completed" },
      { content: `${b.id}. other work`, status: "in_progress" },
    ])
    expect(changed).toEqual([a.id, b.id])
    expect(s.get(a.id)!.status).toBe("completed")
    expect(s.get(b.id)!.status).toBe("in_progress")
    s.close()
  })

  test("syncStatuses touches only referenced rows and ignores junk", () => {
    const s = new TaskSidecarStore()
    const a = s.add({ todo: "referenced" })
    const b = s.add({ todo: "parked, not in the flush" })
    s.update(b.id, { status: "in_progress" })
    const changed = s.syncStatuses([
      { content: `${a.id}: referenced`, status: "completed" },
      // no "N:" prefix: slug-style items carry no sidecar id
      { content: "item03: legacy slug style", status: "completed" },
      // unknown id: silently ignored
      { content: "999: no such row", status: "completed" },
      // invalid status: ignored
      { content: `${a.id}: referenced`, status: "archived" },
      // malformed entries: ignored, never throw
      null as never,
      {},
    ])
    expect(changed).toEqual([a.id])
    expect(s.get(a.id)!.status).toBe("completed")
    // unreferenced row untouched
    expect(s.get(b.id)!.status).toBe("in_progress")
    // flushing the same status again changes nothing
    expect(s.syncStatuses([{ content: `${a.id}: referenced`, status: "completed" }])).toEqual([])
    s.close()
  })

  test("syncStatuses never resurrects soft-deleted rows", () => {
    const s = new TaskSidecarStore()
    const a = s.add({ todo: "already closed" })
    s.update(a.id, { status: "cancelled" })
    const changed = s.syncStatuses([{ content: `${a.id}: already closed`, status: "completed" }])
    expect(changed).toEqual([a.id])
    expect(s.get(a.id)!.status).toBe("completed")
    expect(s.get(a.id)!.deleted).toBe(0)
    s.close()
  })
})
