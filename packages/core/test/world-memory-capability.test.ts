import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Memory } from "@novaclaw/core/kb-graph/memory"
import { MemoryClient } from "@novaclaw/core/kb-graph/memory-client"
import { WorldMemory } from "@novaclaw/core/kb-graph/world-memory"

describe("the explicit KB and hot world model capabilities", () => {
  test("crossed writes stay isolated at their service boundary", async () => {
    const explicit = MemoryClient.stub()
    const world = MemoryClient.stub()
    const graph = AppNodeBuilder.build(LayerNode.group([Memory.node, WorldMemory.node]), [
      [Memory.serviceNode, Layer.succeed(MemoryClient.Service, explicit)],
      [WorldMemory.serviceNode, Layer.succeed(WorldMemory.Service, world)],
    ])

    await Effect.runPromise(
      Effect.gen(function* () {
        const kb = Memory.client(yield* Memory.node.service)
        const hot = WorldMemory.client(yield* WorldMemory.node.service)
        yield* kb.addMemory({ id: "kb-only", kind: "passage", text: "source documentation", scope: "global" })
        yield* hot.addMemory({ id: "world-only", kind: "episode", text: "transient conversation", scope: "session:one" })

        expect((yield* kb.search({ query: "source documentation" })).map((row) => row.id)).toEqual(["kb-only"])
        expect(yield* kb.search({ query: "transient conversation" })).toHaveLength(0)
        expect((yield* hot.search({ query: "transient conversation" })).map((row) => row.id)).toEqual(["world-only"])
        expect(yield* hot.search({ query: "source documentation" })).toHaveLength(0)
      }).pipe(Effect.provide(graph)),
    )
  })
})
