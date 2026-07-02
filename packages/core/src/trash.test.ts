import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { DEFAULT_TTL_MS, isValidId, listTrash, purgeExpired, restore, trashPath } from "./trash"

// Every test gets its own temp trash root + temp workspace — no shared state, no Global.Path writes.
const cleanups: string[] = []
async function tmpdir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  cleanups.push(dir)
  return dir
}
afterEach(async () => {
  while (cleanups.length) await fs.rm(cleanups.pop()!, { recursive: true, force: true })
})

describe("trash store", () => {
  test("trash → list → restore round-trip for a file", async () => {
    const root = await tmpdir("trash-root-")
    const work = await tmpdir("trash-work-")
    const file = path.join(work, "doc.txt")
    await fs.writeFile(file, "hello", "utf8")

    const entry = await trashPath(file, { root })
    expect(entry.type).toBe("file")
    expect(entry.originalPath).toBe(path.resolve(file))
    expect(isValidId(entry.id)).toBe(true)
    expect(await fs.access(file).then(() => true, () => false)).toBe(false)

    const listed = await listTrash({ root })
    expect(listed.map((item) => item.id)).toEqual([entry.id])

    const restored = await restore(entry.id, undefined, { root })
    expect(restored).toBe(path.resolve(file))
    expect(await fs.readFile(file, "utf8")).toBe("hello")
    expect(await listTrash({ root })).toEqual([])
  })

  test("round-trips a directory with nested content", async () => {
    const root = await tmpdir("trash-root-")
    const work = await tmpdir("trash-work-")
    const dir = path.join(work, "proj")
    await fs.mkdir(path.join(dir, "sub"), { recursive: true })
    await fs.writeFile(path.join(dir, "sub", "a.txt"), "nested", "utf8")

    const entry = await trashPath(dir, { root })
    expect(entry.type).toBe("directory")
    const restored = await restore(entry.id, undefined, { root })
    expect(await fs.readFile(path.join(restored, "sub", "a.txt"), "utf8")).toBe("nested")
  })

  test("EXDEV rename falls back to copy + delete", async () => {
    const root = await tmpdir("trash-root-")
    const work = await tmpdir("trash-work-")
    const file = path.join(work, "cross-device.txt")
    await fs.writeFile(file, "moved across devices", "utf8")

    const renameFn = async () => {
      throw Object.assign(new Error("cross-device link"), { code: "EXDEV" })
    }
    const entry = await trashPath(file, { root, renameFn })
    expect(await fs.access(file).then(() => true, () => false)).toBe(false)
    const payload = path.join(root, entry.id, "payload")
    expect(await fs.readFile(payload, "utf8")).toBe("moved across devices")
  })

  test("restore collision lands beside the original, not over it", async () => {
    const root = await tmpdir("trash-root-")
    const work = await tmpdir("trash-work-")
    const file = path.join(work, "busy.txt")
    await fs.writeFile(file, "v1", "utf8")
    const entry = await trashPath(file, { root })
    await fs.writeFile(file, "v2", "utf8") // the original path is occupied again

    const restored = await restore(entry.id, undefined, { root })
    expect(restored).not.toBe(path.resolve(file))
    expect(restored.startsWith(`${path.resolve(file)}.restored-`)).toBe(true)
    expect(await fs.readFile(file, "utf8")).toBe("v2")
    expect(await fs.readFile(restored, "utf8")).toBe("v1")
  })

  test("TTL purge removes strictly-older date dirs and keeps fresh ones", async () => {
    const root = await tmpdir("trash-root-")
    const work = await tmpdir("trash-work-")

    const old = new Date("2026-06-01T12:00:00Z")
    const fresh = new Date("2026-07-02T12:00:00Z")
    const fileOld = path.join(work, "old.txt")
    const fileFresh = path.join(work, "fresh.txt")
    await fs.writeFile(fileOld, "old", "utf8")
    await fs.writeFile(fileFresh, "fresh", "utf8")

    await trashPath(fileOld, { root, now: () => old })
    const freshEntry = await trashPath(fileFresh, { root, now: () => fresh })

    await purgeExpired(DEFAULT_TTL_MS, { root, now: () => fresh })
    const remaining = await listTrash({ root, now: () => fresh })
    expect(remaining.map((item) => item.id)).toEqual([freshEntry.id])
  })

  test("same-ms same-name trashes don't collide", async () => {
    const root = await tmpdir("trash-root-")
    const workA = await tmpdir("trash-work-a-")
    const workB = await tmpdir("trash-work-b-")
    const now = () => new Date("2026-07-02T12:00:00.000Z")
    await fs.writeFile(path.join(workA, "same.txt"), "a", "utf8")
    await fs.writeFile(path.join(workB, "same.txt"), "b", "utf8")

    const first = await trashPath(path.join(workA, "same.txt"), { root, now })
    const second = await trashPath(path.join(workB, "same.txt"), { root, now })
    expect(first.id).not.toBe(second.id)
    expect((await listTrash({ root, now })).length).toBe(2)
  })

  test("restore rejects traversal-shaped ids", async () => {
    const root = await tmpdir("trash-root-")
    expect(isValidId("../../etc/passwd")).toBe(false)
    expect(isValidId("2026-07-02/123-..")).toBe(false)
    expect(isValidId("2026-07-02/123-ok.txt")).toBe(true)
    await expect(restore("../escape", undefined, { root })).rejects.toThrow("Invalid trash id")
  })
})
