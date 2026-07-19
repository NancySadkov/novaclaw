// LIVE end-to-end for the memory `kb` tool over the REAL in-process WASM engine (not the stub): the
// full chain decode → tool → MemoryClient.fromEngine → WasmMemory → disk snapshot. Proves the payoff
// of the whole tier: a fact `remember`ed in one instance is `search`-recalled in a SEPARATE instance
// booted fresh on the same data dir (cross-session recall). Runs under Bun, excluded from the hermetic
// suite (loads the WASM runtime — a `.smoke.ts`):
//     cd packages/core && bun test ./test/kb-graph-tool-live.smoke.ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Memory } from "@novaclaw/core/kb-graph/memory"
import { MemoryClient } from "@novaclaw/core/kb-graph/memory-client"
import { SessionV2 } from "@novaclaw/core/session"
import { KbTool } from "@novaclaw/core/tool/kb"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { ToolOutputStore } from "@novaclaw/core/tool-output-store"
import { toolIdentity, executeTool } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_kb_live")
let dir: string

const call = (input: unknown) => ({ sessionID, ...toolIdentity, call: { type: "tool-call" as const, id: "c", name: KbTool.name, input } })
const text = (r: { type: string; value: unknown }) => {
  expect(r.type).toBe("text")
  return String(r.value)
}

// Build a minimal tool graph backed by the REAL WASM engine at `dir` (dim 8, enabled). Memory.node is
// a top-level member so the body can poll its readiness via MemoryClient.Service.health().
const graph = () =>
  AppNodeBuilder.build(LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, KbTool.node, Memory.node]), [
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
    [Memory.node, Memory.layerFromConfig({ enabled: true, dim: 8, dbDir: join(dir, "graph") })],
  ])

const waitReady = Effect.gen(function* () {
  // Memory opens in a background fiber — wait for the engine to actually be live.
  const mem = yield* MemoryClient.Service
  for (let i = 0; i < 200; i++) {
    if (yield* mem.health()) return
    yield* Effect.sleep("100 millis")
  }
  throw new Error("memory engine did not become ready")
})

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "kb-tool-live-"))
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("kb tool over the real WASM engine", () => {
  test("remember → search, then cross-session recall in a fresh instance", async () => {
    // Instance A: remember a durable (global) fact, confirm it's recalled in-session.
    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        yield* waitReady
        expect(text(yield* executeTool(registry, call({ op: "remember", text: "The user's name is Nadia and she prefers dark mode", name: "Nadia" })))).toContain("Remembered (mem_")
        const found = text(yield* executeTool(registry, call({ op: "search", query: "dark mode" })))
        expect(found).toContain("Nadia")
      }).pipe(Effect.provide(graph()), Effect.scoped) as Effect.Effect<void>,
    )

    // Instance B: a SEPARATE boot on the same data dir recalls the fact (cross-session memory).
    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        yield* waitReady
        const recalled = text(yield* executeTool(registry, call({ op: "search", query: "dark mode" })))
        expect(recalled).toContain("Nadia")
        expect(recalled).toContain("dark mode")
      }).pipe(Effect.provide(graph()), Effect.scoped) as Effect.Effect<void>,
    )
  }, 40_000)

  test("relate links two remembered entities and neighbors traverses it (real engine edge round-trip)", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        yield* waitReady
        const idOf = (out: string) => out.match(/mem_[A-Za-z0-9]+/)?.[0] ?? ""
        const ada = idOf(text(yield* executeTool(registry, call({ op: "remember", text: "Ada Lovelace, a mathematician", name: "Ada" }))))
        const engine = idOf(text(yield* executeTool(registry, call({ op: "remember", text: "the Analytical Engine", name: "Engine" }))))
        expect(ada).not.toBe("")
        expect(engine).not.toBe("")
        // relate → the tool's addEdge → the REAL WasmMemory edge table.
        const linked = text(yield* executeTool(registry, call({ op: "relate", from: ada, to: engine, type: "wrote about" })))
        expect(linked).toContain("Linked")
        expect(linked).toContain("wrote_about")
        // neighbors reads it back out of the real engine.
        const nb = text(yield* executeTool(registry, call({ op: "neighbors", id: ada })))
        expect(nb).toContain(engine)
        expect(nb).toContain("wrote_about")
      }).pipe(Effect.provide(graph()), Effect.scoped) as Effect.Effect<void>,
    )
  }, 40_000)
})
