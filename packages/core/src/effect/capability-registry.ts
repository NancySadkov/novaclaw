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
      const entries = nodes
        .map((node) => ({ name: node.capabilityName, capability: Context.get(context, node.service) }))
        .toSorted((a, b) => a.name.localeCompare(b.name))

      const inspect = Effect.fn("CapabilityRegistry.inspect")(function* () {
        return yield* Effect.forEach(entries, (entry) =>
          entry.capability.status.pipe(Effect.map((status) => ({ name: entry.name, status }))),
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
          const entry = entries.find((candidate) => candidate.name === name)
          if (entry === undefined) return yield* new NotFoundError({ name })
          return yield* entry.capability.retry
        }),
      })
    }),
  )

/** Filled by AppNodeBuilder from the capability nodes reachable in the application graph. */
export const node = LayerNode.unbound(Service, tags.values.global)

export const boundNode = (nodes: ReadonlyArray<LayerNode.CapabilityNode<unknown, unknown, any>>) =>
  makeGlobalNode({ service: Service, layer: layer(nodes), deps: nodes as never })

/** Replace the registry seam exactly once with a registry derived from this application's graph. */
export const bind = (
  root: LayerNode.Node<unknown, unknown, any>,
  replacements: LayerNode.Replacements,
): LayerNode.Replacements => {
  if (!LayerNode.hasUnbound(root, node) || replacements.some(([source]) => source.name === node.name)) {
    return replacements
  }
  return replacements.concat([[node, boundNode(LayerNode.capabilities(root, replacements))]])
}
