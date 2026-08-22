export * as AgentRemoval from "./removal"

import { Effect, Layer } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { Memory } from "../kb-graph/memory"
import { AgentRetire } from "./retire"

// RETIRING A COLLEAGUE THAT WAS REMOVED THROUGH THE CONFIG DOOR.
//
// 🔴 **There are two ways to un-hire somebody and only one of them cleaned up.** `DELETE
// /api/agent/:id` runs `AgentRetire.everything` — the cabinet is set aside, the usage forgotten, the
// chats archived. `POST /api/config/remove {"paths":[["agents","<id>"]]}` dropped the config row and
// nothing else. Measured 2026-08-22: a probe colleague removed that way came off the roster with its
// private memories still sitting under `agent:<id>`.
//
// That is the identity-bleed hazard `agent/retire.ts` exists to prevent, still open on the second
// door: officer names are DRAWN FROM A FIXED POOL, so the id comes back, and the next colleague
// drawn as `theron` would open holding the old Theron's private memories.
//
// ⚠️ **A registry rather than a call, for the reason the removal itself is in the store.**
// `config-store-write.ts` is the one door every config write passes through — HTTP, the `configure`
// tool writing in-process, a plugin — which is exactly why the HTTP handler delegates to it instead
// of doing the work itself. But it is a global-scope STORE module: it holds no memory client and no
// event bus. So it announces and whatever graph owns those registers to act. Same shape as
// `agent/reassignment.ts`, deliberately — a second mechanism for "config changed, tell something"
// is the kind of duplicate that drifts apart.
//
// ⚠️ **Nobody registered is not an error**, for the same reason it is not there: a CLI editing config
// with no instance running has no memory engine to tidy. The next instance to open that store will
// still see the cabinet, which is why this is a best-effort courtesy and the `DELETE` door remains
// the one with the guarantee.

type Listener = { readonly notify: (agentID: string) => Effect.Effect<void> }

const listeners = new Set<Listener>()

/** Register a retirement for the life of a scope. */
export const register = (notify: (agentID: string) => Effect.Effect<void>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const listener: Listener = { notify }
      listeners.add(listener)
      return listener
    }),
    (listener) =>
      Effect.sync(() => {
        listeners.delete(listener)
      }),
  ).pipe(Effect.asVoid)

/** How many listeners are live. Exported so "the wiring exists" can be asserted, not reasoned about. */
export const registered = (): number => listeners.size

/**
 * Announce that a colleague's config row is gone.
 *
 * ⚠️ `catchCause`, not `ignore`: a listener with a defect in it must not propagate out of a config
 * write that has already committed and surface as a 500 on a removal that worked. `Effect.ignore`
 * discharges the error channel and lets a defect through — the same correction
 * `agent/reassignment.ts` records after a test caught the claim being false there.
 */
export const announce = (agentID: string): Effect.Effect<void> =>
  Effect.forEach([...listeners], (listener) => listener.notify(agentID).pipe(Effect.catchCause(() => Effect.void)), {
    discard: true,
  })

/**
 * The scoped registration an instance graph makes.
 *
 * ⚠️ GLOBAL: a config removal is instance-wide, and all three services this needs are global too. A
 * location node would register one listener per open location and retire the same colleague that many
 * times — harmless for the cabinet MOVE (it is idempotent once the source scope is empty) and wasteful
 * for everything else.
 */
export const node = makeGlobalNode({
  name: "agent/removal",
  layer: Layer.effectDiscard(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const memory = Memory.client(yield* Memory.node.service)
      yield* register((agentID) =>
        AgentRetire.everything({ db, events, memory, agent: agentID, at: Date.now() }).pipe(Effect.asVoid),
      )
    }),
  ),
  deps: [Database.node, EventV2.node, Memory.node],
})
