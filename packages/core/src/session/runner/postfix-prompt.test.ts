import { describe, expect, test } from "bun:test"
import { LLM, Message, Model, SystemPart } from "@novaclaw/llm"
import * as OpenAIChat from "@novaclaw/llm/protocols/openai-compatible-chat"
import { PostfixPrompt } from "./postfix-prompt"

describe("derived requests preserve the provider prefix", () => {
  test("keeps system, tools, and every existing message before the final instruction", () => {
    const base = LLM.request({
      model: Model.make({ id: "model", provider: "provider", route: OpenAIChat.route }),
      system: [SystemPart.make("stable system")],
      messages: [Message.user("old evidence"), Message.assistant("old answer")],
      tools: [{ name: "read", description: "read", inputSchema: { type: "object" } }] as never,
    })
    const derived = PostfixPrompt.append(base, "Summarize the evidence above.", {
      maxTokens: 512,
      disableTools: true,
    })

    expect(derived.system).toEqual(base.system)
    expect(derived.tools).toEqual(base.tools)
    expect(derived.messages.slice(0, -1)).toEqual([...base.messages])
    expect(derived.messages.at(-1)).toEqual(Message.user("Summarize the evidence above."))
    expect(derived.toolChoice?.type).toBe("none")
    expect(derived.callableTools).toEqual([])
  })
})
