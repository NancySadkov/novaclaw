import { describe, expect, test } from "bun:test"
import { ComputerVerify as CV } from "./verify"

const obs = (kind: Parameters<typeof CV.expectationFor>[0], before: string, after: string, animated?: boolean) =>
  ({ kind, before, after, ...(animated === undefined ? {} : { animated }) }) satisfies CV.Observation

// The case this module was written for, reproduced as a test. On 2026-08-06 a correctly-grounded
// click in the substrate did nothing: DOSBox's autolock had captured the mouse, so the host pointer
// moved exactly where told while the game's cursor sat ~250 px away. Grounder right, pointer right,
// process alive, exit 0 — and the screen byte-identical. That last fact was the only witness.
describe("the autolock signature: a clean command that changed nothing", () => {
  test("a click that leaves the screen identical is reported, not passed over", () => {
    const verdict = CV.judge(obs("click", "sha:aaa", "sha:aaa"))
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.kind).toBe("no-visible-effect")
  })

  test("the advice names the measured cause and says re-ground, not retry", () => {
    // A planner that retries the identical point forever is the failure mode this text exists to
    // prevent; naming autolock matters because it is invisible in every other diagnostic.
    const verdict = CV.judge(obs("click", "a", "a"))
    if (verdict.ok) return
    expect(verdict.advice).toContain("autolock")
    expect(verdict.advice).toContain("re-ground")
  })

  test("every input action gets the same scrutiny", () => {
    for (const kind of ["click", "double_click", "type", "key", "scroll"] as const)
      expect(CV.judge(obs(kind, "x", "x")).ok).toBe(false)
  })

  test("and a visible effect on a STILL screen is the positive signal", () => {
    for (const kind of ["click", "double_click", "type", "key", "scroll"] as const) {
      const verdict = CV.judge(obs(kind, "before", "after"))
      expect(verdict.ok).toBe(true)
      if (verdict.ok) expect(verdict.kind).toBe("changed")
    }
  })
})

describe("an observation that changes the screen means something ELSE is driving it", () => {
  test("a screenshot or cursor read should leave the screen alone", () => {
    for (const kind of ["screenshot", "cursor"] as const) {
      const verdict = CV.judge(obs(kind, "same", "same"))
      expect(verdict.ok).toBe(true)
      if (verdict.ok) expect(verdict.kind).toBe("stable")
    }
  })

  test("if it moved anyway, say so — every grounded coordinate is now stale", () => {
    const verdict = CV.judge(obs("screenshot", "frame-1", "frame-2"))
    expect(verdict.ok).toBe(false)
    if (verdict.ok) return
    expect(verdict.kind).toBe("changed-while-observing")
    expect(verdict.advice).toContain("stale")
  })
})

describe("a move concludes nothing, on purpose", () => {
  test("hover states legitimately change pixels — and legitimately do not", () => {
    for (const [b, a] of [
      ["x", "x"],
      ["x", "y"],
    ] as const) {
      const verdict = CV.judge(obs("move", b, a))
      expect(verdict.ok).toBe(true)
      if (verdict.ok) expect(verdict.kind).toBe("inconclusive")
    }
  })
})

describe("the expectation table is complete and deliberate", () => {
  test("every action kind has an expectation — no silent hole in the switch", () => {
    const kinds = ["screenshot", "cursor", "move", "click", "double_click", "type", "key", "scroll"] as const
    for (const kind of kinds) expect(CV.expectationFor(kind)).toBeDefined()
  })

  test("🔴 inputs are `should-change`, never `must-change`", () => {
    // Plenty of honest inputs change nothing: clicking an already-selected item, typing a key a field
    // ignores, scrolling a list already at the end. Treating those as hard failures would make the
    // loop abandon correct work, so the verdict is a suspicion the planner weighs.
    expect(CV.expectationFor("click")).toBe("should-change")
    expect(CV.expectationFor("type")).toBe("should-change")
  })

  test("observations are the only `must-not-change` kinds", () => {
    expect(CV.expectationFor("screenshot")).toBe("must-not-change")
    expect(CV.expectationFor("cursor")).toBe("must-not-change")
    expect(CV.expectationFor("move")).toBe("may-change")
  })
})

// 🔴 The regression that refuted the module's first draft, taken from the REAL frames of the failed
// Master of Magic click. The digests differ -- the game's attract mode was scrolling credits -- so a
// naive "changed means it worked" called that very failure a success. The whole point of the
// `animated` flag is that this case must not read as confirmation.
describe("a changed screen proves nothing when the screen animates itself", () => {
  // Actual sha256 prefixes of mom2.png (before the click) and mom3.png (after it did nothing).
  const BEFORE = "6e52faf7b57c62d6"
  const AFTER = "aa5a00ee55c3bb6f"

  test("the real failed click: DIFFERENT digests, and it must not be read as success", () => {
    expect(BEFORE).not.toBe(AFTER)
    const verdict = CV.judge(obs("click", BEFORE, AFTER, true))
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.kind).toBe("inconclusive")
  })

  test("without the flag the same frames read as `changed` — which is why measuring matters", () => {
    // Not a bug, a documented default: an unmeasured screen gets the optimistic reading. This test
    // exists so the cost of skipping the measurement is visible rather than surprising.
    const verdict = CV.judge(obs("click", BEFORE, AFTER))
    if (verdict.ok) expect(verdict.kind).toBe("changed")
  })

  test("an UNCHANGED screen still convicts, and animation makes it stronger", () => {
    // A screen that moves on its own yet is byte-identical after an action is the clearest evidence
    // available that the action did nothing.
    const verdict = CV.judge(obs("click", "same", "same", true))
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.kind).toBe("no-visible-effect")
  })

  test("and an animated screen is not accused of drifting during an observation", () => {
    const verdict = CV.judge(obs("screenshot", "f1", "f2", true))
    expect(verdict.ok).toBe(true)
    if (verdict.ok) expect(verdict.kind).toBe("inconclusive")
  })
})
