import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Memory } from "@novaclaw/core/kb-graph/memory"
import { MemoryClient } from "@novaclaw/core/kb-graph/memory-client"

describe("memory capability", () => {
  test("a poisoned memory layer cannot kill boot and can be repaired without restarting", async () => {
    let refuse = true
    let builds = 0
    const poisoned = Layer.effect(
      MemoryClient.Service,
      Effect.sync(() => {
        builds++
        if (refuse) throw new Error("forced memory boot defect")
        return MemoryClient.stub()
      }),
    )
    const graph = AppNodeBuilder.build(LayerNode.group([Memory.node]), [[Memory.serviceNode, poisoned]])
    const program = Effect.gen(function* () {
      const capability = yield* Memory.node.service
      const memory = Memory.client(capability)

      // Merely booting and inspecting the instance must not acquire the poisoned layer.
      expect(yield* capability.status).toEqual({ state: "idle" })
      expect(builds).toBe(0)

      // First demand turns the defect into a named value. Later calls reuse it without retry storms.
      expect(yield* memory.health()).toBe(false)
      expect(yield* capability.status).toMatchObject({
        state: "unavailable",
        reason: { capability: "memory", kind: "failed", summary: expect.stringContaining("forced memory boot defect") },
        attempts: 1,
      })
      expect(yield* memory.health()).toBe(false)
      expect(builds).toBe(1)

      // The same live handle re-arms after repair; no process or graph rebuild is involved.
      refuse = false
      expect(yield* capability.retry).toMatchObject({ state: "ready" })
      expect(yield* memory.health()).toBe(true)
      expect(builds).toBe(2)
    }).pipe(Effect.provide(graph))

    await Effect.runPromise(program)
  })
})
