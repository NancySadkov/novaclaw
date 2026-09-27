import { describe, expect, test } from "bun:test"
import { AgentV2 } from "@novaclaw/core/agent"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionMessage } from "@novaclaw/core/session/message"
import { Tool } from "@novaclaw/core/tool/tool"
import { ToolRegistry, nativeDefinitions } from "@novaclaw/core/tool/registry"
import { ToolPolicyGate } from "@novaclaw/core/tool-policy-gate"
import { ToolOutputStore } from "@novaclaw/core/tool-output-store"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "./lib/effect"
import { bypassedPolicyGate, settleTool } from "./lib/tool"

/**
 * 🔴 `colleague` IS DISCLOSED IN EVERY SESSION, WHATEVER THE BUDGET SAYS.
 *
 * Measured on the owner's instance, 2026-09-27: Sopitis called `colleague` and got
 * `Deferred tool colleague is not available in this session`, and on another turn the worse
 * `Unknown tool: colleague. Nothing ran. Available tools: define_tool, docs, js, memo_clear, ...`.
 * Owner: it "should always be available for all sessions."
 *
 * ⚠️ WHY THIS NEEDS A TEST, because the first fix was wrong in a subtle way. Adding `colleague` to the
 * PRIORITY list changes only the ORDER the budget spends — the keep-condition exempted exactly two
 * names, so a tight budget still dropped it. A tool that is "prioritised" but still droppable is not
 * available, it is merely less likely to go, and the two were being read as the same thing. Only the
 * exemption is a guarantee.
 *
 * The cost is deliberate and worth stating: `colleague`'s schema is not small, so keeping it disclosed
 * spends budget on every turn forever. That is the trade the owner asked for.
 */
const tool = (name: string, words: number) =>
  ({
    name,
    description: "x ".repeat(words),
    parameters: { type: "object", properties: {} },
  }) as never

const NAMES = (tools: ReadonlyArray<{ name: string }>) => tools.map((t) => t.name)
const has = (definitions: ReadonlyArray<unknown>, budget: number, name: string) =>
  NAMES(nativeDefinitions(definitions as never, budget)).includes(name)

/** A plausible officer tool set: the discovery pair, `colleague`, and a pile of fat tools. */
const fat = Array.from({ length: 12 }, (_, i) => tool(`fat_${i}`, 900))
const discovery = [tool("tool_search", 120), tool("tool_call", 120)]
const colleague = tool("colleague", 800)

const outputStore = Layer.mock(ToolOutputStore.Service, {
  bound: (input) => Effect.succeed({ output: input.output, outputPaths: [] }),
})
const it = testEffect(
  AppNodeBuilder.build(ToolRegistry.node, [
    [ToolOutputStore.node, outputStore],
    [ToolPolicyGate.node, bypassedPolicyGate],
  ]),
)

const sessionID = SessionV2.ID.make("ses_disclosure_budget")
const identity = { agent: AgentV2.ID.make("build"), assistantMessageID: SessionMessage.ID.make("msg_disclosure") }
const call = (name: string): ToolRegistry.ExecuteInput => ({
  sessionID,
  ...identity,
  call: { type: "tool-call", id: `call-${name}`, name, input: {} },
})
const message = (settled: ToolRegistry.Settlement) => {
  expect(settled.result.type).toBe("error")
  return String(settled.result.value)
}
const echo = () =>
  Tool.make({
    description: "Echo",
    input: Schema.Struct({}),
    output: Schema.Struct({ ok: Schema.Boolean }),
    execute: () => Effect.succeed({ ok: true }),
  })

describe("nativeDefinitions — the disclosure budget", () => {
  test("🔴 colleague survives a budget far too small for anything else", () => {
    const definitions = [...discovery, colleague, ...fat]
    // A budget nothing but the two exempt names could ever fit. This is the Sopitis case.
    expect(has(definitions, 1, "colleague")).toBe(true)
    expect(has(definitions, 1, "tool_search")).toBe(true)
    expect(has(definitions, 1, "tool_call")).toBe(true)
  })

  test("the budget still defers the fat tools — this is not 'disclose everything'", () => {
    // Without this the exemption could be satisfied by removing the mechanism, which would make the
    // case above pass for the wrong reason.
    const definitions = [...discovery, colleague, ...fat]
    const disclosed = NAMES(nativeDefinitions(definitions as never, 400))
    expect(disclosed).not.toContain("fat_11")
    expect(disclosed.length).toBeLessThan(definitions.length)
  })

  test("colleague is disclosed even when it is the LAST thing that would fit", () => {
    // Ordering cannot be what saves it: put it last in the input so any budget-driven order would
    // drop it first, and give it a description big enough to blow a modest budget on its own.
    const definitions = [...discovery, ...fat, tool("colleague", 4000)]
    expect(has(definitions, 300, "colleague")).toBe(true)
  })

  test("no budget at all means everything is disclosed — the rule only bites when asked", () => {
    const definitions = [...discovery, colleague, ...fat]
    expect(NAMES(nativeDefinitions(definitions as never))).toHaveLength(definitions.length)
  })
})

/**
 * 🔴 THE OTHER HALF OF THE SAME INVERSION: the horizon a failed call reports.
 *
 * Deferred tools are not DISABLED, they are not SENT (`withDeferred`: "keep a rarely used schema out
 * of every provider request"). Owner, 2026-09-27: *"the calls to it should still be properly executed,
 * instead of having some esoteric execution logic."* An earlier draft of that fix made undisclosed
 * tools run while leaving the reported `Available tools:` list still narrow — so the model that called
 * `colleague` and was refused got told the instance has no such tool, and would reasonably have
 * concluded the product does not do that.
 *
 * These pin the execution contract; `tool-registry.test.ts` pins the horizon. Both are the same rule
 * read at two seams, which is why they live in two files rather than one invented helper.
 */
describe("an installed tool runs whether or not its schema was disclosed", () => {
  it.effect("settles a deferred tool called directly, with nothing discovered", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ read: echo(), rare: Tool.withDeferred(echo()) })
      const materialized = yield* service.materialize()

      // The schema still costs the request nothing — that half of `withDeferred` is untouched.
      expect(materialized.definitions.map((definition) => definition.name)).toEqual(["read"])
      expect((yield* materialized.settle(call("rare"))).result).toEqual({ type: "json", value: { ok: true } })
    }),
  )

  it.effect("still refuses a tool the permission ruleset withdrew — the real gate, unchanged", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ read: echo(), rare: Tool.withDeferred(echo()) })
      // A `deny`d tool is removed from the map, so nothing here can reach it. This is the assertion
      // that keeps the change above from being read as a permission change.
      const denied = yield* service.materialize([{ action: "rare", resource: "*", effect: "deny" }])

      expect(message(yield* denied.settle(call("rare")))).toContain("Available tools: read.")
    }),
  )

  it.effect("names an undisclosed tool in the horizon, because it can in fact be called", () =>
    Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({ read: echo(), rare: Tool.withDeferred(echo()) })

      // The list is the same inversion read from the other side. `rare` is not sent to the model,
      // so a horizon that omitted it would report a capability the instance really has as missing.
      expect(message(yield* settleTool(service, call("nosuchtool")))).toContain("rare")
    }),
  )
})
