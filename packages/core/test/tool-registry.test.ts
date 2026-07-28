import { describe, expect, test } from "bun:test"
import { AgentV2 } from "@novaclaw/core/agent"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionMessage } from "@novaclaw/core/session/message"
import { Tool } from "@novaclaw/core/tool/tool"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { ToolOutputStore } from "@novaclaw/core/tool-output-store"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "./lib/effect"
import { settleTool } from "./lib/tool"

// The unknown-tool horizon (ported from github.com/NancySadkov/novaclaw PR #4, @DassaultFalconKing).
//
// Registry lifecycle/staleness is covered by session-runner-tool-registry.test.ts; this file covers only
// what a model is told when it calls a name that was never advertised.

const outputStore = Layer.mock(ToolOutputStore.Service, {
  bound: (input) => Effect.succeed({ output: input.output, outputPaths: [] }),
})
const it = testEffect(AppNodeBuilder.build(ToolRegistry.node, [[ToolOutputStore.node, outputStore]]))

const sessionID = SessionV2.ID.make("ses_unknown_tool")
const identity = { agent: AgentV2.ID.make("build"), assistantMessageID: SessionMessage.ID.make("msg_unknown_tool") }
const call = (name: string): ToolRegistry.ExecuteInput => ({
  sessionID,
  ...identity,
  call: { type: "tool-call", id: `call-${name}`, name, input: {} },
})

const echo = () =>
  Tool.make({
    description: "Echo",
    input: Schema.Struct({}),
    output: Schema.Struct({ ok: Schema.Boolean }),
    execute: () => Effect.succeed({ ok: true }),
  })

const message = (input: ToolRegistry.Settlement) => {
  expect(input.result.type).toBe("error")
  return String(input.result.value)
}

describe("unknownToolMessage", () => {
  test("names every advertised tool, in advertised order", () => {
    const text = ToolRegistry.unknownToolMessage("frobnicate", ["read", "bash", "write"])
    expect(text).toBe(
      "Unknown tool: frobnicate. Nothing ran. Available tools: read, bash, write. " +
        "Use one of these exact advertised names — do not invent a tool or write a call as text.",
    )
  })

  // Negative control: the empty registry must NOT claim tools exist, and must not dangle an empty list.
  test("says plainly that there is nothing to call when no tool is advertised", () => {
    const text = ToolRegistry.unknownToolMessage("read", [])
    expect(text).toBe(
      "Unknown tool: read. Nothing ran — no tools are available in this turn. Do not invent a tool or " +
        "write a call as text; answer in your reply instead.",
    )
    expect(text).not.toContain("Available tools")
    expect(text).not.toContain("Did you mean")
  })

  test("offers the near miss the model actually produces", () => {
    // Suffix ("read_file" for "read"), separator ("read_hex" for "read-hex" — our own names mix both),
    // case/word-break ("WebSearch"), and truncation ("todo" for "todowrite").
    const tools = ["read", "read-hex", "write", "websearch", "todowrite", "js"]
    const hint = (name: string) => ToolRegistry.closestToolName(name, tools)
    expect(hint("read_file")).toBe("read")
    expect(hint("read_hex")).toBe("read-hex")
    expect(hint("readHexDump")).toBe("read-hex")
    expect(hint("WebSearch")).toBe("websearch")
    expect(hint("web_search")).toBe("websearch")
    expect(hint("todo")).toBe("todowrite")
    expect(hint("js_run")).toBe("js")
    expect(ToolRegistry.unknownToolMessage("read_file", tools)).toContain('Did you mean "read"?')
  })

  test("stays silent rather than guessing", () => {
    // A tie is a coin flip, an unrelated name has no answer, and a 1-char stub is not evidence.
    expect(ToolRegistry.closestToolName("web", ["webfetch", "websearch"])).toBeUndefined()
    expect(ToolRegistry.closestToolName("frobnicate", ["read", "bash"])).toBeUndefined()
    expect(ToolRegistry.closestToolName("r", ["read"])).toBeUndefined()
    expect(ToolRegistry.closestToolName("", ["read"])).toBeUndefined()
    expect(ToolRegistry.unknownToolMessage("frobnicate", ["read", "bash"])).not.toContain("Did you mean")
  })

  test("truncates only past the character budget, and says how much it withheld", () => {
    const many = Array.from({ length: 400 }, (_, index) => `tool_${index}`)
    const text = ToolRegistry.unknownToolMessage("nope", many)
    const shown = /\(([0-9]+) of 400\)/.exec(text)?.[1]
    expect(shown).toBeDefined()
    expect(Number(shown)).toBeLessThan(400)
    expect(text).toContain(`and ${400 - Number(shown)} more.`)
    expect(text.length).toBeLessThan(ToolRegistry.UNKNOWN_TOOL_LIST_BUDGET + 300)
    // The stock 28-tool session is well inside the budget, so it is never truncated.
    const stock = Array.from({ length: 28 }, (_, index) => `some_tool_${index}`)
    expect(ToolRegistry.unknownToolMessage("nope", stock)).not.toContain(" more.")
  })

  test("always lists at least one name, even when a single name blows the budget", () => {
    const huge = "x".repeat(ToolRegistry.UNKNOWN_TOOL_LIST_BUDGET + 50)
    expect(ToolRegistry.unknownToolMessage("nope", [huge, "read"])).toContain(`(1 of 2): ${huge}, and 1 more.`)
  })
})

describe("ToolRegistry settlement of an unadvertised name", () => {
  it.effect("hands the model the tools it does have", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ read: echo(), bash: echo(), write: echo() })

      const text = message(yield* settleTool(service, call("read_file")))
      expect(text).toBe(ToolRegistry.unknownToolMessage("read_file", ["read", "bash", "write"]))
      expect(text).toContain('Did you mean "read"?')
      expect(text).toContain("Available tools: read, bash, write.")
    }),
  )

  // Negative control: an empty registry must reach the no-tools branch through the real settle path.
  it.effect("does not invent a horizon when nothing is registered", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service

      expect(message(yield* settleTool(service, call("read")))).toBe(ToolRegistry.unknownToolMessage("read", []))
    }),
  )

  // The listed set is the ADVERTISED set: a tool denied by permission is not offered as a correction.
  it.effect("omits tools the turn's permissions removed", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ read: echo(), write: Tool.withPermission(echo(), "edit") })
      const materialized = yield* service.materialize([{ action: "edit", resource: "*", effect: "deny" }])

      const text = message(yield* materialized.settle(call("write_file")))
      expect(text).toBe(ToolRegistry.unknownToolMessage("write_file", ["read"]))
      expect(text).toContain("Available tools: read.")
      expect(text).not.toContain("Did you mean")
    }),
  )
})
