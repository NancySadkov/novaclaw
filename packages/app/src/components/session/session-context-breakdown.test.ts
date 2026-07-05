import { describe, expect, test } from "bun:test"
import type { SessionMessage } from "@novaclaw/sdk/v2/client"
import { estimateSessionContextBreakdown } from "./session-context-breakdown"

const user = (id: string, text: string): SessionMessage =>
  ({
    id,
    type: "user",
    text,
    time: { created: 1 },
  }) as unknown as SessionMessage

const assistant = (id: string, text: string): SessionMessage =>
  ({
    id,
    type: "assistant",
    agent: "build",
    model: { providerID: "dgx-spark", modelID: "qwen3.6-35b" },
    content: [{ type: "text", id: `${id}-t`, text }],
    time: { created: 1 },
  }) as unknown as SessionMessage

describe("estimateSessionContextBreakdown", () => {
  test("estimates tokens and keeps remaining tokens as other", () => {
    const messages = [user("u1", "hello world"), assistant("a1", "assistant response")]

    const output = estimateSessionContextBreakdown({
      messages,
      input: 20,
      systemPrompt: "system prompt",
    })

    const map = Object.fromEntries(output.map((segment) => [segment.key, segment.tokens]))
    expect(map.system).toBe(4)
    expect(map.user).toBe(3)
    expect(map.assistant).toBe(5)
    expect(map.other).toBe(8)
  })

  test("scales segments when estimates exceed input", () => {
    const messages = [user("u1", "x".repeat(400)), assistant("a1", "y".repeat(400))]

    const output = estimateSessionContextBreakdown({
      messages,
      input: 10,
      systemPrompt: "z".repeat(200),
    })

    const total = output.reduce((sum, segment) => sum + segment.tokens, 0)
    expect(total).toBeLessThanOrEqual(10)
    expect(output.every((segment) => segment.width <= 100)).toBeTrue()
  })
})
