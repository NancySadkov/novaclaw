import { describe, expect, test } from "bun:test"
import path from "node:path"
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

describe("setDirectory — which folder the set is actually in", () => {
  // 🔴 THE MEASURED DEFECT, reproduced. The drive listed the SESSION's cwd, which held two
  // non-directory entries, so `available` was 2 for a 40-, 100- AND 400-file corpus alike — and it
  // then told a model that had opened all 100 images to "open these 2 next: novaclaw, run.log".
  test("derives the corpus folder from the paths the model opened", () => {
    const opened = Array.from({ length: 100 }, (_, i) => `C:/x/tmp/batch-corpus-100/icon_${i}.png`)
    expect(UnfinishedSet.setDirectory(opened)).toBe("C:/x/tmp/batch-corpus-100")
  })
  // ⚠️ ALL-backslash on purpose. A mixed list lets the forward-slash path carry the assertion
  // and the test passes with normalisation DELETED — verified by poisoning it. Every path here
  // needs normalising, so removing it yields `undefined` and this goes red.
  test("normalises separators — a win32 transcript uses backslashes throughout", () => {
    expect(UnfinishedSet.setDirectory(["C:\\x\\corpus\\a.png", "C:\\x\\corpus\\b.png"])).toBe("C:/x/corpus")
  })
  // ⚠️ MODAL, not first. One stray read outside the corpus — a README, the model's own notes — must
  // not relocate the whole set.
  test("a stray read outside the corpus does not move the set", () => {
    const opened = ["C:/x/README.md", ...Array.from({ length: 9 }, (_, i) => `C:/x/corpus/i${i}.png`)]
    expect(UnfinishedSet.setDirectory(opened)).toBe("C:/x/corpus")
  })

  // ⚠️ The caller falls back to the session cwd here, which is the OLD behaviour — deliberately
  // unchanged, because the zero-opened branch exists for a measured failure and the showstopper's
  // own case needs `asksForSet` tightened too. Two defects, two fixes.
  test("nothing opened yields undefined, so the caller keeps the old behaviour", () => {
    expect(UnfinishedSet.setDirectory([])).toBeUndefined()
  })

  test("bare filenames with no directory component yield undefined", () => {
    expect(UnfinishedSet.setDirectory(["a.png", "b.png"])).toBeUndefined()
  })

  test("a relative path keeps its directory", () => {
    expect(UnfinishedSet.setDirectory(["tmp/corpus/a.png", "tmp/corpus/b.png"])).toBe("tmp/corpus")
  })

  test("resolves a relative corpus against the session location", () => {
    const location = path.resolve("project-root")
    expect(UnfinishedSet.resolveSetDirectory(location, ["tmp/corpus/a.png", "tmp/corpus/b.png"])).toBe(
      path.join(location, "tmp", "corpus"),
    )
  })

  test("keeps an absolute corpus authoritative over the session location", () => {
    const corpus = path.resolve("elsewhere", "corpus")
    expect(UnfinishedSet.resolveSetDirectory(path.resolve("project-root"), [path.join(corpus, "a.png")])).toBe(corpus)
  })
})
