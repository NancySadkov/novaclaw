import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { ProviderV2 } from "@novaclaw/core/provider"
import { testEffect } from "./lib/effect"

// T10(iv): the true provider delete — the store row goes away, and a default-model ref that
// pointed into the removed provider is pruned (clearDefault deletes the setting row outright,
// so setDefaultIfEmpty can re-seed later; an empty-string default would have blocked it).

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, CatalogStore.node])))

describe("CatalogStore remove + clearDefault", () => {
  it.effect("removeProvider deletes the row; clearDefault removes the ref for re-seeding", () =>
    Effect.gen(function* () {
      const store = yield* CatalogStore.Service
      const id = ProviderV2.ID.make("scratch")
      yield* store.setLayers(id, [{ name: "Scratch" }])
      expect(Object.keys(yield* store.providers())).toContain("scratch")

      yield* store.setDefault("scratch/some-model")
      yield* store.removeProvider(id)
      expect(Object.keys(yield* store.providers())).not.toContain("scratch")

      const dangling = yield* store.getDefault()
      expect(dangling).toBe("scratch/some-model")
      yield* store.clearDefault()
      expect(yield* store.getDefault()).toBeUndefined()

      // clearDefault must leave NO row — setDefaultIfEmpty seeds again afterwards.
      yield* store.setDefaultIfEmpty("dgx/qwen")
      expect(yield* store.getDefault()).toBe("dgx/qwen")
    }),
  )
})
