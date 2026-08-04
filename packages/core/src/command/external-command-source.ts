export * as ExternalCommandSource from "./external-command-source"

import { Context, Effect, Layer } from "effect"
import { makeLocationNode } from "../effect/app-node"

// Location-scoped dependency-inversion seam for slash commands core can't construct itself —
// MCP prompt-backed commands, which live in the novaclaw package (the `ExternalToolSource`
// pattern applied to commands). The session `command` op consults this source when a name
// misses `CommandV2` (and the `/command` list handler merges its entries), so an
// novaclaw-side replacement (injected via `buildLocationServiceMap` replacements) makes MCP
// prompts dispatchable WITHOUT core depending on novaclaw. Default impl is empty → no
// behavior change until something replaces it. `template` is an Effect because external
// templates resolve lazily at dispatch time (an MCP prompt is fetched from its server).

export interface Entry {
  readonly description?: string | undefined
  /** Argument placeholders for the composer ($1..$N), in order. */
  readonly hints: ReadonlyArray<string>
  /** Resolve the command template (placeholders included) at dispatch time. */
  readonly template: Effect.Effect<string>
}

export interface Interface {
  readonly entries: () => Effect.Effect<ReadonlyMap<string, Entry>>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/ExternalCommandSource") {}

const EMPTY: ReadonlyMap<string, Entry> = new Map()

export const layer = Layer.succeed(Service, Service.of({ entries: () => Effect.succeed(EMPTY) }))

export const node = makeLocationNode({ service: Service, layer, deps: [] })
