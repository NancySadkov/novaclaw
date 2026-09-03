import { describe, expect, test } from "bun:test"
import { reasoningGoesInReceipt, reasoningOpenDefault, toolOpenDefault } from "./reasoning-fold"

describe("reasoningOpenDefault", () => {
  test("collapsed (Normal) stays folded regardless of streaming state", () => {
    expect(reasoningOpenDefault("collapsed", false)).toBe(false)
    expect(reasoningOpenDefault("collapsed", true)).toBe(false)
  })

  test("open (Developer) stays expanded regardless of streaming state", () => {
    expect(reasoningOpenDefault("open", false)).toBe(true)
    expect(reasoningOpenDefault("open", true)).toBe(true)
  })

  test("live (Advanced) is open while streaming, collapsed once complete", () => {
    expect(reasoningOpenDefault("live", false)).toBe(true)
    expect(reasoningOpenDefault("live", true)).toBe(false)
  })
})

describe("toolOpenDefault", () => {
  test("only Developer (open) expands tool cards by default", () => {
    expect(toolOpenDefault("open")).toBe(true)
    expect(toolOpenDefault("collapsed")).toBe(false)
    expect(toolOpenDefault("live")).toBe(false)
  })
})

/**
 * WHERE a settled turn's reasoning lives.
 *
 * 🔴 Owner, 2026-09-03: reasoning rendered beside the Details fold, one row per step, and *"clutters
 * the chat window. Most users will only look at the model reasoning if something is wrong."* Moving
 * it inside is the fix — but the move has a failure mode worse than the clutter, which is what these
 * pin: hand the parts to a receipt that is not going to draw a fold and they are not moved, they are
 * GONE, and a transcript that silently drops the model's reasoning looks exactly like a model that
 * did not reason.
 */
describe("reasoning goes inside the Details receipt", () => {
  test("a normal settled message folds it in", () => {
    expect(reasoningGoesInReceipt({ hasTiming: true })).toBe(true)
    expect(reasoningGoesInReceipt({ half: "work", hasTiming: true })).toBe(true)
  })

  test("NO TIMING means no fold exists — the reasoning stays where it is", () => {
    // `TurnReceipt` draws its <details> only under `Show when={timing()}`. Without this arm the
    // parts would be filtered out of the flow and handed to a component that renders nothing.
    expect(reasoningGoesInReceipt({ hasTiming: false })).toBe(false)
    expect(reasoningGoesInReceipt({ half: "work", hasTiming: false })).toBe(false)
  })

  test("the ANSWER half renders no receipt, so it keeps its own reasoning", () => {
    // A split message puts the receipt with the work; the answer half's chrome is deliberately
    // outside the fold. Folding into a receipt that is not there is the same deletion as above.
    expect(reasoningGoesInReceipt({ half: "answer", hasTiming: true })).toBe(false)
    expect(reasoningGoesInReceipt({ half: "answer", hasTiming: false })).toBe(false)
  })
})
