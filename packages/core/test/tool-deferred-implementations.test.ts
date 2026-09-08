import { expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { SettingsConfigStore } from "../src/settings-config-store"
import { LocationServiceMap } from "../src/location-services"
import { Location } from "../src/location"
import { AbsolutePath } from "../src/schema"
import { ToolRegistry } from "../src/tool/registry"
import { SessionSchema } from "../src/session/schema"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity } from "./lib/tool"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SettingsConfigStore.node, LocationServiceMap.node]),
  ),
)

it.live("every deferred implementation loads against the real location graph before rejecting malformed input", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (directory) => Effect.promise(() => directory[Symbol.asyncDispose]()),
      )
      const location = Location.Ref.make({ directory: AbsolutePath.make(directory.path) })
      yield* Effect.gen(function* () {
        const registry = yield* ToolRegistry.Service
        const catalogue = yield* registry.materialize()
        const names = catalogue.deferred.map((source) => source.definition.name)
        expect(names.length).toBeGreaterThan(0)
        const disclosed = yield* registry.materialize([], undefined, new Set(names))
        for (const name of names) {
          const result = yield* disclosed.settle({
            ...toolIdentity,
            sessionID: SessionSchema.ID.make("ses_lazy_implementations"),
            call: { type: "tool-call", id: name, name, input: null as never },
          })
          expect(result.result.type, name).toBe("error")
          expect(JSON.stringify(result.result), name).toContain("Invalid tool input")
        }
      }).pipe(Effect.provide(LocationServiceMap.Service.get(location)))
    }),
  ),
)
