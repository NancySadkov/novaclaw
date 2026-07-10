import { describe, expect, test } from "bun:test"
import { JhLadder } from "./ladder"

// R4 (jh-improve1 P5): the escalation ladder transition table. De-latched, per-signature, cycling.
describe("JhLadder.next", () => {
  test("first escalation on a signature → tweak, count 1", () => {
    expect(JhLadder.next(undefined, { sig: "A", scoreImproved: false })).toEqual({ sig: "A", count: 1, stage: "tweak", rewrites: 0 })
  })

  test("counts 2-3 stay tweak; 4 → analyze; 5 → targeted_fix; 6 → rewrite (first time)", () => {
    let s = JhLadder.next(undefined, { sig: "A", scoreImproved: false }) // 1 tweak
    s = JhLadder.next(s, { sig: "A", scoreImproved: false })
    expect(s).toMatchObject({ count: 2, stage: "tweak" })
    s = JhLadder.next(s, { sig: "A", scoreImproved: false })
    expect(s).toMatchObject({ count: 3, stage: "tweak" })
    s = JhLadder.next(s, { sig: "A", scoreImproved: false })
    expect(s).toMatchObject({ count: 4, stage: "analyze" })
    s = JhLadder.next(s, { sig: "A", scoreImproved: false })
    expect(s).toMatchObject({ count: 5, stage: "targeted_fix" })
    s = JhLadder.next(s, { sig: "A", scoreImproved: false })
    expect(s).toMatchObject({ count: 6, stage: "rewrite", rewrites: 0 })
  })

  test("after a rewrite → resets to tweak with rewrites incremented (rewrite is spent)", () => {
    const rewrite: JhLadder.LadderState = { sig: "A", count: 6, stage: "rewrite", rewrites: 0 }
    expect(JhLadder.next(rewrite, { sig: "A", scoreImproved: false })).toEqual({ sig: "A", count: 1, stage: "tweak", rewrites: 1 })
  })

  test("a changed signature RESETS to tweak (per-problem), carrying the rewrites budget", () => {
    const s: JhLadder.LadderState = { sig: "A", count: 5, stage: "targeted_fix", rewrites: 1 }
    expect(JhLadder.next(s, { sig: "B", scoreImproved: false })).toEqual({ sig: "B", count: 1, stage: "tweak", rewrites: 1 })
  })

  test("score improvement RESETS to tweak even on the same signature", () => {
    const s: JhLadder.LadderState = { sig: "A", count: 5, stage: "targeted_fix", rewrites: 0 }
    expect(JhLadder.next(s, { sig: "A", scoreImproved: true })).toEqual({ sig: "A", count: 1, stage: "tweak", rewrites: 0 })
  })

  test("once a rewrite is spent, count 6 CYCLES to tweak instead of rewriting again (no permanent latch)", () => {
    // walk up to count 6 with rewrites already 1
    let s: JhLadder.LadderState = { sig: "A", count: 5, stage: "targeted_fix", rewrites: 1 }
    s = JhLadder.next(s, { sig: "A", scoreImproved: false })
    expect(s).toEqual({ sig: "A", count: 1, stage: "tweak", rewrites: 1 }) // cycled, did NOT rewrite twice
  })

  test("full cycle after a rewrite: tweak→tweak→tweak→analyze→targeted_fix→(cycle)", () => {
    let s: JhLadder.LadderState = { sig: "A", count: 1, stage: "tweak", rewrites: 1 }
    const stages: string[] = [s.stage]
    for (let i = 0; i < 5; i++) {
      s = JhLadder.next(s, { sig: "A", scoreImproved: false })
      stages.push(s.stage)
    }
    expect(stages).toEqual(["tweak", "tweak", "tweak", "analyze", "targeted_fix", "tweak"]) // counts 1..6→cycle
    expect(s.rewrites).toBe(1) // never rewrote again
  })

  test("only ONE rewrite per run across problems (rewrites carries on sig change)", () => {
    // spend the rewrite on sig A
    let s = JhLadder.next(undefined, { sig: "A", scoreImproved: false })
    for (let c = 2; c <= 6; c++) s = JhLadder.next(s, { sig: "A", scoreImproved: false })
    expect(s.stage).toBe("rewrite")
    s = JhLadder.next(s, { sig: "A", scoreImproved: false }) // rewrite spent → tweak, rewrites 1
    expect(s.rewrites).toBe(1)
    // now a NEW problem B escalates all the way — it must NOT earn a second rewrite
    s = JhLadder.next(s, { sig: "B", scoreImproved: false })
    for (let c = 2; c <= 6; c++) s = JhLadder.next(s, { sig: "B", scoreImproved: false })
    expect(s.stage).not.toBe("rewrite")
    expect(s.stage).toBe("tweak") // cycled instead
  })
})
