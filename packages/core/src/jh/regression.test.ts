import { describe, expect, test } from "bun:test"
import { JhRegression } from "./regression"

// jh-improve4 P1 — the persistent regression registry (pure). Engine integration (the run75 fixture, the
// re-run-before-leaf-check preemption, the buildDamage interplay) lives in regression-engine.test.ts.

describe("JhRegression.registry", () => {
  test("register + all: keyed by normalized command, carries expect", () => {
    const r = JhRegression.registry()
    r.register({ command: "  .\\t_mul.exe  ", expect: "998001", depsDigest: "d0" })
    const all = r.all()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ command: ".\\t_mul.exe", expect: "998001", depsDigest: "d0", failures: 0 })
  })

  test("normalizeCommand collapses internal whitespace so one test is not registered twice", () => {
    const r = JhRegression.registry()
    r.register({ command: ".\\t_mul.exe   --run", depsDigest: "d0" })
    r.register({ command: ".\\t_mul.exe --run", depsDigest: "d1" }) // same test, different spacing
    expect(r.all()).toHaveLength(1)
    expect(r.all()[0]!.depsDigest).toBe("d1") // re-registration updated the digest
  })

  test("staleTests: only tests whose stored digest ≠ the current digest", () => {
    const r = JhRegression.registry()
    r.register({ command: "a", depsDigest: "d0" })
    r.register({ command: "b", depsDigest: "d0" })
    // b was re-registered at the current source state d1; a is still at d0.
    r.register({ command: "b", depsDigest: "d1" })
    const stale = r.staleTests(() => "d1")
    expect(stale.map((t) => t.command)).toEqual(["a"]) // only a is out of date
  })

  test("staleTests preserves registration order", () => {
    const r = JhRegression.registry()
    for (const c of ["t_add", "t_sub", "t_mul", "t_div"]) r.register({ command: c, depsDigest: "old" })
    const stale = r.staleTests(() => "new")
    expect(stale.map((t) => t.command)).toEqual(["t_add", "t_sub", "t_mul", "t_div"])
  })

  test("recordResult PASS: refreshes digest + clears the failure streak", () => {
    const r = JhRegression.registry()
    r.register({ command: "t", depsDigest: "d0" })
    r.recordResult("t", false, "d1")
    r.recordResult("t", false, "d2")
    expect(r.all()[0]).toMatchObject({ depsDigest: "d2", failures: 2 })
    r.recordResult("t", true, "d3") // passed again at d3
    expect(r.all()[0]).toMatchObject({ depsDigest: "d3", failures: 0 })
    expect(r.staleTests(() => "d3")).toHaveLength(0) // now current — not re-run
  })

  test("recordResult FAIL: bumps consecutive failures + advances digest (re-run once per source change)", () => {
    const r = JhRegression.registry()
    r.register({ command: "t", depsDigest: "d0" })
    r.recordResult("t", false, "d1")
    expect(r.all()[0]!.failures).toBe(1)
    // digest advanced to d1 → a same-state re-check would not re-run it (only a NEW source edit does)
    expect(r.staleTests(() => "d1")).toHaveLength(0)
    expect(r.staleTests(() => "d2")).toHaveLength(1) // a further edit re-stales it
  })

  test("recordResult on an unknown command is a no-op (never resurrects a pruned test)", () => {
    const r = JhRegression.registry()
    r.recordResult("ghost", true, "d1")
    expect(r.all()).toHaveLength(0)
  })

  test("prune: drops tests whose product no longer exists", () => {
    const r = JhRegression.registry()
    r.register({ command: ".\\t_mul.exe", depsDigest: "d0" })
    r.register({ command: ".\\t_add.exe", depsDigest: "d0" })
    r.prune((cmd) => cmd !== ".\\t_add.exe") // t_add's product was deleted
    expect(r.all().map((t) => t.command)).toEqual([".\\t_mul.exe"])
  })

  test("re-registration after a failure streak resets failures (a fresh green baseline)", () => {
    const r = JhRegression.registry()
    r.register({ command: "t", depsDigest: "d0" })
    r.recordResult("t", false, "d1")
    r.recordResult("t", false, "d2")
    expect(r.all()[0]!.failures).toBe(2)
    r.register({ command: "t", expect: "OK", depsDigest: "d3" }) // seen green anew (leaf check passed again)
    expect(r.all()[0]).toMatchObject({ depsDigest: "d3", failures: 0, expect: "OK" })
  })
})
