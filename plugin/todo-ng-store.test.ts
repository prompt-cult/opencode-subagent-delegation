import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { TodoNgStore } from "./todo-ng-store"

describe("TodoNgStore", () => {
  let dir: string
  let store: TodoNgStore

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "todo-ng-test-"))
    store = new TodoNgStore(join(dir, "todo_ng.db"))
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  test("add returns a global autoincrement id that never repeats across deletions", () => {
    const a = store.add({ todo: "item00: first", session_id: "s1" })
    const b = store.add({ todo: "item01: second", session_id: "s1" })
    expect(a.id).toBe(1)
    expect(b.id).toBe(2)
    store.remove(a.id)
    const c = store.add({ todo: "item02: third", session_id: "s1" })
    expect(c.id).toBe(3)
  })

  test("add stamps created_at/updated_at ISO timestamps and defaults", () => {
    const row = store.add({ todo: "item00: x" })
    expect(row.status).toBe("pending")
    expect(row.priority).toBe("medium")
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(row.updated_at).toBe(row.created_at)
    expect(row.md_path).toBeNull()
  })

  test("update changes fields, bumps updated_at, leaves created_at", async () => {
    const row = store.add({ todo: "item00: x" })
    await new Promise((r) => setTimeout(r, 10))
    const upd = store.update(row.id, { status: "in_progress", priority: "high" })
    expect(upd?.status).toBe("in_progress")
    expect(upd?.priority).toBe("high")
    expect(upd?.created_at).toBe(row.created_at)
    expect(upd!.updated_at >= row.created_at).toBe(true)
  })

  test("update to cancelled keeps the record (cancelled keeps the record)", () => {
    const row = store.add({ todo: "item00: x" })
    store.update(row.id, { status: "cancelled" })
    expect(store.get(row.id)?.status).toBe("cancelled")
    expect(store.list().length).toBe(1)
  })

  test("list returns newest-last in id order across sessions", () => {
    store.add({ todo: "a", session_id: "s1" })
    store.add({ todo: "b", session_id: "s2" })
    const all = store.list()
    expect(all.map((r) => r.todo)).toEqual(["a", "b"])
  })

  test("linkMd writes the living doc file and stores its path", () => {
    const row = store.add({ todo: "item00: x" })
    const md = join(dir, "item00.md")
    const upd = store.linkMd(row.id, md, "# item00\nfull spec")
    expect(upd?.md_path).toBe(md)
    expect(readFileSync(md, "utf8")).toContain("full spec")
  })

  test("get returns undefined for missing id", () => {
    expect(store.get(999)).toBeUndefined()
  })

  test("remove deletes a row", () => {
    const row = store.add({ todo: "x" })
    expect(store.remove(row.id)).toBe(true)
    expect(store.get(row.id)).toBeUndefined()
  })
})
