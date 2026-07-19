import { describe, expect } from "bun:test"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Memory } from "@novaclaw/core/kb-graph/memory"
import { MemoryClient } from "@novaclaw/core/kb-graph/memory-client"
import { SessionV2 } from "@novaclaw/core/session"
import { KbTool } from "@novaclaw/core/tool/kb"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { ToolOutputStore } from "@novaclaw/core/tool-output-store"
import { Effect } from "effect"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, toolDefinitions } from "./lib/tool"

// The memory `kb` tool end to end: decode → MemoryClient → linearized text. Backed by the in-memory
// `stub` (the WASM engine itself is covered by kb-graph-wasm-engine.smoke.ts). The repair-loop
// contract from KB-E carries over: a fruitless query settles as readable result TEXT the model can act
// on — never a ToolFailure (reserved for infra). Tests use distinct query terms so the shared stub
// doesn't cross-contaminate.

const sessionID = SessionV2.ID.make("ses_kb_tool_test")

// One shared in-memory memory client behind MemoryClient.Service (seed + tool ops hit the same store).
const stub = MemoryClient.stub()

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, KbTool.node]), [
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    [Memory.node, MemoryClient.layerWith(stub)],
  ]),
)

const call = (input: unknown, id = "call-kb") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: KbTool.name, input },
})

const text = (result: { type: string; value: unknown }): string => {
  expect(result.type).toBe("text")
  return String(result.value)
}

describe("KbTool (memory)", () => {
  it.effect("registers; remember → search finds it", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect((yield* toolDefinitions(registry)).map((t) => t.name)).toContain(KbTool.name)

      const saved = text(yield* executeTool(registry, call({ op: "remember", text: "The user prefers strict typing", name: "prefs" })))
      expect(saved).toContain("Remembered (mem_")

      const found = text(yield* executeTool(registry, call({ op: "search", query: "strict" })))
      expect(found).toContain("prefs")
      expect(found).toContain("strict typing")
    }),
  )

  it.effect("a fruitless search settles as repair text", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const repair = text(yield* executeTool(registry, call({ op: "search", query: "chromodynamics" })))
      expect(repair).toContain("No memories match")
      expect(repair).toContain("remember")
    }),
  )

  it.effect("session-scoped memory stays out of a global-only search", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      yield* executeTool(registry, call({ op: "remember", text: "note about kangaroos", scope: "session" }))
      expect(text(yield* executeTool(registry, call({ op: "search", query: "kangaroos", scope: "global" })))).toContain("No memories match")
      expect(text(yield* executeTool(registry, call({ op: "search", query: "kangaroos", scope: "session" })))).toContain("kangaroos")
    }),
  )

  it.effect("forget invalidates so it stops surfacing in search", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const saved = text(yield* executeTool(registry, call({ op: "remember", text: "transient fact about zorblatt" })))
      const id = saved.match(/mem_[A-Za-z0-9]+/)?.[0] ?? ""
      expect(id).not.toBe("")
      yield* executeTool(registry, call({ op: "forget", id }))
      expect(text(yield* executeTool(registry, call({ op: "search", query: "zorblatt" })))).toContain("No memories match")
    }),
  )

  it.effect("relate links two remembered memories; neighbors then traverses the link", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const idOf = (out: string) => out.match(/mem_[A-Za-z0-9]+/)?.[0] ?? ""
      const a = idOf(text(yield* executeTool(registry, call({ op: "remember", text: "Ada Lovelace", name: "Ada" }))))
      const b = idOf(text(yield* executeTool(registry, call({ op: "remember", text: "the Analytical Engine notes", name: "Note" }))))
      expect(a).not.toBe("")
      expect(b).not.toBe("")
      // The relationship label is normalized to a clean predicate token.
      const linked = text(yield* executeTool(registry, call({ op: "relate", from: a, to: b, type: "wrote about" })))
      expect(linked).toContain("Linked")
      expect(linked).toContain("wrote_about")
      const nb = text(yield* executeTool(registry, call({ op: "neighbors", id: a })))
      expect(nb).toContain(b)
      expect(nb).toContain("wrote_about")
    }),
  )

  it.effect("neighbors of an unlinked memory points at relate", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const lonely = text(yield* executeTool(registry, call({ op: "remember", text: "an unconnected note about narwhals" }))).match(/mem_[A-Za-z0-9]+/)?.[0] ?? ""
      const nb = text(yield* executeTool(registry, call({ op: "neighbors", id: lonely })))
      expect(nb).toContain("relate")
    }),
  )

  it.effect("schema-invalid input is the one error-typed result class", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, call({ op: "teleport" }))
      expect(result.type).toBe("error")
      expect(String(result.value)).toContain("Invalid tool input")
    }),
  )
})
