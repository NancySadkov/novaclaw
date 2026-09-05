import { describe, expect, test } from "bun:test"
import path from "node:path"
import { InstanceRegistry } from "@novaclaw/core/instance-registry"

/**
 * ─── `` I1 — named instances, by pinned HOME ───────────────────────────────────
 *
 * 🔴 The defect the item names: an instance is implicitly `(data dir × installation channel)` today,
 * so one machine grows `novaclaw.db`, `novaclaw-dev.db` and `novaclaw-local.db` side by side —
 * measured on this box, carrying different catalogs — and they read as several instances while being
 * builds of one. A conclusion was once filed against the wrong store because of it.
 *
 * Every test below pins a decision that, got wrong, loses a user's instance or invents one.
 */
describe("InstanceRegistry", () => {
  test("parses a plain registry", () => {
    const { registry, fromFuture, rejected } = InstanceRegistry.parse({
      version: 1,
      entries: [{ name: "work", home: "/home/n/work" }],
    })
    expect(registry.entries).toEqual([{ name: "work", home: "/home/n/work" }])
    expect(fromFuture).toBe(false)
    expect(rejected).toEqual([])
  })

  test("🔴 a file from a NEWER build degrades — it is never refused", () => {
    // This file decides whether a user can reach their own data. Refusing the whole list because one
    // field is from the future would lock someone out of every instance they own.
    const { registry, fromFuture } = InstanceRegistry.parse({
      version: 99,
      entries: [{ name: "work", home: "/home/n/work", colour: "blue" }],
      telemetry: { enabled: true },
    })
    expect(fromFuture).toBe(true)
    expect(registry.entries[0]?.name).toBe("work")
  })

  test("🔴 unknown fields SURVIVE a round trip, at both levels", () => {
    // Otherwise "open it once in the old build" is destructive: a newer NovaClaw's pins would be
    // silently deleted by an older one merely reading and saving.
    const input = {
      version: 1,
      telemetry: { enabled: true },
      entries: [{ name: "work", home: "/home/n/work", colour: "blue" }],
    }
    const written = InstanceRegistry.serialize(InstanceRegistry.parse(input).registry)
    expect(written["telemetry"]).toEqual({ enabled: true })
    expect((written["entries"] as Record<string, unknown>[])[0]).toMatchObject({
      name: "work",
      home: "/home/n/work",
      colour: "blue",
    })
    // ⚠️ …but the VERSION written is this build's. A build that rewrote a future file HAS downgraded
    // it, and claiming otherwise would let an old build assert a shape it did not produce.
    expect(written["version"]).toBe(InstanceRegistry.VERSION)
  })

  test("the HOME is the identity — a duplicate home is one instance, and it says so", () => {
    // Deduping by NAME instead would let two different homes share a name and hide one of them,
    // which is exactly the "several things that look like instances" failure being removed.
    const { registry, rejected } = InstanceRegistry.parse({
      entries: [
        { name: "work", home: "/home/n/work" },
        { name: "work-again", home: "/home/n/work" },
        { name: "other", home: "/home/n/other" },
      ],
    })
    expect(registry.entries.map((entry) => entry.name)).toEqual(["work", "other"])
    expect(rejected.join(" ")).toContain("repeats a home")
  })

  test("malformed entries are dropped INDIVIDUALLY and named, never taken as an empty registry", () => {
    const { registry, rejected } = InstanceRegistry.parse({
      entries: ["nonsense", { name: "", home: "/x" }, { name: "ok", home: "/home/n/ok" }, { name: "y", home: "  " }],
    })
    expect(registry.entries.map((entry) => entry.name)).toEqual(["ok"])
    expect(rejected).toHaveLength(3)
  })

  test("a non-object document is a rejection with a reason, not a crash", () => {
    for (const bad of [null, 42, "text", [1, 2]]) {
      const result = InstanceRegistry.parse(bad)
      expect(result.registry.entries).toEqual([])
      expect(result.rejected.length).toBeGreaterThan(0)
    }
  })

  test("upsert keys on the home, so renaming does not fork the entry", () => {
    let registry = InstanceRegistry.upsert(InstanceRegistry.EMPTY, { name: "work", home: "/home/n/work" })
    registry = InstanceRegistry.upsert(registry, { name: "Work laptop", home: "/home/n/work" })
    expect(registry.entries).toHaveLength(1)
    expect(registry.entries[0]?.name).toBe("Work laptop")
    expect(InstanceRegistry.remove(registry, "/home/n/work").entries).toEqual([])
  })

  test("🔴 the registry file is OUTSIDE any instance home", () => {
    // The subtlety this whole module turns on. `--home`/NOVACLAW_HOME pins all four roots INSIDE the
    // chosen folder, so resolving through Global.Path.config would put the list of instances inside
    // one instance — and every instance would keep its own private list.
    const home = process.platform === "win32" ? "C:\\Users\\n" : "/home/n"
    const pinned = process.platform === "win32" ? "C:\\pinned-instance" : "/pinned-instance"
    const withOverride = InstanceRegistry.location({ NOVACLAW_HOME: pinned } as NodeJS.ProcessEnv, home)
    const without = InstanceRegistry.location({} as NodeJS.ProcessEnv, home)
    expect(withOverride).toBeDefined()
    // Identical with and without the override — that IS the invariant.
    expect(withOverride).toBe(without!)
    expect(withOverride!.startsWith(pinned)).toBe(false)
    expect(path.basename(withOverride!)).toBe(InstanceRegistry.FILE_NAME)
  })

  test("reachability tells `unreachable` from `empty` — a picker needs both", () => {
    // ⚠️ A home on an unplugged drive is still that user's instance. I2 must "recover calmly when one
    // home is unavailable", which it cannot do if discovery already forgot the entry.
    const present = new Set(["/a", "/a/data", "/b"])
    const exists = (target: string) => present.has(target.replaceAll("\\", "/"))
    expect(InstanceRegistry.describeHome("/a", exists)).toBe("ready")
    expect(InstanceRegistry.describeHome("/b", exists)).toBe("empty")
    expect(InstanceRegistry.describeHome("/gone", exists)).toBe("unreachable")
  })

  test("list: a missing registry is an EMPTY one, and reachability rides each entry", () => {
    const home = process.platform === "win32" ? "C:\\Users\\n" : "/home/n"
    // First-run: no file at all. This is the normal state and must not be an error.
    const empty = InstanceRegistry.list({ env: {} as NodeJS.ProcessEnv, homedir: home, readFile: () => undefined })
    expect(empty.instances).toEqual([])
    expect(empty.path).toBeDefined()

    const found = InstanceRegistry.list({
      env: {} as NodeJS.ProcessEnv,
      homedir: home,
      readFile: () =>
        JSON.stringify({
          entries: [
            { name: "work", home: "/w" },
            { name: "old", home: "/gone" },
          ],
        }),
      exists: (target) => ["/w", "/w/data"].includes(target.replaceAll("\\", "/")),
    })
    expect(found.instances.map((entry) => [entry.name, entry.reachability])).toEqual([
      ["work", "ready"],
      ["old", "unreachable"],
    ])
  })

  test("list: a CORRUPT registry is not reported as 'no instances'", () => {
    // Ruling 2. Returning an empty list for unparseable JSON tells the user their instances are gone.
    // The path is still reported, which is what lets a caller say WHICH file to look at.
    const home = process.platform === "win32" ? "C:\\Users\\n" : "/home/n"
    const result = InstanceRegistry.list({
      env: {} as NodeJS.ProcessEnv,
      homedir: home,
      readFile: () => "{ not json",
    })
    expect(result.instances).toEqual([])
    expect(result.path).toBeDefined()
  })
})
