import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { CapabilityRegistry } from "@novaclaw/core/effect/capability-registry"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Memory } from "@novaclaw/core/kb-graph/memory"
import { MemoryClient } from "@novaclaw/core/kb-graph/memory-client"

describe("capability registry", () => {
  test("discovers the graph, observes without starting, reports refusal and retries in place", async () => {
    let refuse = true
    let builds = 0
    const inner = Layer.effect(
      MemoryClient.Service,
      Effect.sync(() => {
        builds++
        if (refuse) throw new Error("forced registry defect")
        return MemoryClient.stub()
      }),
    )
    const graph = AppNodeBuilder.build(LayerNode.group([CapabilityRegistry.node, Memory.node]), [
      [Memory.serviceNode, inner],
    ])
    const program = Effect.gen(function* () {
      const registry = yield* CapabilityRegistry.Service
      const memory = Memory.client(yield* Memory.node.service)

      expect(yield* registry.inspect()).toEqual([{ name: "memory", status: { state: "idle" } }])
      expect(yield* registry.lines()).toEqual([])
      expect(builds).toBe(0)

      expect(yield* memory.health()).toBe(false)
      expect(yield* registry.inspect()).toMatchObject([
        { name: "memory", status: { state: "unavailable", reason: { kind: "failed" }, attempts: 1 } },
      ])
      expect(yield* registry.lines()).toEqual([
        expect.stringContaining('Capability "memory" is unavailable: memory is unavailable'),
      ])
      expect(builds).toBe(1)

      refuse = false
      expect(yield* registry.retry("memory")).toMatchObject({ state: "ready" })
      expect(yield* registry.lines()).toEqual([])
      expect(yield* memory.health()).toBe(true)
      expect(builds).toBe(2)

      const missing = yield* registry.retry("missing").pipe(Effect.flip)
      expect(missing).toBeInstanceOf(CapabilityRegistry.NotFoundError)
    }).pipe(Effect.provide(graph))

    await Effect.runPromise(program)
  })

  test("an application graph with no capabilities exposes an empty registry", async () => {
    const graph = AppNodeBuilder.build(LayerNode.group([CapabilityRegistry.node]))
    const program = Effect.gen(function* () {
      const registry = yield* CapabilityRegistry.Service
      expect(yield* registry.inspect()).toEqual([])
      expect(yield* registry.lines()).toEqual([])
    }).pipe(Effect.provide(graph))

    await Effect.runPromise(program)
  })
})
