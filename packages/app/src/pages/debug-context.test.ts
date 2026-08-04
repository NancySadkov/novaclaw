import { describe, expect, test } from "bun:test"
import type { SessionMessage } from "@novaclaw/sdk/v2/client"
import { contextTurns, formatContextFinding, formatContextTokens } from "./debug-context"

type Assistant = Extract<SessionMessage, { type: "assistant" }>

const assistant = (
  id: string,
  created: number,
  findings: NonNullable<Assistant["context"]>["findings"] = [],
): Assistant => ({
  id,
  type: "assistant",
  agent: "build",
  model: { providerID: "dgx-spark", id: "qwen3.6-35b" },
  content: [],
  time: { created },
  context: { window: 32_000, estimatedTokens: 8_000, droppedMessages: 0, elidedOutputs: 0, findings },
})

describe("Debug context findings", () => {
  test("selects only packed assistant turns, newest first", () => {
    const messages: SessionMessage[] = [
      assistant("old", 1),
      { id: "user", type: "user", text: "hello", time: { created: 3 } },
      { ...assistant("unpacked", 4), context: undefined },
      assistant("new", 5),
    ]
    expect(contextTurns(messages, 1).map((message) => message.id)).toEqual(["new"])
  })

  test("explains duplicate output as an action, never an opaque score", () => {
    const text = formatContextFinding({
      kind: "duplicate-tool-output",
      tool: "read",
      target: "notes/plan.md",
      occurrences: 3,
      repeatedTokens: 4_250,
      elided: true,
    })
    expect(text).toBe(
      "read output for “notes/plan.md” appeared 3 times; NovaClaw folded the repeats, saving about 4.3k repeated tokens.",
    )
    expect(text).not.toMatch(/score|health/i)
  })

  test("explains dominant output in plain language", () => {
    expect(formatContextFinding({ kind: "dominant-tool-output", tool: "browser", tokens: 12_800, percent: 64.2 })).toBe(
      "browser output occupies 64.2% of this turn’s context (about 13k tokens).",
    )
  })

  test("explains a typed share as a concrete action and names protected overflow", () => {
    expect(
      formatContextFinding({
        kind: "category-budget",
        category: "tool_output",
        limitTokens: 8_000,
        beforeTokens: 12_400,
        afterTokens: 7_900,
        affectedMessages: 2,
        protected: false,
      }),
    ).toBe("Tool output was reduced from about 12k to 7.9k tokens to stay inside its 8k-token share.")
    expect(
      formatContextFinding({
        kind: "category-budget",
        category: "system",
        limitTokens: 8_000,
        beforeTokens: 9_200,
        afterTokens: 9_200,
        affectedMessages: 0,
        protected: true,
      }),
    ).toContain("kept on purpose")
  })

  test("formats small and large token counts for scanning", () => {
    expect(formatContextTokens(942)).toBe("942")
    expect(formatContextTokens(1_240)).toBe("1.2k")
    expect(formatContextTokens(12_800)).toBe("13k")
  })
})
