import { describe, expect, test } from "bun:test"
import { Ledger } from "./eevdf"

describe("TG-EEVDF ledger", () => {
  test("interactive-focused beats batch at every fresh turn boundary (earlier deadline)", () => {
    const ledger = new Ledger()
    ledger.ensure("ui", "interactive-focused")
    ledger.ensure("batch", "auto-prompting")
    expect(ledger.pick([{ id: "ui" }, { id: "batch" }])).toBe("ui")
  })

  test("over-consumption drives lag negative → ineligible until virtual time catches up", () => {
    const ledger = new Ledger()
    ledger.ensure("ui", "interactive-focused")
    ledger.ensure("batch", "auto-prompting")
    // The UI session burns a huge turn: its vruntime races ahead of virtual time.
    ledger.charge("ui", 100_000)
    expect(ledger.eligible("ui")).toBe(false)
    expect(ledger.pick([{ id: "ui" }, { id: "batch" }])).toBe("batch")
    // Batch consumes; virtual time advances; the debt amortizes.
    for (let i = 0; i < 50 && !ledger.eligible("ui"); i++) ledger.charge("batch", 20_000)
    expect(ledger.eligible("ui")).toBe(true)
  })

  test("waiting sessions age structurally: cron is eventually picked (no starvation)", () => {
    const ledger = new Ledger()
    ledger.ensure("ui", "interactive-focused")
    ledger.ensure("cron", "cron")
    let cronPicked = false
    for (let turn = 0; turn < 200 && !cronPicked; turn++) {
      const pick = ledger.pick([{ id: "ui" }, { id: "cron" }])!
      if (pick === "cron") cronPicked = true
      ledger.charge(pick, 2_000)
    }
    expect(cronPicked).toBe(true)
  })

  test("share follows weights over the long run", () => {
    const ledger = new Ledger()
    ledger.ensure("heavy", "interactive")
    ledger.ensure("light", "auto-prompting")
    const счёт: Record<string, number> = { heavy: 0, light: 0 }
    for (let turn = 0; turn < 300; turn++) {
      const pick = ledger.pick([{ id: "heavy" }, { id: "light" }])!
      счёт[pick]!++
      ledger.charge(pick, 1_000)
    }
    // weight 50 vs 10 → heavy should take roughly 5x the turns (loose bounds).
    expect(счёт.heavy! / счёт.light!).toBeGreaterThan(3)
    expect(счёт.heavy! / счёт.light!).toBeLessThan(8)
  })

  test("cache-affinity is hysteresis, not override: bonus is capped", () => {
    const ledger = new Ledger({ forgivenessMs: 1000 })
    ledger.ensure("warm", "auto-prompting")
    ledger.ensure("cold", "interactive-focused")
    // Same starting point: warmth breaks the tie toward the resident session…
    ledger.ensure("peer", "auto-prompting")
    expect(ledger.pick([{ id: "warm", warmthTokens: 6_000 }, { id: "peer" }])).toBe("warm")
    // …but an interactive session's deadline lead beats ANY warmth (the cap): the
    // cold focused session wins even against a fully-warm batch peer.
    expect(ledger.pick([{ id: "warm", warmthTokens: 1_000_000 }, { id: "cold" }])).toBe("cold")
  })

  test("blocked sessions keep debt across brief blocks; long blocks are forgiven", () => {
    const ledger = new Ledger({ forgivenessMs: 1_000 })
    ledger.ensure("a", "interactive")
    ledger.ensure("b", "interactive")
    ledger.charge("a", 50_000)
    expect(ledger.eligible("a")).toBe(false)
    ledger.onBlock("a", 0)
    expect(ledger.onWake("a", 100).forgiven).toBe(false)
    expect(ledger.eligible("a")).toBe(false) // debt survived the brief sleep
    ledger.onBlock("a", 200)
    expect(ledger.onWake("a", 5_000).forgiven).toBe(true)
    expect(ledger.eligible("a")).toBe(true) // long block → lag reset to 0
  })

  test("all-indebted pool falls back to least-indebted (device never idles)", () => {
    const ledger = new Ledger()
    ledger.ensure("a", "interactive")
    ledger.ensure("b", "interactive")
    ledger.charge("a", 60_000)
    ledger.charge("b", 30_000)
    // Both have negative... a charged more against shared virtual time.
    const pick = ledger.pick([{ id: "a" }, { id: "b" }])
    expect(pick).toBeDefined()
    expect(ledger.lag(pick!)).toBeGreaterThanOrEqual(ledger.lag(pick === "a" ? "b" : "a"))
  })

  test("deadline pressure: shrinking the slice pulls the virtual deadline earlier", () => {
    const ledger = new Ledger()
    ledger.ensure("cron", "cron")
    const before = ledger.virtualDeadline("cron")
    ledger.setSlice("cron", 1_000)
    expect(ledger.virtualDeadline("cron")).toBeLessThan(before)
  })
})
