import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Catalog } from "@novaclaw/core/catalog"
import { Integration } from "@novaclaw/core/integration"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { Flag } from "@novaclaw/core/flag/flag"
import { Location } from "@novaclaw/core/location"
import { ModelsDev } from "@novaclaw/core/models-dev"
import { ModelsDevPlugin } from "@novaclaw/core/plugin/models-dev"
import { AbsolutePath } from "@novaclaw/core/schema"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { catalogHost, host, integrationHost } from "./host"

const locationLayer = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make(import.meta.dir) })),
)
const layer = AppNodeBuilder.build(LayerNode.group([Catalog.node, Integration.node, EventV2.node]), [
  [Location.node, locationLayer],
])
const it = testEffect(layer)

describe("ModelsDevPlugin", () => {
  it.effect("registers key methods for providers with environment variables", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = {
          path: Flag.NOVACLAW_MODELS_PATH,
          disabled: Flag.NOVACLAW_DISABLE_MODELS_FETCH,
        }
        Flag.NOVACLAW_MODELS_PATH = path.join(import.meta.dir, "fixtures", "models-dev.json")
        Flag.NOVACLAW_DISABLE_MODELS_FETCH = true
        return previous
      }),
      () =>
        Effect.gen(function* () {
          const integrations = yield* Integration.Service
          const catalog = yield* Catalog.Service
          yield* ModelsDevPlugin.effect(
            host({
              catalog: catalogHost(catalog),
              integration: integrationHost(integrations),
            }),
          )
          expect(yield* integrations.list()).toEqual([
            new Integration.Info({
              id: Integration.ID.make("acme"),
              name: "Acme",
              methods: [
                { type: "key" },
                {
                  type: "env",
                  names: ["ACME_API_KEY"],
                },
              ],
              connections: [],
            }),
          ])
        }).pipe(Effect.provide(AppNodeBuilder.build(ModelsDev.node))),
      (previous) =>
        Effect.sync(() => {
          Flag.NOVACLAW_MODELS_PATH = previous.path
          Flag.NOVACLAW_DISABLE_MODELS_FETCH = previous.disabled
        }),
    ),
  )
})
