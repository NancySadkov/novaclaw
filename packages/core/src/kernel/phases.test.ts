import { describe, expect, test } from "bun:test"
import { Kernel, KernelError, type PhaseId } from "./phases"

describe("phases-as-data kernel", () => {
  test("bootstraps the builtin chain in order", () => {
    const kernel = new Kernel()
    expect(kernel.phases).toEqual(["ingest", "account", "classify", "age", "pick", "dispatch", "flush"] as PhaseId[])
  })

  test("third-party phases must anchor into the DAG", () => {
    const kernel = new Kernel()
    expect(() => kernel.definePhase("floating", {})).toThrow(KernelError)
    const pick = "pick" as PhaseId
    const dispatch = "dispatch" as PhaseId
    const audit = kernel.definePhase("audit", { after: [pick], before: [dispatch] })
    const order = kernel.phases
    expect(order.indexOf(audit)).toBeGreaterThan(order.indexOf(pick))
    expect(order.indexOf(audit)).toBeLessThan(order.indexOf(dispatch))
  })

  test("reactions sweep marked entities in registration order", () => {
    const kernel = new Kernel()
    const seen: string[] = []
    kernel.registerReaction("first", { phase: "pick" as PhaseId, marker: "runnable", fn: (id) => seen.push(`first:${id}`) })
    kernel.registerReaction("second", { phase: "pick" as PhaseId, marker: "runnable", fn: (id) => seen.push(`second:${id}`) })
    kernel.addMarker("s1", "runnable")
    kernel.tick()
    expect(seen).toEqual(["first:s1", "second:s1"])
  })

  test("explicit order edges override registration order (within-phase only)", () => {
    const kernel = new Kernel()
    const seen: string[] = []
    const a = kernel.registerReaction("a", { phase: "pick" as PhaseId, marker: "m", fn: () => seen.push("a") })
    kernel.registerReaction("b", { phase: "pick" as PhaseId, marker: "m", order: { before: [a] }, fn: () => seen.push("b") })
    kernel.addMarker("x", "m")
    kernel.tick()
    expect(seen).toEqual(["b", "a"])
    expect(() =>
      kernel.registerReaction("cross", { phase: "flush" as PhaseId, marker: "m", order: { after: [a] }, fn: () => {} }),
    ).toThrow(/DIFFERENT phase/)
  })

  test("deferred markers: added during phase X are swept by phase X+1 in the SAME tick", () => {
    const kernel = new Kernel()
    const seen: string[] = []
    kernel.registerReaction("promoter", {
      phase: "pick" as PhaseId,
      marker: "runnable",
      fn: (id, ctx) => ctx.defer.addMarker(id, "picked"),
    })
    kernel.registerReaction("dispatcher", {
      phase: "dispatch" as PhaseId,
      marker: "picked",
      fn: (id, ctx) => seen.push(`dispatch:${id}@${ctx.tick}`),
    })
    kernel.addMarker("s1", "runnable")
    kernel.tick()
    expect(seen).toEqual(["dispatch:s1@1"])
  })

  test("markers added mid-sweep are NOT visible to the same phase (snapshot semantics)", () => {
    const kernel = new Kernel()
    let sweeps = 0
    kernel.registerReaction("self-adder", {
      phase: "pick" as PhaseId,
      marker: "m",
      fn: (_, ctx) => {
        sweeps++
        ctx.defer.addMarker("late", "m")
      },
    })
    kernel.addMarker("early", "m")
    kernel.tick()
    expect(sweeps).toBe(1) // "late" waits for the NEXT tick's pick phase
    kernel.tick()
    expect(sweeps).toBe(3) // early + late
  })

  test("consumed markers are one-shot (removed after the sweep, auditable not expiring)", () => {
    const kernel = new Kernel()
    let fired = 0
    kernel.registerReaction("consumer", { phase: "ingest" as PhaseId, marker: "steer", consume: true, fn: () => fired++ })
    kernel.addMarker("s1", "steer")
    kernel.tick()
    kernel.tick()
    expect(fired).toBe(1)
    expect(kernel.hasMarker("s1", "steer")).toBe(false)
  })

  test("run conditions gate the sweep per entity", () => {
    const kernel = new Kernel()
    const seen: string[] = []
    kernel.registerReaction("gated", {
      phase: "pick" as PhaseId,
      marker: "m",
      when: [(id) => id !== "blocked"],
      fn: (id) => seen.push(id),
    })
    kernel.addMarker("ok", "m")
    kernel.addMarker("blocked", "m")
    kernel.tick()
    expect(seen).toEqual(["ok"])
  })

  test("rejects duplicate phases/reactions and unknown references", () => {
    const kernel = new Kernel()
    kernel.registerReaction("r", { phase: "pick" as PhaseId, marker: "m", fn: () => {} })
    expect(() => kernel.registerReaction("r", { phase: "pick" as PhaseId, marker: "m", fn: () => {} })).toThrow(KernelError)
    expect(() =>
      kernel.registerReaction("r2", { phase: "nope" as PhaseId, marker: "m", fn: () => {} }),
    ).toThrow(/unknown phase/)
    expect(() =>
      kernel.registerReaction("r3", { phase: "pick" as PhaseId, marker: "m", order: { after: ["ghost" as never] }, fn: () => {} }),
    ).toThrow(/unknown reaction/)
  })
})
