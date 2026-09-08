import { describe, expect, test } from "bun:test"
import { Token } from "@novaclaw/core/util/token"
import { createState, generatedDelta, note, snapshot } from "./live-rate"

describe("live-rate (Chats ps telemetry)", () => {
  test("accumulates chars into ~tokens", () => {
    const state = createState()
    note(state, 400, 1000)
    expect(snapshot(state, 1500).approxTokens).toBe(Token.estimateFromChars(400))
  })

  test("t/s reflects the recent window, not the whole run", () => {
    const state = createState()
    // 4000 chars over ~4s → ~1000 chars/s → 250 t/s at 4 chars/token.
    for (let i = 0; i < 16; i++) note(state, 250, 1000 + i * 250)
    const { tps } = snapshot(state, 1000 + 16 * 250)
    expect(tps).toBeGreaterThan(150)
    expect(tps).toBeLessThan(350)
  })

  test("keeps sub-one rates precise for the shared display formatter", () => {
    const state = createState()
    note(state, 4, 1000)
    expect(snapshot(state, 5000).tps).toBe(0.25)
  })

  test("a quiet stream decays to 0 t/s while total tokens stay", () => {
    const state = createState()
    note(state, 4000, 1000)
    const later = snapshot(state, 1000 + 60_000)
    expect(later.tps).toBe(0)
    expect(later.approxTokens).toBe(1000)
  })

  test("burst coalescing keeps the sample ring bounded", () => {
    const state = createState()
    for (let i = 0; i < 1000; i++) note(state, 4, 1000 + i) // 1000 notes within 1s
    expect(state.samples.length).toBeLessThan(10)
    expect(state.chars).toBe(4000)
  })

  test("zero/negative deltas are ignored", () => {
    const state = createState()
    note(state, 0, 1000)
    note(state, -5, 1000)
    expect(state.chars).toBe(0)
    expect(snapshot(state, 2000).approxTokens).toBe(0)
  })

  test("counts every model-generated stream, including file writes and compaction", () => {
    const sessionID = "ses_worker"
    expect(generatedDelta({ type: "session.next.text.delta", properties: { sessionID, delta: "answer" } })).toEqual({
      sessionID,
      chars: 6,
      source: "generation",
    })
    expect(
      generatedDelta({ type: "session.next.reasoning.delta", properties: { sessionID, delta: "thinking" } }),
    ).toEqual({ sessionID, chars: 8, source: "generation" })
    expect(
      generatedDelta({ type: "session.next.tool.input.delta", properties: { sessionID, delta: "huge markdown" } }),
    ).toEqual({ sessionID, chars: 13, source: "generation" })
    expect(
      generatedDelta({ type: "session.next.compaction.delta", properties: { sessionID, text: "summary" } }),
    ).toEqual({ sessionID, chars: 7, source: "compaction" })
    const state = createState()
    note(state, 40, 1_000, "compaction")
    expect(snapshot(state, 2_000).approxCompactionTokens).toBe(10)
  })

  test("does not mistake tool results or malformed events for model generation", () => {
    expect(
      generatedDelta({ type: "session.next.tool.progress", properties: { sessionID: "ses_worker", delta: "output" } }),
    ).toBeUndefined()
    expect(
      generatedDelta({
        type: "session.next.compaction.delta",
        properties: { sessionID: "ses_worker", delta: "wrong" },
      }),
    ).toBeUndefined()
  })
})
