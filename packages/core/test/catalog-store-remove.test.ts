import { describe, expect } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect, Logger } from "effect"
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

/** Run `effect` with the loggers replaced by a collector, and hand back every WARN it emitted. */
const withWarnings = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.suspend(() => {
    const warnings: string[] = []
    const collector = Logger.make((options: Logger.Options<unknown>) => {
      if (options.logLevel !== "Warn") return
      const parts = Array.isArray(options.message) ? options.message : [options.message]
      warnings.push(parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" "))
    })
    return effect.pipe(
      Effect.provide(Logger.layer([collector])),
      Effect.map((value) => ({ value, warnings })),
    )
  })

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

  // Standing decision 3: one unreadable `layers` blob used to be a DEFECT (decodeUnknownSync
  // THROWS inside the Effect.fn) that killed `providers()` — a global service on the location-boot
  // path, so one bad row killed BOOT and took the whole catalog with it. Losing the catalog
  // SILENTLY is doubly wrong here: zero providers is a supported first-run state, so a total loss
  // is indistinguishable from a fresh install. It must cost exactly that one provider, and say so.
  it.effect("one malformed layers row is skipped BY NAME; every other provider still loads", () =>
    Effect.gen(function* () {
      const store = yield* CatalogStore.Service
      const { db } = yield* Database.Service
      yield* store.setLayers(ProviderV2.ID.make("healthy"), [{ name: "Healthy" }])

      // Valid JSON, invalid shape — what a Registry hand-edit or a schema skew actually produces.
      yield* db
        .run(
          sql`INSERT INTO catalog_provider (id, layers, time_created, time_updated) VALUES ('broken', '"nope"', 0, 0)`,
        )
        .pipe(Effect.orDie)

      const { value: providers, warnings } = yield* withWarnings(store.providers())
      expect(Object.keys(providers)).toEqual(["healthy"])
      expect(providers.broken).toBeUndefined()
      // The catalog degraded — it did NOT render empty, which would read as "fresh install".
      expect(providers.healthy).toEqual([{ name: "Healthy" }])
      expect(yield* store.isEmpty()).toBe(false)

      expect(warnings).toHaveLength(1)
      expect(warnings[0]).toContain("broken")
      expect(warnings[0]).toContain("catalog_provider")
      // Deduped: a second read is not a second log line (config reads are hot).
      expect((yield* withWarnings(store.providers())).warnings).toEqual([])
    }),
  )
})
