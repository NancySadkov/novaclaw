import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Host } from "./host.node"

/**
 * The Node twin, against a REAL filesystem.
 *
 * ⚠️ This file exists because the defect it guards was invisible to every other test: the desktop
 * sidecar is an Electron `utilityProcess` (Node), `bun:ffi` does not exist there, and the whole suite
 * runs under Bun. A green run said nothing at all about the runtime we actually ship the app on.
 */

const roots: string[] = []
const tmp = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "novaclaw-host-node-"))
  roots.push(root)
  return root
}
afterAll(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

/** Poll until `predicate` holds or the budget runs out. Returns everything drained. */
const drainUntil = async (watch: ReturnType<typeof Host.watch>, predicate: (events: Host.WatchEvent[]) => boolean) => {
  const seen: Host.WatchEvent[] = []
  for (let attempt = 0; attempt < 100; attempt++) {
    seen.push(...watch.poll())
    if (predicate(seen)) return seen
    await Bun.sleep(20)
  }
  return seen
}

describe("Host (node twin)", () => {
  test("is available — Node HAS a file watcher, unlike the fff twin", () => {
    // Returning false here would turn a working capability into a dead one for the app we ship.
    expect(Host.available()).toBe(true)
  })

  test("reports a created file, with a NATIVE absolute path", async () => {
    const root = tmp()
    const watch = Host.watch(root)
    try {
      const file = path.join(root, "made.txt")
      fs.writeFileSync(file, "a")
      const seen = await drainUntil(watch, (events) => events.some((event) => event.path === file))
      // Compared against `path.join` deliberately: a forward-slashed twin would match nothing here,
      // which is exactly the defect that made the Bun path look like a watcher that was not firing.
      expect(seen.map((event) => event.path)).toContain(file)
    } finally {
      watch.close()
    }
  })

  test("classifies a removal as delete, not as a bare rename", async () => {
    const root = tmp()
    const file = path.join(root, "gone.txt")
    fs.writeFileSync(file, "a")
    const watch = Host.watch(root)
    try {
      fs.rmSync(file)
      const seen = await drainUntil(watch, (events) =>
        events.some((event) => event.path === file && event.type === "delete"),
      )
      expect(seen.some((event) => event.path === file && event.type === "delete")).toBe(true)
    } finally {
      watch.close()
    }
  })

  test("🔴 an ignored directory NAME is dropped before the caller sees it", async () => {
    const root = tmp()
    fs.mkdirSync(path.join(root, "node_modules"))
    const watch = Host.watch(root, { ignoreDirectories: ["node_modules"] })
    try {
      fs.writeFileSync(path.join(root, "node_modules", "noise.txt"), "a")
      const kept = path.join(root, "kept.txt")
      fs.writeFileSync(kept, "a")
      // Waits for the file that MUST arrive, then asserts the other did not — rather than sleeping
      // and hoping. A bare sleep would pass just as well against a watcher that reported nothing.
      const seen = await drainUntil(watch, (events) => events.some((event) => event.path === kept))
      expect(seen.some((event) => event.path === kept)).toBe(true)
      expect(seen.some((event) => event.path.includes("node_modules"))).toBe(false)
    } finally {
      watch.close()
    }
  })

  test("close is idempotent and a poll after it is empty, never a throw", async () => {
    const root = tmp()
    const watch = Host.watch(root)
    fs.writeFileSync(path.join(root, "a.txt"), "a")
    watch.close()
    watch.close()
    expect(watch.poll()).toEqual([])
  })

  test("an ignore name matching the ROOT's own ancestry does not silence the tree", async () => {
    // Watching `…/build/project` must not discard everything because an ancestor is called `build`.
    const parent = tmp()
    const root = path.join(parent, "build", "project")
    fs.mkdirSync(root, { recursive: true })
    const watch = Host.watch(root, { ignoreDirectories: ["build"] })
    try {
      const file = path.join(root, "kept.txt")
      fs.writeFileSync(file, "a")
      const seen = await drainUntil(watch, (events) => events.some((event) => event.path === file))
      expect(seen.map((event) => event.path)).toContain(file)
    } finally {
      watch.close()
    }
  })
})
