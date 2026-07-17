import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Kb } from "@novaclaw/core/kb"
import { SessionV2 } from "@novaclaw/core/session"
import { KbTool } from "@novaclaw/core/tool/kb"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { ToolOutputStore } from "@novaclaw/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, toolDefinitions } from "./lib/tool"

// KB-E phase 2 — the kb tool end to end: decode → Kb store fetch → engine → linearized text.
// The repair-loop contract under test: a WRONG query (unknown entity/predicate) settles as
// readable result TEXT the model can act on — never a ToolFailure (reserved for infra).

const sessionID = SessionV2.ID.make("ses_kb_tool_test")

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Kb.node, ToolRegistry.node, ToolRegistry.toolsNode, KbTool.node]),
    [[ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig]],
  ),
)

const FIXTURE = [
  { subject: "korvath-dreyne", predicate: "name", object: "Korvath Dreyne" },
  { subject: "korvath-dreyne", predicate: "type", object: "musician" },
  { subject: "korvath-dreyne", predicate: "member_of", object: "The Velvet Corvids" },
  { subject: "the-velvet-corvids", predicate: "name", object: "The Velvet Corvids" },
  { subject: "the-velvet-corvids", predicate: "type", object: "band" },
  { subject: "the-velvet-corvids", predicate: "origin_city", object: "Duskport" },
  { subject: "mira-solenne", predicate: "name", object: "Mira Solenne" },
  { subject: "mira-solenne", predicate: "member_of", object: "The Velvet Corvids" },
] as const

const seed = Effect.gen(function* () {
  const kb = yield* Kb.Service
  yield* kb.populate(FIXTURE.map((fact) => ({ ...fact, relation: "core" as const })))
})

const call = (input: unknown, id = "call-kb") => ({
  sessionID,
  ...toolIdentity,
  call: { type: "tool-call" as const, id, name: KbTool.name, input },
})

const text = (result: { type: string; value: unknown }): string => {
  expect(result.type).toBe("text")
  return String(result.value)
}

describe("KbTool", () => {
  it.effect("registers and answers get/neighbors over seeded facts", () =>
    Effect.gen(function* () {
      yield* seed
      const registry = yield* ToolRegistry.Service
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toContain(KbTool.name)

      const got = text(yield* executeTool(registry, call({ op: "get", entity: "The Velvet Corvids" })))
      expect(got).toContain("origin_city: Duskport")

      const members = text(
        yield* executeTool(
          registry,
          call({ op: "neighbors", entity: "The Velvet Corvids", predicate: "member_of", direction: "in" }),
        ),
      )
      expect(members).toBe("Korvath Dreyne\nMira Solenne")
    }),
  )

  it.effect("joins a 2-hop match through the name→slug indirection", () =>
    Effect.gen(function* () {
      yield* seed
      const registry = yield* ToolRegistry.Service
      const city = text(
        yield* executeTool(
          registry,
          call({
            op: "match",
            find: ["?city"],
            where: [
              ["Korvath Dreyne", "member_of", "?band"],
              ["?band", "origin_city", "?city"],
            ],
          }),
        ),
      )
      expect(city).toBe("Duskport")
    }),
  )

  it.effect("an unknown entity settles as repair text with nearest labels, not a failure", () =>
    Effect.gen(function* () {
      yield* seed
      const registry = yield* ToolRegistry.Service
      const repair = text(yield* executeTool(registry, call({ op: "get", entity: "The Velvet Corvid" })))
      expect(repair).toContain("Unknown entity")
      expect(repair).toContain("The Velvet Corvids")
    }),
  )

  it.effect("retracted facts are invisible to the tool", () =>
    Effect.gen(function* () {
      yield* seed
      const kb = yield* Kb.Service
      const [fact] = yield* kb.query({ subject: "the-velvet-corvids", predicate: "origin_city" })
      yield* kb.retract(fact!.id)

      const registry = yield* ToolRegistry.Service
      const got = text(yield* executeTool(registry, call({ op: "get", entity: "The Velvet Corvids" })))
      expect(got).not.toContain("origin_city")
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
