import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "@novaclaw/core/config"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { KbDocs } from "@novaclaw/core/kb-docs"
import { SessionV2 } from "@novaclaw/core/session"
import { KbTool } from "@novaclaw/core/tool/kb"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { ToolOutputStore } from "@novaclaw/core/tool-output-store"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool, toolDefinitions } from "./lib/tool"

// KB-V P3 — the kb tool end to end: decode → KbDocs → linearized text. The repair-loop
// contract carries over from KB-E: a fruitless query settles as readable result TEXT the model
// can act on — never a ToolFailure (reserved for infra). No embedding device is configured
// here, so the tool runs the keyword-only path (the vector legs are covered by kb-docs tests).

const sessionID = SessionV2.ID.make("ses_kb_tool_test")

// Location config with no kb.embedding → the tool resolves NO embedder.
const configLayer = Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) }))

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, KbDocs.node, ToolRegistry.node, ToolRegistry.toolsNode, KbTool.node]),
    [
      [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      [Config.node, configLayer],
    ],
  ),
)

const seed = Effect.gen(function* () {
  const kb = yield* KbDocs.Service
  const rust = yield* kb.add({
    title: "Rust memory model",
    text: "Rust ownership rules. Borrowing enforces lifetimes.",
    relation: "core",
    source: "wiki",
  })
  const pasta = yield* kb.add({
    title: "Cooking pasta",
    text: "Boil salted water. Add spaghetti and stir.",
    relation: "staged",
    agent: "chef",
  })
  return { rust: rust.doc, pasta: pasta.doc }
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
  it.effect("registers and chains search → get over seeded documents", () =>
    Effect.gen(function* () {
      const { rust } = yield* seed
      const registry = yield* ToolRegistry.Service
      expect((yield* toolDefinitions(registry)).map((tool) => tool.name)).toContain(KbTool.name)

      const found = text(yield* executeTool(registry, call({ op: "search", query: "borrowing lifetimes" })))
      expect(found).toContain(rust.id)
      expect(found).toContain("Rust memory model")
      expect(found).toContain("core/wiki")

      const got = text(yield* executeTool(registry, call({ op: "get", doc: rust.id })))
      expect(got).toContain("Rust memory model")
      expect(got).toContain("Borrowing enforces lifetimes.")
      expect(got).toContain("source: wiki")
    }),
  )

  it.effect("a fruitless search settles as repair text naming the degraded mode", () =>
    Effect.gen(function* () {
      yield* seed
      const registry = yield* ToolRegistry.Service
      const repair = text(yield* executeTool(registry, call({ op: "search", query: "quantum chromodynamics" })))
      expect(repair).toContain("No matches")
      expect(repair).toContain("Semantic search was unavailable")
      expect(repair).toContain("sources")
    }),
  )

  it.effect("scope walls staged docs out of core searches", () =>
    Effect.gen(function* () {
      const { pasta } = yield* seed
      const registry = yield* ToolRegistry.Service
      const staged = text(yield* executeTool(registry, call({ op: "search", query: "spaghetti", scope: "staged" })))
      expect(staged).toContain(pasta.id)
      const core = text(yield* executeTool(registry, call({ op: "search", query: "spaghetti", scope: "core" })))
      expect(core).not.toContain(pasta.id)
    }),
  )

  it.effect("get on an unknown id and related on a retracted doc return readable repair text", () =>
    Effect.gen(function* () {
      const { pasta } = yield* seed
      const kb = yield* KbDocs.Service
      yield* kb.retract(pasta.id)
      const registry = yield* ToolRegistry.Service
      const missing = text(yield* executeTool(registry, call({ op: "get", doc: "doc_nope" })))
      expect(missing).toContain("doc_nope")
      expect(missing).toContain("search")
      const related = text(yield* executeTool(registry, call({ op: "related", doc: pasta.id })))
      expect(related).toContain("No active document")
    }),
  )

  it.effect("sources aggregates provenance; retracted docs stop matching search", () =>
    Effect.gen(function* () {
      const { pasta } = yield* seed
      const kb = yield* KbDocs.Service
      yield* kb.retract(pasta.id)
      const registry = yield* ToolRegistry.Service
      const sources = text(yield* executeTool(registry, call({ op: "sources" })))
      expect(sources).toContain("wiki · core · 1 docs")
      expect(sources).not.toContain("chef")
      const gone = text(yield* executeTool(registry, call({ op: "search", query: "spaghetti" })))
      expect(gone).toContain("No matches")
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
