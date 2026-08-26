export * as CapabilityRegistry from "./capability-registry"

import { Context, Data, Effect, Layer } from "effect"
import { makeGlobalNode, tags } from "./app-node"
import { Capability } from "./capability"
import { LayerNode } from "./layer-node"

export interface Snapshot {
  readonly name: string
  readonly status: Capability.Status
}

export class NotFoundError extends Data.TaggedError("CapabilityRegistry.NotFoundError")<{
  readonly name: string
}> {}

export interface Interface {
  /** Observe every declared capability without starting any of them. */
  readonly inspect: () => Effect.Effect<ReadonlyArray<Snapshot>>
  /** Exception-only ambient model context. Healthy, idle and starting capabilities cost zero tokens. */
  readonly lines: () => Effect.Effect<ReadonlyArray<string>>
  /** Re-arm one cached refusal in the live instance. */
  readonly retry: (name: string) => Effect.Effect<Capability.Status, NotFoundError>
  /** Register a capability composed outside the application graph (for shared-runtime services). */
  readonly register: (name: string, capability: Capability.Capability<unknown>) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/CapabilityRegistry") {}

const line = (snapshot: Snapshot): string | undefined => {
  if (snapshot.status.state !== "unavailable") return undefined
  const reason = snapshot.status.reason
  const repair = reason.repair?.length ? ` Repairable settings: ${reason.repair.join(", ")}.` : ""
  return `Capability "${snapshot.name}" is unavailable: ${reason.summary}${repair}`
}

export const layer = (
  nodes: ReadonlyArray<LayerNode.CapabilityNode<unknown, unknown, any>>,
): Layer.Layer<Service, never, unknown> =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const context = yield* Effect.context<unknown>()
      // ⚠️ SORTED by name: these reach the model's per-turn environment block, and `nodes` is in
      // registration order — stable in one process, free to differ across boots or when a layer is
      // added. An unstable list re-prefills everything after it (NC-PROMPT-CACHE-006).
      const entries = new Map(
        nodes
          .toSorted((a, b) => a.capabilityName.localeCompare(b.capabilityName))
          .map((node) => [
            node.capabilityName,
            Context.get(context, node.service) as Capability.Capability<unknown>,
          ]),
      )

      const inspect = Effect.fn("CapabilityRegistry.inspect")(function* () {
        return yield* Effect.forEach(
          [...entries.entries()].toSorted(([a], [b]) => a.localeCompare(b)),
          ([name, capability]) => capability.status.pipe(Effect.map((status) => ({ name, status }))),
        )
      })

      return Service.of({
        inspect,
        lines: Effect.fn("CapabilityRegistry.lines")(function* () {
          return (yield* inspect()).flatMap((snapshot) => {
            const value = line(snapshot)
            return value === undefined ? [] : [value]
          })
        }),
        retry: Effect.fn("CapabilityRegistry.retry")(function* (name) {
          const capability = entries.get(name)
          if (capability === undefined) return yield* new NotFoundError({ name })
          return yield* capability.retry
        }),
        register: (name, capability) =>
          Effect.sync(() => {
            const existing = entries.get(name)
            if (existing !== undefined && existing !== capability) {
              throw new Error(`Conflicting capability registration: ${name}`)
            }
            entries.set(name, capability)
          }),
      })
    }),
  )

/** Filled by AppNodeBuilder from the capability nodes reachable in the application graph. */
export const node = LayerNode.unbound(Service, tags.values.global)

export const boundNode = (nodes: ReadonlyArray<LayerNode.CapabilityNode<unknown, unknown, any>>) =>
  makeGlobalNode({ service: Service, layer: layer(nodes), deps: nodes as never })

/** Replace the registry seam exactly once with a registry derived from this application's graph. */
export const bind = <R>(
  root: LayerNode.Node<unknown, unknown, any, R>,
  replacements: LayerNode.Replacements,
): LayerNode.Replacements => {
  if (!LayerNode.hasUnbound(root, node) || replacements.some(([source]) => source.name === node.name)) {
    return replacements
  }
  return replacements.concat([[node, boundNode(LayerNode.capabilities(root, replacements))]])
}
