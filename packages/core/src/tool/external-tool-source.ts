export * as ExternalToolSource from "./external-tool-source"

import { Context, Effect, Layer } from "effect"
import { Tool } from "./tool"
import { makeLocationNode } from "../effect/app-node"

// Location-scoped dependency-inversion seam for tools that core can't construct itself —
// MCP servers and (future) host plugins, which live in the novaclaw package. The V2
// `ToolRegistry` consults this provider in `materialize`/`settle`, so an novaclaw-side
// replacement (injected via `buildLocationServiceMap` replacements) makes its tools visible
// to the runner WITHOUT core depending on novaclaw. Default impl is empty → no behavior
// change until something replaces it. Entries carry a STABLE `identity` (rebuilt only when
// the underlying tool set changes) so the registry's stale-call guard stays correct.

export interface Entry {
  readonly identity: object
  readonly tool: Tool.AnyTool
}

export interface Interface {
  readonly entries: () => Effect.Effect<ReadonlyMap<string, Entry>>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/ExternalToolSource") {}

const EMPTY: ReadonlyMap<string, Entry> = new Map()

export const layer = Layer.succeed(Service, Service.of({ entries: () => Effect.succeed(EMPTY) }))

export const node = makeLocationNode({ service: Service, layer, deps: [] })
