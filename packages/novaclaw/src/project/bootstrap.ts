import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Format } from "../format"
import * as Vcs from "./vcs"
import { InstanceState } from "@/effect/instance-state"
import { Effect, Layer } from "effect"
import { Config } from "@/config/config"
import { Service } from "./bootstrap-service"
import { Log } from "@novaclaw/schema/log"

export { Service } from "./bootstrap-service"
export type { Interface } from "./bootstrap-service"

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    // Yield each bootstrap dep at layer init so `run` itself has R = never.
    // InstanceStore imports only the lightweight tag from bootstrap-service.ts,
    // so it can depend on bootstrap without importing this implementation graph.
    const config = yield* Config.Service
    const format = yield* Format.Service
    const vcs = yield* Vcs.Service

    const run = Effect.gen(function* () {
      const ctx = yield* InstanceState.context
      yield* Log.event("instance.bootstrap.start", { directory: ctx.directory })
      // everything depends on config so eager load it for nice traces
      yield* config.get()
      // Each service self-manages its own slow work via Effect.forkScoped against
      // its per-instance state scope. We just await materialization here.
      yield* Effect.forEach(
        // No snapshot warm-up: the novaclaw Snapshot fork that used to sit here was deleted on
        // 2026-09-03 (a second service on the SAME store directory as core's, with weaker guards and
        // no product caller); core's `Snapshot` captures lazily on first use and needs no init.
        [format, vcs],
        (s) =>
          s
            .init()
            .pipe(
              Effect.catchCause((cause) =>
                Log.event("instance.bootstrap.service.failed", { "instance.cause": Log.fault(cause) }),
              ),
            ),
        { concurrency: "unbounded", discard: true },
      ).pipe(Effect.withSpan("InstanceBootstrap.init"))
    }).pipe(Effect.withSpan("InstanceBootstrap"))

    return Service.of({ run })
  }),
)

export const defaultLayer: Layer.Layer<Service> = layer.pipe(
  Layer.provide([Config.defaultLayer, Format.defaultLayer, Vcs.defaultLayer]),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Config.node, Format.node, Vcs.node],
})

export * as InstanceBootstrap from "./bootstrap"
