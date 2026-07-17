import { describe, expect, test } from "bun:test"
import type { SessionMessage } from "@novaclaw/sdk/v2/client"
import { getSessionContext, getSessionTokenTotal } from "./session-context-metrics"

const assistant = (
  id: string,
  tokens: { input: number; output: number; reasoning: number; read: number; write: number },
  cost: number,
  providerID = "openai",
  modelID = "gpt-4.1",
) => {
  return {
    id,
    type: "assistant",
    model: { providerID, id: modelID, variant: "default" },
    content: [],
    cost,
    tokens: {
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning,
      cache: {
        read: tokens.read,
        write: tokens.write,
      },
    },
    time: { created: 1 },
  } as unknown as SessionMessage
}

const user = (id: string) => {
  return {
    id,
    type: "user",
    text: "",
    time: { created: 1 },
  } as unknown as SessionMessage
}

describe("getSessionContext", () => {
  const model = (providerID: string, modelID: string) =>
    providerID === "openai" && modelID === "gpt-4.1" ? { name: "GPT-4.1", limit: { context: 1000 } } : undefined

  test("computes usage from latest assistant with tokens", () => {
    const messages = [
      user("u1"),
      assistant("a1", { input: 0, output: 0, reasoning: 0, read: 0, write: 0 }, 0.5),
      assistant("a2", { input: 300, output: 100, reasoning: 50, read: 25, write: 25 }, 1.25),
    ]
    const providers = [{ id: "openai", name: "OpenAI" }]

    const ctx = getSessionContext(messages, providers, model)

    expect(ctx?.message.id).toBe("a2")
    expect(ctx?.usage).toBe(50)
    expect(ctx?.providerLabel).toBe("OpenAI")
    expect(ctx?.modelLabel).toBe("GPT-4.1")
  })

  test("preserves fallback labels and null usage when model metadata is missing", () => {
    const messages = [assistant("a1", { input: 40, output: 10, reasoning: 0, read: 0, write: 0 }, 0.1, "p-1", "m-1")]
    const providers = [{ id: "p-1" }]

    const ctx = getSessionContext(messages, providers, model)

    expect(ctx?.providerLabel).toBe("p-1")
    expect(ctx?.modelLabel).toBe("m-1")
    expect(ctx?.limit).toBeUndefined()
    expect(ctx?.usage).toBeNull()
  })

  test("recomputes when message array is mutated in place", () => {
    const messages = [assistant("a1", { input: 10, output: 10, reasoning: 10, read: 10, write: 10 }, 0.25)]
    const providers = [{ id: "openai" }]

    const one = getSessionContext(messages, providers, model)
    messages.push(assistant("a2", { input: 100, output: 20, reasoning: 0, read: 0, write: 0 }, 0.75))
    const two = getSessionContext(messages, providers, model)

    expect(one?.message.id).toBe("a1")
    expect(two?.message.id).toBe("a2")
  })

  test("returns undefined when inputs are undefined", () => {
    const ctx = getSessionContext(undefined, undefined)

    expect(ctx).toBeUndefined()
  })

  test("computes stored session token totals", () => {
    expect(
      getSessionTokenTotal({
        input: 10,
        output: 20,
        reasoning: 30,
        cache: { read: 40, write: 50 },
      }),
    ).toBe(150)
  })
})
