export * as PluginTools from "./plugin-tools"

import type { ToolDefinition } from "@novaclaw/plugin"
import { Context, Effect, Layer, Scope } from "effect"
import { makeLocationNode } from "../effect/app-node"
import type { State } from "../state"
import { validateName } from "./tool"

// F1a plugin-tool parity: the location-scoped store of model-facing tools contributed
// by V2 plugins via `ctx.tool.register` (wired in `plugin/host.ts`). It holds the RAW
// plugin `ToolDefinition`; the novaclaw-side `ExternalToolSource` aggregator adapts each
// to a core `AnyTool` and merges it into the V2 registry's external entries — core never
// executes plugin code itself. Registrations are scoped: a plugin's tools disappear when
// its load scope closes (plugin removal/replace) or when the registration is disposed.
// `identity` is minted once per registration so the V2 ToolRegistry's stale-call guard
// (identity comparison across materialize/settle) stays correct.

export interface Entry {
  readonly identity: object
  readonly definition: ToolDefinition
}

export interface Interface {
  readonly register: (
    name: string,
    definition: ToolDefinition,
  ) => Effect.Effect<State.Registration, never, Scope.Scope>
  readonly entries: () => Effect.Effect<ReadonlyMap<string, Entry>>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/PluginTools") {}

export const layer = Layer.sync(Service, () => {
  // Same-name registrations stack (two plugins may claim one name): the LAST live
  // registration wins, and disposing one uncovers the other — the same token
  // discipline as `ToolRegistry.register`.
  const stacks = new Map<string, Entry[]>()

  const register: Interface["register"] = Effect.fn("PluginTools.register")(function* (name, definition) {
    // An invalid tool name is a plugin programming error — fail the plugin load.
    yield* validateName(name).pipe(Effect.orDie)
    const entry: Entry = { identity: {}, definition }
    stacks.set(name, [...(stacks.get(name) ?? []), entry])
    let active = true
    const dispose = Effect.sync(() => {
      if (!active) return
      active = false
      const rest = (stacks.get(name) ?? []).filter((item) => item !== entry)
      if (rest.length > 0) stacks.set(name, rest)
      else stacks.delete(name)
    })
    const scope = yield* Scope.Scope
    yield* Scope.addFinalizer(scope, dispose)
    return { dispose }
  })

  const entries: Interface["entries"] = () =>
    Effect.sync(() => {
      const result = new Map<string, Entry>()
      for (const [name, stack] of stacks) {
        const top = stack.at(-1)
        if (top) result.set(name, top)
      }
      return result
    })

  return Service.of({ register, entries })
})

export const node = makeLocationNode({ service: Service, layer, deps: [] })
