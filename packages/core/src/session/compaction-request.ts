export * as SessionCompactionRequest from "./compaction-request"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import type { SessionSchema } from "./schema"

/**
 * F1a SLICE 7 — the one-shot manual-compaction marker (architecture.md's kernel marker
 * vocabulary: an event is a component a phase consumes). `SessionV2.compact` REQUESTS and wakes
 * the session; the runner CONSUMES the marker at the top of its drain and runs a compact-only
 * cycle in its own context — compaction must run inside the runner because only it holds the
 * shared `LLMClient` (the OFF-C offline chokepoint), the resolved model, and the history
 * assembly (the inline `SessionV2.compact` build was reverted on exactly that constraint).
 *
 * In-memory by design: a request lost to a crash between request and wake is simply re-issued
 * by the user, and auto-compaction is recomputed independently every turn.
 */
export interface Interface {
  readonly request: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /** One-shot: returns true exactly once per request. */
  readonly consume: (sessionID: SessionSchema.ID) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/SessionCompactionRequest") {}

export const layer = Layer.sync(Service, () => {
  const pending = new Set<string>()
  return Service.of({
    request: (sessionID) =>
      Effect.sync(() => {
        pending.add(sessionID)
      }),
    consume: (sessionID) => Effect.sync(() => pending.delete(sessionID)),
  })
})

export const defaultLayer = layer

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
