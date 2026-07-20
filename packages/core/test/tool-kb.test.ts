import { describe, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import nodePath from "node:path"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Memory } from "@novaclaw/core/kb-graph/memory"
import { MemoryClient } from "@novaclaw/core/kb-graph/memory-client"
import { SessionV2 } from "@novaclaw/core/session"
import { KbTool } from "@novaclaw/core/tool/kb"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { ToolOutputStore } from "@novaclaw/core/tool-output-store"
import { Effect, Layer } from "effect"
import { Location } from "@novaclaw/core/location"
import { PermissionV2 } from "@novaclaw/core/permission"
import { AbsolutePath } from "@novaclaw/core/schema"
import { location } from "./fixture/location"
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

// `ingest` reads a real file through LocationMutation, so the tool now needs a Location to resolve
// relative paths against.
const workdir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "kb-tool-"))
const locationLayer = Layer.succeed(Location.Service, Location.Service.of(location({ directory: AbsolutePath.make(workdir) })))

// Ingest reads a real file, so it must ride the permission gate like any other read. Record the
// assertions so the test can PROVE the gate fires rather than assuming it.
const permissionAsserts: { action: string; resources?: readonly string[] }[] = []
const permissionLayer = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: (input) => Effect.sync(() => void permissionAsserts.push(input as never)),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, KbTool.node]), [
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    [Memory.node, MemoryClient.layerWith(stub)],
    [Location.node, locationLayer],
    [PermissionV2.node, permissionLayer],
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

  it.effect("ingest: a document becomes searchable passages, without entering context", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      fs.writeFileSync(
        nodePath.join(workdir, "manual.txt"),
        ["D20 ATTACK", "1. Miss and actor gains Disadvantage", "", "BRACED", "Spend 10 XP (5 if CLEVER) to gain BRACED."].join(String.fromCharCode(10)),
      )
      permissionAsserts.length = 0
      const first = text(yield* executeTool(registry, call({ op: "ingest", path: "manual.txt" })))
      expect(first).toContain("Ingested")
      expect(first).toContain("manual.txt")
      // Reading a user's file into memory must be permission-gated, like any other read.
      expect(permissionAsserts.some((a) => a.action === KbTool.name)).toBe(true)

      // The point of ingest: the document never entered the model's context, yet is now retrievable.
      expect(text(yield* executeTool(registry, call({ op: "search", query: "BRACED" })))).toContain("BRACED")

      // Content-addressed passage ids ⇒ re-ingesting the same document must not DUPLICATE it...
      const before = (yield* stub.list({ limit: 1000 })).length
      const second = text(yield* executeTool(registry, call({ op: "ingest", path: "manual.txt" })))
      expect((yield* stub.list({ limit: 1000 })).length).toBe(before)
      // ...AND must not CLAIM it stored anything. Asserting only the row count let a false report
      // ship: the tool counted successful addMemory calls, but a duplicate id succeeds without
      // storing, so a re-ingest announced "Ingested N passages" after storing zero.
      expect(second).toContain("already in memory")
      expect(second).not.toContain("Ingested")
    }),
  )

  it.effect("ingest: a missing file settles as readable text, never a tool failure", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const result = yield* executeTool(registry, call({ op: "ingest", path: "definitely-not-here.txt" }))
      expect(result.type).toBe("text")
      expect(String(result.value).toLowerCase()).toMatch(/no readable file|couldn't ingest/)
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
