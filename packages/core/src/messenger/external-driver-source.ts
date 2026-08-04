export * as ExternalDriverSource from "./external-driver-source"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import type { Driver } from "./driver"

// Instance-global dependency-inversion seam for messenger drivers core can't construct itself —
// plugin-contributed, OUT-OF-KERNEL transports (WhatsApp via the ToS-gray Baileys bridge, and any
// future third-party platform). The static registry (drivers.ts) composes `builtin ∪ external`, so
// an novaclaw-side / plugin replacement adds transports WITHOUT core depending on novaclaw or
// importing a heavy / ToS-gray library. Default impl is EMPTY → no behavior change until something
// replaces it. This is the notes/messenger-plan.md §3.6 mechanism the plan reserved ("the same
// dependency-inversion trick as tools: an ExternalDriverSource service that plugins/MCP contribute
// into; cf. external-tool-source.ts; not built until asked for").
//
// ⚠️ GLOBAL, not location-scoped (unlike the tool/command sources): accounts + the gateway are
// instance-wide, so drivers are too. The contributed set is read once when the driver registry is
// built (plugins load during instance setup, before the messenger services), so a build-time
// snapshot captures them; built-ins win an id collision (a plugin cannot shadow a kernel transport).

export interface Interface {
  /** Drivers contributed from outside core (plugins). Consulted once when the registry is built. */
  readonly drivers: () => Effect.Effect<ReadonlyArray<Driver>>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/ExternalDriverSource") {}

const EMPTY: ReadonlyArray<Driver> = []

export const layer = Layer.succeed(Service, Service.of({ drivers: () => Effect.succeed(EMPTY) }))

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
