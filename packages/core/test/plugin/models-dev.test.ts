import path from "path"
import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer, Ref } from "effect"
import { ModelsDev as ModelsDevSchema } from "@novaclaw/schema/models-dev"
import { PluginV2 } from "@novaclaw/core/plugin"
import { PluginHost } from "@novaclaw/core/plugin/host"
import { PluginTestLayer } from "./fixture"
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

// ── The refresh subscription must SURVIVE a failing reload ────────────────────────────────────
//
// Regression pin. This plugin used to hand-roll its own subscription:
//   events.subscribe(Refreshed) |> Stream.runForEach(reload) |> forkScoped({startImmediately:true})
// with NO `catchCause`. One defect out of either reload killed the forked fiber, and the plugin
// went deaf for the rest of the PROCESS — silently, with the catalog never refreshing again.
// It now subscribes through `ctx.event`, so `PluginHost`'s `isolate` logs the failure and the
// subscription lives on. These cases drive the REAL host event domain (only the two reload
// targets are spied), so the isolation under test is the shipped one, not a stand-in.
const liveIt = testEffect(PluginTestLayer)

describe("ModelsDevPlugin refresh subscription", () => {
  const spies = () =>
    Effect.gen(function* () {
      const reloads = yield* Ref.make<string[]>([])
      const failNext = yield* Ref.make(false)
      const second = yield* Deferred.make<void>()
      const record = (name: string) =>
        Effect.gen(function* () {
          yield* Ref.update(reloads, (seen) => [...seen, name])
          // Survival is signalled by the SECOND `integration` reload, not the second `catalog`
          // one: refresh #1 dies inside `integration.reload`, so `andThen(catalog.reload)` never
          // runs on that pass. Reaching integration a second time is exactly "the subscription
          // is still alive after a defect".
          if ((yield* Ref.get(reloads)).filter((entry) => entry === "integration").length >= 2)
            yield* Deferred.succeed(second, undefined)
          if (yield* Ref.get(failNext)) yield* Effect.die(new Error(`${name} reload exploded`))
        })
      return { reloads, failNext, second, record }
    })

  const awaitSecond = (second: Deferred.Deferred<void>) =>
    Deferred.await(second).pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.die(new Error("the subscription went deaf after a failing reload")),
      }),
    )

  liveIt.live("a failing reload is logged and the NEXT refresh still reloads", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const plugin = yield* PluginV2.Service
      const real = yield* PluginHost.make(plugin)
      const spy = yield* spies()

      // Real `event` domain; only the two reload targets are spied, so the isolation under test
      // is the shipped one.
      const integration = yield* Integration.Service
      const catalog = yield* Catalog.Service
      const ctx = host({
        event: real.event,
        integration: { ...integrationHost(integration), reload: () => spy.record("integration") },
        catalog: { ...catalogHost(catalog), reload: () => spy.record("catalog") },
      })
      yield* ModelsDevPlugin.effect(ctx)

      yield* Ref.set(spy.failNext, true)
      yield* events.publish(ModelsDevSchema.Event.Refreshed, {})
      yield* Effect.sleep("150 millis")
      yield* Ref.set(spy.failNext, false)
      yield* events.publish(ModelsDevSchema.Event.Refreshed, {})

      yield* awaitSecond(spy.second)
      // The barrier opens INSIDE the handler (on the integration reload), so give the rest of
      // that same handler a beat to reach `andThen(catalog.reload)` before reading the tape.
      yield* Effect.sleep("250 millis")
      const seen = yield* Ref.get(spy.reloads)
      // Both refreshes reached the handler — the first one dying did not end the subscription —
      // and the second ran all the way through to the catalog reload.
      expect(seen.filter((entry) => entry === "integration").length).toBeGreaterThanOrEqual(2)
      expect(seen.filter((entry) => entry === "catalog").length).toBeGreaterThanOrEqual(1)
    }).pipe(Effect.provide(AppNodeBuilder.build(ModelsDev.node))),
  )
})
