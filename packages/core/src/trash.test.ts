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
    expect(
      await fs.access(file).then(
        () => true,
        () => false,
      ),
    ).toBe(false)

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
    expect(
      await fs.access(file).then(
        () => true,
        () => false,
      ),
    ).toBe(false)
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

// ── a read never destroys (todo.md ruling 2) ─────────────────────────────────────────────────
// `listTrash` opened with a `purgeExpired`, so LISTING the trash deleted the user's expired
// entries — reachable from `GET /file/trash`, i.e. from opening the Trash app, and advertised in
// that endpoint's own OpenAPI description. Retention now lives only on the two writes.
//
// These are the mechanical checks for that placement: moving the sweep back onto the read, or off
// the writes entirely, compiles green and every test above still passes.
describe("trash retention placement", () => {
  const EXPIRED = new Date("2026-06-01T12:00:00Z") // well past a 2-day TTL by `LATER`
  const LATER = new Date("2026-07-02T12:00:00Z")

  /** One trashed entry dated `when`, plus the path its payload occupies under the root. */
  async function seed(root: string, name: string, when: Date) {
    const work = await tmpdir("trash-work-")
    const file = path.join(work, name)
    await fs.writeFile(file, name, "utf8")
    const entry = await trashPath(file, { root, now: () => when })
    return { entry, payload: path.join(root, entry.id, "payload") }
  }

  test("listTrash NEVER destroys: an expired entry survives being listed, repeatedly", async () => {
    const root = await tmpdir("trash-root-")
    const { entry, payload } = await seed(root, "expired.txt", EXPIRED)

    // Read it three times at a clock long past the TTL. A purge on this path would take it out.
    for (let i = 0; i < 3; i++) {
      const listed = await listTrash({ root, now: () => LATER })
      expect(listed.map((item) => item.id)).toEqual([entry.id])
    }
    // …and the bytes are genuinely still there, not merely still named in the listing.
    expect(await fs.readFile(payload, "utf8")).toBe("expired.txt")
  })

  test("the WRITE path sweeps: trashing something new reclaims the expired entry", async () => {
    const root = await tmpdir("trash-root-")
    const { entry: expired } = await seed(root, "expired.txt", EXPIRED)
    expect((await listTrash({ root })).map((item) => item.id)).toEqual([expired.id])

    const { entry: fresh } = await seed(root, "fresh.txt", LATER)
    expect((await listTrash({ root })).map((item) => item.id)).toEqual([fresh.id])
    expect(await exists(path.join(root, expired.id))).toBe(false)
  })

  test("restore sweeps AFTER itself: an expired entry is still restorable, its neighbour goes", async () => {
    const root = await tmpdir("trash-root-")
    // Both land in the same expired date-dir, which is the unit `purgeExpired` deletes — so a sweep
    // ordered BEFORE the restore would destroy the very entry being asked for (ENOENT on
    // entry.json), and one ordered after must still collect the neighbour.
    const { entry: wanted } = await seed(root, "wanted.txt", EXPIRED)
    const { entry: neighbour } = await seed(root, "neighbour.txt", EXPIRED)

    const restored = await restore(wanted.id, undefined, { root, now: () => LATER })
    expect(await fs.readFile(restored, "utf8")).toBe("wanted.txt")
    expect(await exists(path.join(root, neighbour.id))).toBe(false)
    expect(await listTrash({ root })).toEqual([])
  })

  // A sweep is housekeeping. It must never be able to fail the operation the user actually asked
  // for — that would trade a lazy purge for a new way to lose work, which is the same ruling.
  const purgeRmFn = async (target: string) => {
    throw Object.assign(new Error(`refusing to remove ${target}`), { code: "EPERM" })
  }

  test("an UNREMOVABLE expired entry cannot fail the user's trash", async () => {
    const root = await tmpdir("trash-root-")
    await seed(root, "expired.txt", EXPIRED)
    const work = await tmpdir("trash-work-")
    const file = path.join(work, "new.txt")
    await fs.writeFile(file, "new", "utf8")

    const entry = await trashPath(file, { root, now: () => LATER, purgeRmFn })
    expect(await fs.readFile(path.join(root, entry.id, "payload"), "utf8")).toBe("new")
    expect(await exists(file)).toBe(false) // the delete the user asked for actually happened
  })

  test("an UNREMOVABLE expired entry cannot fail the user's restore", async () => {
    const root = await tmpdir("trash-root-")
    const { entry } = await seed(root, "wanted.txt", EXPIRED)

    const restored = await restore(entry.id, undefined, { root, now: () => LATER, purgeRmFn })
    expect(await fs.readFile(restored, "utf8")).toBe("wanted.txt")
  })

  test("…but the explicit maintenance call still REPORTS a sweep failure", async () => {
    // `purgeExpired` is the entry point a caller uses to expire on purpose, so it must not swallow.
    // Best-effort is a property of riding a mutation, not of the sweep itself.
    const root = await tmpdir("trash-root-")
    await seed(root, "expired.txt", EXPIRED)
    await expect(purgeExpired(DEFAULT_TTL_MS, { root, now: () => LATER, purgeRmFn })).rejects.toThrow(
      "refusing to remove",
    )
  })

  test("SOURCE RATCHET: the sweep appears in both writes and in neither read", async () => {
    // The behavioural tests above bite when the sweep moves, but only for the reads that exist
    // today. This pins the placement itself, so a NEW read that purges is caught as well.
    const source = await fs.readFile(path.join(import.meta.dir, "trash.ts"), "utf8")
    const bodyOf = (signature: string) => {
      const from = source.indexOf(signature)
      expect(from).toBeGreaterThan(0)
      const to = source.indexOf("\n}\n", from)
      expect(to).toBeGreaterThan(from)
      return source.slice(from, to)
    }
    // The two mutations sweep…
    expect(bodyOf("export async function trashPath(")).toContain("sweepRetention(")
    expect(bodyOf("export async function restore(")).toContain("sweepRetention(")
    // …and the read does not, by either name.
    const list = bodyOf("export async function listTrash(")
    expect(list).not.toContain("sweepRetention(")
    expect(list).not.toContain("purgeExpired(")
    expect(list).not.toContain("fs.rm(")
  })
})

async function exists(p: string) {
  return fs.access(p).then(
    () => true,
    () => false,
  )
}
