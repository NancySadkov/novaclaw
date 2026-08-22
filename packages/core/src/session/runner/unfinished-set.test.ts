import { describe, expect, test } from "bun:test"
import { UnfinishedSet } from "./unfinished-set"

// The SET gate and the DELEGATION exemption it needs, as pure rules.
//
// 🔴 `llm.ts` withholds `spawn` for the whole of a set request — measured, and right for "describe
// each icon in this folder": the harness is the controller for a set, and nine runs of a 400-icon
// prompt showed every delegating run covering less in more time. The exemption below is the case that
// gate cannot tell apart on cues alone, and it was measured too.

describe("asksToDelegate — the exemption the set gate needs", () => {
  test("🔴 an explicit fleet order is delegation, even though it says `each`", () => {
    // Measured on Qwen3.6-35B 2026-08-22: this exact sentence tripped `asksForSet`, `spawn` was
    // withheld, and six correct calls came back "Unknown tool: spawn".
    const order = "Spawn a fleet of 6 sub-agents, each summarising a different sixth of the file."
    expect(UnfinishedSet.asksForSet(order)).toBe(true)
    expect(UnfinishedSet.asksToDelegate(order)).toBe(true)
  })

  test("the set case the gate exists for is NOT exempted", () => {
    // The measured regression this protects: nine runs of a 400-icon prompt, every delegating run
    // covering less in more time.
    const setRequest = "Look at every png in this folder and describe each one."
    expect(UnfinishedSet.asksForSet(setRequest)).toBe(true)
    expect(UnfinishedSet.asksToDelegate(setRequest)).toBe(false)
  })

  test("both spellings of sub-agent count, and so do the plain synonyms", () => {
    for (const text of [
      "use sub-agents for this",
      "use sub agents for this",
      "use subagents for this",
      "delegate the parts",
      "do them in parallel",
      "spawn two workers",
    ])
      expect({ text, delegate: UnfinishedSet.asksToDelegate(text) }).toEqual({ text, delegate: true })
  })

  test("⚠️ WORD boundaries — a cue inside another word does not count", () => {
    // The 835,145-token lesson, applied to this list: `spawn` must not match `spawning` mid-word in
    // a sentence that is not an instruction, and `workers` must not match `coworkers`.
    expect(UnfinishedSet.asksToDelegate("the salmon are spawning upstream")).toBe(false)
    expect(UnfinishedSet.asksToDelegate("ask my coworkers about it")).toBe(false)
  })
})
