export * as AgentRemoval from "./removal"

import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { FileSystem } from "effect"
import { AgentConfigStore } from "../agent-config-store"
import { AgentStatus } from "../agent-status"
import { GraphRegistry } from "./graph-registry"
import { CalendarScheduleTable } from "../schedule/calendar.sql"
import { Scratch } from "../scratch"
import * as AppNodePlatform from "../effect/app-node-platform"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { Memory } from "../kb-graph/memory"
import { WorldMemory } from "../kb-graph/world-memory"
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

/**
 * ⚠️ **Per GRAPH, not per process** (`agent/graph-registry.ts` carries the whole argument). A
 * module-level `Set` here meant one instance's removal ran another instance's retirement against the
 * OTHER instance's database — and officer ids come from a fixed pool, so the same id living in two
 * instances is the normal case rather than the corner one.
 */
const listeners = GraphRegistry.make<Listener>()

/** Register a retirement for the life of a scope, in the CALLING graph. */
export const register = (notify: (agentID: string) => Effect.Effect<void>) => listeners.register({ notify })

/**
 * How many listeners are live IN ONE GRAPH. Exported so "the wiring exists" can be asserted, not
 * reasoned about — which it cannot be if it answers the union across every graph in the process.
 */
export const registered = (graph?: GraphRegistry.Graph): number => listeners.entries(graph).length

/**
 * Announce that a colleague's config row is gone.
 *
 * ⚠️ `catchCause`, not `ignore`: a listener with a defect in it must not propagate out of a config
 * write that has already committed and surface as a 500 on a removal that worked. `Effect.ignore`
 * discharges the error channel and lets a defect through — the same correction
 * `agent/reassignment.ts` records after a test caught the claim being false there.
 */
export const announce = (agentID: string): Effect.Effect<void> =>
  // ⚠️ `listeners.visible`, not every listener in the process: the announcement reaches the graph
  // that made it and no other.
  Effect.flatMap(listeners.visible, (live) =>
    Effect.forEach(live, (listener) => listener.notify(agentID).pipe(Effect.catchCause(() => Effect.void)), {
      discard: true,
    }),
  )

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
      const worldMemory = WorldMemory.client(yield* WorldMemory.node.service)
      // 🔴 The subsystems that key rows on an agent id, registered where their stores are reachable.
      // Declared in `AgentRetire.CLEANERS`, so one that is never wired is REPORTED rather than
      // silently skipped — which is the failure mode this whole list exists to answer.
      const store = yield* AgentConfigStore.Service
      const fs = yield* FileSystem.FileSystem
      yield* AgentRetire.registerCleaner("schedules", (agentID) =>
        // A retired colleague's tasks must stop firing. Left behind they do not merely linger: the
        // scheduler hands an unrunnable owner's task to NOVA, so a retirement would quietly turn
        // somebody's scheduled work into the CEO's.
        db
          .delete(CalendarScheduleTable)
          .where(eq(CalendarScheduleTable.agent, agentID))
          .run()
          .pipe(Effect.asVoid, Effect.orDie),
      )
      yield* AgentRetire.registerCleaner("default-agent", (agentID) =>
        Effect.gen(function* () {
          // A dangling `default_agent` reads as configured while resolving to nobody. The HTTP door
          // already prunes it; the TOOL door did not, so Nova retiring a colleague it had made the
          // default left the setting pointing at a name that no longer exists.
          const current = yield* store.getDefault()
          if (current === agentID) yield* store.clearDefault()
        }),
      )
      yield* AgentRetire.registerCleaner("workspace", (agentID) =>
        Effect.gen(function* () {
          // 🔴 Its OWN scratch only. `folderFor` answers "where does this colleague work", which for a
          // configured colleague is A PROJECT THE USER CHOSE — deleting that on a retirement would
          // remove the user's own source tree. `Scratch.forAgent` is the folder the instance made for
          // this id and nobody else's, which is the only thing a retirement owns.
          //
          // ⚠️ The id RETURNS (officer names come from a fixed pool), so files left here are handed to
          // the next colleague drawn on the name — the same bleed the memory cabinet move prevents.
          const own = Scratch.forAgent(agentID)
          if (yield* fs.exists(own)) yield* fs.remove(own, { recursive: true })
        }).pipe(Effect.orDie),
      )
      const status = yield* AgentStatus.Service
      yield* AgentRetire.registerCleaner("status", (agentID) =>
        // 🔴 A STATUS LINE IS KEYED ON THE ID, so the next officer drawn on the name wears the last
        // one's sentence. It is the corporation rule the archived chat already keeps — a returning
        // name never opens into its predecessor's transcript — and a roster row describing a
        // colleague by a stranger's work breaks it just as loudly, in the one place a person looks.
        //
        // ⚠️ It cannot heal itself either. `everything` archives the old chats and a redrawn id may
        // generate no lifecycle event for hours. Cleanup is therefore synchronous with retirement,
        // not deferred until a future sample happens to overwrite the row.
        status.remove(agentID),
      )
      yield* register((agentID) =>
        AgentRetire.everything({ db, events, memory, worldMemory, agent: agentID, at: Date.now() }).pipe(Effect.asVoid),
      )
    }),
  ),
  deps: [
    AgentConfigStore.node,
    AgentStatus.node,
    AppNodePlatform.filesystem,
    Database.node,
    EventV2.node,
    Memory.node,
    WorldMemory.node,
  ],
})
