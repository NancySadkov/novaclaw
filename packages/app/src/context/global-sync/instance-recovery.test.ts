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
  test("registering does NOT run — the first sweep does", async () => {
    const ran: string[] = []
    const recovery = createInstanceRecovery()
    recovery.register("a", () => { ran.push("a"); return Promise.resolve() })
    recovery.register("b", () => { ran.push("b"); return Promise.resolve() })
    // If `register` ran its bootstrap, the initial load and the recovery load would be two paths
    // that can drift — which is the shape of the bug this replaces.
    expect(ran).toEqual([])
    await recovery.sweep()
    expect(ran).toEqual(["a", "b"])
  })

  test("🔴 a sweep runs EVERY time — this is the whole defect", async () => {
    let count = 0
    const recovery = createInstanceRecovery()
    recovery.register("x", () => { count++; return Promise.resolve() })
    await recovery.sweep()
    await recovery.sweep()
    await recovery.sweep()
    // The old code called each loader once per ctx. A registry that de-duplicated would reproduce
    // exactly the bug, so "runs again" is the assertion that matters, not "runs".
    expect(count).toBe(3)
  })

  test("🔴 a bootstrap that REJECTS is RECORDED with its name, and does not strand the others", async () => {
    // The defect this replaces: `register` took `() => void` and every call site wrote
    // `() => void somePromise()`, so the sweep received `undefined` and its try/catch could only
    // catch a SYNCHRONOUS throw. An async rejection escaped every guard and surfaced as Chromium's
    // "Uncaught (in promise)" — naming neither the bootstrap nor the error. Measured 2026-09-29.
    const ran: string[] = []
    const recovery = createInstanceRecovery()
    recovery.register("first", () => Promise.reject(new Error("boom")))
    recovery.register("second", () => { ran.push("second"); return Promise.resolve() })
    await expect(recovery.sweep()).resolves.toBeUndefined()
    // Recovery runs precisely when something has already gone wrong; a sweep that gives up on the
    // first fault is a sweep that fails when it is needed.
    expect(ran).toEqual(["second"])
    // And the failure is OWNED: recorded, named, and available to a caller that can show it. The
    // negative assertion is load-bearing — a `console.error` here is the silent-write ledger's form
    // A, and this module has no door a person can see.
    expect(recovery.failures().map((failure) => failure.name)).toEqual(["first"])
    expect(String((recovery.failures()[0]?.error as Error)?.message)).toBe("boom")
  })

  test("a clean sweep reports no failures, and a later one replaces an earlier", async () => {
    const recovery = createInstanceRecovery()
    recovery.register("ok", () => Promise.resolve())
    await recovery.sweep()
    expect(recovery.failures()).toEqual([])
    recovery.register("bad", () => Promise.reject(new Error("later")))
    await recovery.sweep()
    // Stale failures must not accumulate into a permanently alarming list.
    expect(recovery.failures().map((failure) => failure.name)).toEqual(["bad"])
  })

  test("a bootstrap that throws SYNCHRONOUSLY is contained too", async () => {
    const ran: string[] = []
    const recovery = createInstanceRecovery()
    recovery.register("first", () => {
      throw new Error("boom")
    })
    recovery.register("second", () => { ran.push("second"); return Promise.resolve() })
    await expect(recovery.sweep()).resolves.toBeUndefined()
    expect(ran).toEqual(["second"])
    expect(recovery.failures().map((failure) => failure.name)).toEqual(["first"])
  })

  test("re-registering a name replaces it rather than running both", async () => {
    const ran: string[] = []
    const recovery = createInstanceRecovery()
    recovery.register("dup", () => { ran.push("old"); return Promise.resolve() })
    recovery.register("dup", () => { ran.push("new"); return Promise.resolve() })
    await recovery.sweep()
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

  test("🔴 no registration discards its own promise — the shape the sweep is blind to", () => {
    // The class, as source: a bootstrap wrapped so its promise is thrown away. `sweep` can only
    // observe what it is handed, so this shape turns any future loader's failure into an unowned
    // unhandled rejection.
    //
    // ⚠️ The call text is extracted by COUNTING PARENS, not by a `[^)]*` regex. That regex cannot
    // reach the `=>` of `() => void p()`, because the arrow's own parameter list puts a `)` first —
    // so the assertion passed on a file containing the exact defect it was written to catch. This
    // test is the second time in this repo a structural ratchet has been vacuous; the paren counter
    // is the fix, and the planted-failure check below is what keeps it honest.
    const registerCalls = (source: string) => {
      const open = "recovery.register("
      const calls: string[] = []
      let at = source.indexOf(open)
      while (at >= 0) {
        let depth = 0
        let i = at + open.length - 1
        for (; i < source.length; i++) {
          if (source[i] === "(") depth++
          else if (source[i] === ")" && --depth === 0) break
        }
        calls.push(source.slice(at, i + 1))
        at = source.indexOf(open, i + 1)
      }
      return calls
    }
    // Prose quotes the defect it describes, so comments are stripped before a structural assertion.
    const code = SYNC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "")
    const calls = registerCalls(code)
    expect(calls.length, "no recovery.register call was found — re-derive this anchor").toBeGreaterThanOrEqual(3)
    const discarded = calls.filter((call) => /=>\s*void\s/.test(call))
    expect(discarded, "a registered bootstrap discards its promise").toEqual([])
  })

  test("🔴 every sweep goes through the door that can show a person what failed", () => {
    // A bare `recovery.sweep()` at either site discards the recorded failures, which puts the sweep
    // back to reporting nothing — the exact defect, one indirection away. Two sites, both routed.
    const bare = [...SYNC.matchAll(/^(\s*)recovery\.sweep\(\)/gm)].map((match) => match[1]?.length ?? 0)
    expect(bare, "a sweep bypasses the reporting door").toEqual([])
    expect([...SYNC.matchAll(/sweepAndReport\(\)/g)].length).toBeGreaterThanOrEqual(2)
  })

  test("the sweep is wired to BOTH the first load and the reconnect BRANCH", () => {
    // Two call sites, and both are load-bearing: one is the initial bootstrap, one is the recovery.
    // Non-vacuity for the assertion above — registering without ever sweeping loads nothing at all.
    expect([...SYNC.matchAll(/sweepAndReport\(\)/g)].length).toBeGreaterThanOrEqual(2)

    // 🔴 And one of them is INSIDE the reconnect branch, not merely somewhere in the file. The
    // weaker "two sweeps exist somewhere" version of this passed on a file where the second sweep
    // could have sat anywhere, which would leave the reconnect path exactly as broken as before.
    // The anchor is the branch that already re-queues every directory store — a path proven to run,
    // which is why the instance sweep was put in it rather than in a new listener of its own.
    const branch = SYNC.slice(SYNC.indexOf('=== "server.connected" || '))
    const sweepAt = branch.indexOf("sweepAndReport()")
    const queueAt = branch.indexOf("queue.push(directory)")
    expect(sweepAt, "no recovery sweep inside the server.connected branch").toBeGreaterThan(0)
    expect(queueAt, "the directory sweep this anchors to has moved — re-derive the anchor").toBeGreaterThan(0)
    expect(sweepAt, "the instance sweep must run in the same branch as the directory sweep").toBeLessThan(queueAt)
  })
})
