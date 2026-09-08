import { describe, expect, test } from "bun:test"
import { chunk, entityID, isHeading, passageID, stripGutenberg } from "./chunk"

// These pin the MEASURED chunking rules. The header-carrying behaviour is the one that mattered: a
// table row cut away from its header is unreachable by keyword search (measured 0/6 → 4/6 on the
// uncontaminated corpus once headings were carried).

describe("isHeading", () => {
  test("accepts short, mostly-uppercase, non-sentence lines", () => {
    expect(isHeading("D20 ATTACK")).toBe(true)
    expect(isHeading("AMBUSH DRAKE")).toBe(true)
    expect(isHeading("EXPERTISE")).toBe(true)
  })

  test("rejects prose, sentences and anything too long or too short", () => {
    expect(isHeading("The hero rolls a d20 and compares the result.")).toBe(false)
    expect(isHeading("ROLL THE DICE NOW.")).toBe(false) // terminal punctuation ⇒ a sentence
    expect(isHeading("AB")).toBe(false) // too short
    expect(isHeading("A".repeat(60))).toBe(false) // too long
    expect(isHeading("123 456")).toBe(false) // no letters to judge case by
  })
})

describe("chunk", () => {
  test("carries the section heading into EVERY chunk cut from that section", () => {
    // The regression that motivated this: without the heading, the row below contains neither "D20"
    // nor "ATTACK", so a query naming the table can never match it.
    const text = ["D20 ATTACK", "1. Miss and actor gains Disadvantage", "9. Hit unless HARD, ABSURD or THICK"].join(
      "\n",
    )
    const out = chunk(text, 40) // force multiple chunks out of one section
    expect(out.length).toBeGreaterThan(1)
    expect(out.every((c) => c.startsWith("[D20 ATTACK]"))).toBe(true)
    expect(out.join(" ")).toContain("Miss and actor gains Disadvantage")
  })

  test("joins a title wrapped across two lines instead of treating it as two sections", () => {
    const out = chunk(["AMBUSH", "DRAKE", "Hit Dice: 7d12+28 (73 hp)"].join("\n"))
    expect(out).toHaveLength(1)
    expect(out[0]).toStartWith("[AMBUSH DRAKE]")
  })

  test("starts a new chunk at a new heading, so sections never bleed together", () => {
    const out = chunk(["D20 ATTACK", "1. Miss", "D20 TILE", "16. CRAMPED blocks LARGE or GIANT"].join("\n"))
    expect(out).toHaveLength(2)
    expect(out[0]).toContain("[D20 ATTACK]")
    expect(out[1]).toContain("[D20 TILE]")
    expect(out[1]).toContain("CRAMPED")
  })

  test("respects the size budget and drops blank lines", () => {
    const body = Array.from({ length: 40 }, (_, i) => `line number ${i} with some filler text`).join("\n\n")
    const out = chunk(body, 200)
    expect(out.length).toBeGreaterThan(1)
    for (const c of out) expect(c.length).toBeLessThan(400) // budget + one overshooting line
    expect(out.join("\n")).not.toContain("\n\n")
  })

  test("text with no headings still chunks (heading prefix omitted)", () => {
    const out = chunk("just some ordinary prose without any headings at all")
    expect(out).toHaveLength(1)
    expect(out[0]).not.toStartWith("[")
  })
})

describe("stripGutenberg", () => {
  test("removes the boilerplate around a public-domain body", () => {
    const raw = [
      "header junk",
      "*** START OF THE PROJECT GUTENBERG EBOOK X ***",
      "the real body",
      "*** END OF THE PROJECT GUTENBERG EBOOK X ***",
      "footer junk",
    ].join("\n")
    const out = stripGutenberg(raw)
    expect(out).toContain("the real body")
    expect(out).not.toContain("header junk")
    expect(out).not.toContain("footer junk")
  })

  test("is a no-op for sources that have no boilerplate", () => {
    expect(stripGutenberg("D20 ATTACK\n1. Miss")).toBe("D20 ATTACK\n1. Miss")
  })
})

describe("entityID — one identity for a thing, whichever path wrote it", () => {
  /**
   * 🔴 The reason this lives in `KbChunk` and not beside either caller. TWO paths write entities:
   * conversational extraction and document ingestion. If they minted ids by different formulas, the
   * same name would become two unconnected nodes — the exact fragmentation the entity layer was
   * added to remove (measured: 280 nodes, 22 edges, 63 distinct names across 280).
   */
  test("a document and a chat-mentioned thing of the same name are ONE node", async () => {
    const { SessionExtract } = await import("../session/runner/extract")
    // Not "both look right" — literally the same id, because it is literally the same function.
    expect(SessionExtract.entityID("global", "TypeScript")).toBe(entityID("global", "TypeScript"))
    expect(SessionExtract.entityID).toBe(entityID)
  })

  test("reconciles casing and surrounding whitespace, but not scope", () => {
    const canonical = entityID("global", "Acme Robotics")
    expect(entityID("global", "  acme ROBOTICS  ")).toBe(canonical)
    expect(entityID("session:x", "Acme Robotics")).not.toBe(canonical)
  })

  test("cannot collide with a passage id — different namespaces", () => {
    // A document named X and a passage of X are different nodes, so one can never overwrite the
    // other. The prefixes are what guarantee it.
    expect(entityID("global", "EDDS rules")).toMatch(/^ent_x[0-9a-f]{24}$/)
    expect(passageID("EDDS rules", "some text")).toMatch(/^mem_p[0-9a-f]{24}$/)
  })

  test("different names stay different (negative control)", () => {
    expect(entityID("global", "Mercury")).not.toBe(entityID("global", "Mercury Project"))
  })
})
