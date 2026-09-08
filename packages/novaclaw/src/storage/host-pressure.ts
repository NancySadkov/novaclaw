import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Global } from "@novaclaw/core/global"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { Context, Effect, Layer } from "effect"
import { Pressure } from "./pressure"

export interface Interface {
  /**
   * How much memory and disk this host has left, against the `resource_pressure` thresholds.
   *
   * Never throws: a host it cannot measure returns `known: false` with a reason, never a
   * fabricated zero.
   */
  readonly pressure: () => Effect.Effect<Pressure.Report>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/HostPressure") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const settings = yield* SettingsConfigStore.Service

    const pressure: Interface["pressure"] = Effect.fn("HostPressure.pressure")(function* () {
      // ⚠️ Read the value through to its store at the point of use. `Config.entries()` is computed
      // once when the Config layer is constructed, while this floor must change without a restart.
      const stored = yield* settings.all()
      const thresholds = Pressure.resolveThresholds(stored[Pressure.CONFIG_KEY])
      const memory = yield* Effect.promise(() => Pressure.memory())
      // Plural on purpose: data/config/cache/state can sit on different volumes unless `--home`
      // collapses them, so the volume with the least room is the one that decides.
      const disks = instancePaths().map((target) => Pressure.disk(target))
      return Pressure.report({ memory, disks, thresholds })
    })

    return Service.of({ pressure })
  }),
)

/** The instance directories, deduplicated — resolved lazily because `Global.Path` is a lazy getter. */
function instancePaths(): string[] {
  return [...new Set([Global.Path.data, Global.Path.config, Global.Path.cache, Global.Path.state])]
}

export const defaultLayer = layer.pipe(Layer.provide(SettingsConfigStore.defaultLayer))

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [SettingsConfigStore.node],
})

export * as HostPressure from "./host-pressure"
