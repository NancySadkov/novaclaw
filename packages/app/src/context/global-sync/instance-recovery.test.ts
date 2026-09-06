import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { createInstanceRecovery } from "./instance-recovery"

/**
 * 🔴 **Instance-scoped state must be re-fetched on reconnect, and before 2026-09-04 none of it was.**
 *
 * The reconnect sweep enumerates `children.children` — DIRECTORY stores — so tags, presence and the
 * persisted app manifests had no sweep at all and stayed stale until a page reload. The class:
 * *a recovery sweep that enumerates one KIND of state silently omits every other kind.*
 */
describe("createInstanceRecovery", () => {
  test("registering does NOT run — the first sweep does", () => {
    const ran: string[] = []
    const recovery = createInstanceRecovery()
    recovery.register("a", () => ran.push("a"))
    recovery.register("b", () => ran.push("b"))
    // If `register` ran its bootstrap, the initial load and the recovery load would be two paths
    // that can drift — which is the shape of the bug this replaces.
    expect(ran).toEqual([])
    recovery.sweep()
    expect(ran).toEqual(["a", "b"])
  })

  test("🔴 a sweep runs EVERY time — this is the whole defect", () => {
    let count = 0
    const recovery = createInstanceRecovery()
    recovery.register("x", () => void count++)
    recovery.sweep()
    recovery.sweep()
    recovery.sweep()
    // The old code called each loader once per ctx. A registry that de-duplicated would reproduce
    // exactly the bug, so "runs again" is the assertion that matters, not "runs".
    expect(count).toBe(3)
  })

  test("one bootstrap that throws does not strand the others", () => {
    const ran: string[] = []
    const recovery = createInstanceRecovery()
    recovery.register("first", () => {
      throw new Error("boom")
    })
    recovery.register("second", () => ran.push("second"))
    expect(() => recovery.sweep()).not.toThrow()
    // Recovery runs precisely when something has already gone wrong; a sweep that gives up on the
    // first fault is a sweep that fails when it is needed.
    expect(ran).toEqual(["second"])
  })

  test("re-registering a name replaces it rather than running both", () => {
    const ran: string[] = []
    const recovery = createInstanceRecovery()
    recovery.register("dup", () => ran.push("old"))
    recovery.register("dup", () => ran.push("new"))
    recovery.sweep()
    expect(ran).toEqual(["new"])
    expect(recovery.names()).toEqual(["dup"])
  })
})

describe("server-sync registers its instance-scoped loaders", () => {
  const SYNC = readFileSync(path.resolve(import.meta.dir, "..", "server-sync.tsx"), "utf8")

  test("🔴 the three loaders that were stranded are registered, and none is called bare", () => {
    // Derived from source rather than asserted as a list, because the failure this guards is a
    // loader that goes back to being called once at ctx creation — which no runtime assertion in
    // this file could see.
    const registered = (source: string) =>
      [...source.matchAll(/\brecovery\.register\(\s*"([^"]+)"/g)].map((match) => match[1])
    for (const name of ["session.tags", "session.presence", "apps.persisted"]) {
      expect(registered(SYNC), `${name} is not registered for reconnect recovery`).toContain(name)
    }
    expect(registered('recovery.register(\n "apps.persisted", load)')).toEqual(["apps.persisted"])
    expect(registered("loadPersistedApps()")).toEqual([])
    // A bare call at context scope is the regression: it runs once per ctx and never on reconnect.
    expect(SYNC).not.toContain("\n  void session.loadTags()")
    expect(SYNC).not.toContain("\n  void session.loadPresence()")
  })

  test("the sweep is wired to BOTH the first load and the reconnect BRANCH", () => {
    // Two call sites, and both are load-bearing: one is the initial bootstrap, one is the recovery.
    // Non-vacuity for the assertion above — registering without ever sweeping loads nothing at all.
    expect([...SYNC.matchAll(/recovery\.sweep\(\)/g)].length).toBeGreaterThanOrEqual(2)

    // 🔴 And one of them is INSIDE the reconnect branch, not merely somewhere in the file. The
    // weaker "two sweeps exist somewhere" version of this passed on a file where the second sweep
    // could have sat anywhere, which would leave the reconnect path exactly as broken as before.
    // The anchor is the branch that already re-queues every directory store — a path proven to run,
    // which is why the instance sweep was put in it rather than in a new listener of its own.
    const branch = SYNC.slice(SYNC.indexOf('=== "server.connected" || '))
    const sweepAt = branch.indexOf("recovery.sweep()")
    const queueAt = branch.indexOf("queue.push(directory)")
    expect(sweepAt, "no recovery sweep inside the server.connected branch").toBeGreaterThan(0)
    expect(queueAt, "the directory sweep this anchors to has moved — re-derive the anchor").toBeGreaterThan(0)
    expect(sweepAt, "the instance sweep must run in the same branch as the directory sweep").toBeLessThan(queueAt)
  })
})
