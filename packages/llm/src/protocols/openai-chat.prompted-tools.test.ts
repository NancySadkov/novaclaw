import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { request as makeRequest } from "../llm"
import { Model, ToolDefinition } from "../schema"
import { OpenAIChat } from "./openai-chat"
import { PromptedTools } from "./utils/prompted-tools"
import { recoverToolCallsFromText } from "./utils/tool-recovery"

/**
 * The PROMPTED tool channel: how tools reach an endpoint whose native channel does not work.
 *
 * The failure this guards is a body that omits `tools` while saying nothing about them — a turn in
 * which the agent simply cannot act, and which looks from the outside like a model that refused.
 */

const tool = ToolDefinition.make({
  name: "write",
  description: "Write a file.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" }, content: { type: "string" } },
    required: ["path", "content"],
  },
})

// Same shape as `openai-chat.body.test.ts`: the real request builder and the real body lowering, no
// live model. The `prompt` is required — `Protocol.make` refuses a body whose conversation lowered
// to empty.
const request = (over: Record<string, unknown> = {}) =>
  makeRequest({
    model: Model.make({ id: "qwen3.6-35b", provider: "dgx-spark", route: OpenAIChat.route }),
    system: "You are Nova.",
    prompt: "hi",
    tools: [tool],
    ...over,
  } as never)

const body = (over: Record<string, unknown> = {}) =>
  Effect.runSync(OpenAIChat.protocol.body.from(request(over))) as Record<string, unknown>

describe("the prompted tool channel", () => {
  test("native is the default — the body still carries the tools array", () => {
    const native = body()
    expect(Array.isArray(native["tools"])).toBe(true)
    expect(String(native["messages"] && JSON.stringify(native["messages"]))).not.toContain("# Tools")
  })

  test("🔴 prompted omits `tools` AND describes them — never one without the other", () => {
    // The two halves are driven by one test in `fromRequest`. Split, the failure is silent: a body
    // with no tools and no description produces a turn where the agent cannot act, and nothing in
    // the response says why.
    const prompted = body({ toolChannel: "prompted" })
    expect(prompted["tools"]).toBeUndefined()
    const system = (prompted["messages"] as Array<{ role: string; content: string }>)[0]
    expect(system?.role).toBe("system")
    expect(system?.content).toContain("You are Nova.")
    expect(system?.content).toContain("# Tools")
    expect(system?.content).toContain("write")
    // The schema goes in verbatim; a prose rendering would be free to drift from what the executor
    // validates against.
    expect(system?.content).toContain('"required":["path","content"]')
  })

  test("prompted drops `tool_choice` too — there is nothing on the wire to choose between", () => {
    const prompted = body({ toolChannel: "prompted", toolChoice: { type: "tool", name: "write" } as never })
    expect(prompted["tool_choice"]).toBeUndefined()
  })

  test("🔴 the description is added as ONE system message, not a second one", () => {
    // A second system message is a shape several endpoints reject outright, and one an
    // alternating-role chat template can silently drop — taking the tools with it.
    const prompted = body({ toolChannel: "prompted" })
    const systems = (prompted["messages"] as Array<{ role: string }>).filter((m) => m.role === "system")
    expect(systems).toHaveLength(1)
  })

  test("a prompted request with no system prompt still gets the section", () => {
    const prompted = body({ toolChannel: "prompted", system: [] })
    const system = (prompted["messages"] as Array<{ role: string; content: string }>)[0]
    expect(system?.content).toContain("# Tools")
  })

  test("no tools means no section — instructions for zero tools can only be misapplied", () => {
    expect(PromptedTools.promptedToolsSection([])).toBeUndefined()
  })

  test("🔴 what the prompt ASKS for is what the recovery reads back", () => {
    // The round trip that makes the channel real. The instruction asks for bare JSON — measured,
    // because a server's own tool parser eats `<tool_call>` blocks and returns nothing — and the
    // decoder's whitelist-gated recovery is what pulls it out again. If these two ever disagree the
    // model answers correctly and the turn still drops the call.
    expect(PromptedTools.INSTRUCTION).toContain('{"name":"<tool name>","arguments":{')
    expect(PromptedTools.INSTRUCTION).not.toContain("<tool_call>")
    const answer = '{"name":"write","arguments":{"path":"a.txt","content":"hi"}}'
    const [call] = recoverToolCallsFromText(answer, ["write"])
    expect(call?.name).toBe("write")
    expect(JSON.parse(call!.arguments)).toEqual({ path: "a.txt", content: "hi" })
  })

  test("🔴 the MODEL can carry the channel, so a config override reaches it", () => {
    // The self-healing path: an operator (or a measurement) writes the channel onto the model entry
    // and every turn picks it up, with no code change and no restart. Without this the probe could
    // only ever recommend.
    const prompted = body({
      model: Model.make({
        id: 'qwen3.6-35b',
        provider: 'dgx-spark',
        route: OpenAIChat.route,
        compatibility: { toolChannel: 'prompted' },
      }),
    })
    expect(prompted['tools']).toBeUndefined()
    expect((prompted['messages'] as Array<{ content: string }>)[0]?.content).toContain('# Tools')
  })

  test("🔴 an explicit request channel BEATS the model's — one call, one way", () => {
    // A probe or a repair says "this call, this way"; the model's value is the standing answer for
    // every other turn. Reversed, a single diagnostic call could not escape a wrong recorded value.
    const native = body({
      model: Model.make({
        id: 'qwen3.6-35b',
        provider: 'dgx-spark',
        route: OpenAIChat.route,
        compatibility: { toolChannel: 'prompted' },
      }),
      toolChannel: 'native',
    })
    expect(Array.isArray(native['tools'])).toBe(true)
  })

  test("🔴 `tools` stays populated on the request — it IS the recovery whitelist", () => {
    // Emptying it would look equivalent (the wire body omits them either way) and would quietly let
    // a model name anything at all, since the decoder builds `allowedToolNames` from this array.
    expect(request({ toolChannel: "prompted" }).tools.map((item) => item.name)).toEqual(["write"])
  })
})
