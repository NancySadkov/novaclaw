export * as SessionWorkerLocation from "./location"

import { Effect, Layer } from "effect"
import { Location } from "@novaclaw/core/location"

/** Read the one canonical derived Location.Info from a materialized location-services layer. */
export const resolve = <E>(located: Layer.Layer<Location.Service, E>) =>
  Effect.gen(function* () {
    return yield* Location.Service
  }).pipe(Effect.provide(located))
