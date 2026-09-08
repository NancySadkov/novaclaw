export * as AgentRetire from "./retire"

import { DateTime, Effect } from "effect"
import { Log } from "@novaclaw/schema/log"
import type { Database } from "../database/database"
import type { EventV2 } from "../event"
import type { MemoryClient } from "../kb-graph/memory-client"
import { RosterChat } from "../session/roster-chat"
import { SessionPatch } from "../session/patch"
import { SessionSchema } from "../session/schema"
import * as MemoryAccess from "../kb-graph/memory-access"
import { AgentUsage } from "./usage"
import { GraphRegistry } from "./graph-registry"

// What it MEANS to retire a colleague — in one place, because there are two doors.
//
// 🔴 **A retired id comes back.** Officer names are drawn from a fixed Greek pool
// (`officer-name.ts`), so the name a retired colleague gave back is one a future colleague can draw.
// Anything left keyed on that id is inherited by a stranger: their per-minute rate on the roster
// row, and — far worse — their private cabinet. Measured 2026-08-21 on the owner's instance: a probe
// colleague `ghost` was retired through `DELETE /api/agent/ghost` and its `agent:ghost` memory row
// came back byte-identical afterwards, while the retire tool's own message told the user
// *"their chat and what they remembered go with them"*. The message was the honest half.
//
// ⚠️ The two doors are `handlers/agent.ts` (the person presses Retire) and `ColleagueHandoff.retire`
// (Nova retires through the `colleague` tool). Splitting the rule across them is exactly the
// "one rule, two doors" shape that has already produced five defects in this program, so it lives
// here and they both call it.

/**
 * Archive every live root chat belonging to an id.
 *
 * ⚠️ **The set is read ONCE, up front.** The obvious shape — ask for the newest chat, archive it, ask
 * again — is a spin waiting to happen: archiving is EVENT-SOURCED (`patchSessionRecord` publishes,
 * the projector writes), so a re-read that runs before the projection lands returns the same chat and
 * the loop publishes the same update again. Reading the list first makes the work finite and the
 * lagging projection harmless.
 */
const archiveChats = (input: {
  readonly db: Database.Interface["db"]
  readonly events: EventV2.Interface
  readonly agent: string
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    const at = DateTime.makeUnsafe(Date.now())
    for (const chat of yield* RosterChat.liveChatsFor(input.db, input.agent))
      yield* SessionPatch.patchSessionRecord(
        { db: input.db, events: input.events },
        SessionSchema.ID.make(chat.id),
        (info) => ({ ...info, time: { ...info.time, archived: at } }),
      )
  })

/**
 * The scope a colleague's private memories are written under.
 *
 * ⚠️ It DELEGATES rather than repeating the template. A second `agent:${id}` spelled out here would
 * be a key that is really a spelling — the two would agree until one changed, and the failure would
 * be a cabinet nobody clears rather than an error anybody sees. `undefined` is impossible for a real
 * id and is treated as "nothing to clear" rather than being forced.
 */
export const cabinetOf = (agent: string): string | undefined => MemoryAccess.agentScope(agent)

/**
 * Erase everything keyed on a retired colleague's id.
 *
 * ⚠️ **Best-effort on the memory half, and LOUD about it.** An unreachable embedder must not turn a
 * retirement into a failed request — the role is already gone from the store by the time we get
 * here, so failing now would leave the user with a colleague that is half-retired and no way to
 * finish the job. But best-effort means the ACT survives, not that nobody is told: the failure is
 * logged with the scope that still holds rows, which is the one thing an operator needs to clean up
 * by hand. (`Effect.ignore` here was the mistake `session.compaction.archive.failed` documents.)
 */
/**
 * EVERY SUBSYSTEM THAT KEYS ANYTHING ON AN AGENT ID.
 *
 * 🔴 Declared as a LIST rather than left implicit, because the failure this fixes is a subsystem
 * quietly not being cleared. Three escaped the last time: the workspace directory, `default_agent`
 * at the tool door, and schedules. Each was found by someone hitting it, which is the expensive way.
 *
 * ⚠️ **A registry alone was not enough, and that is measured rather than assumed.** `AgentRemoval`
 * uses one, and its listener is registered by a node that has to be LISTED in the instance graph —
 * unlisted, it ships inert and everything still compiles and passes. (Reading that file earlier today
 * it looked like it had no production caller at all.) So the names are declared here and
 * {@link everything} reports any that nothing registered: a cleaner that was never wired is a fact
 * about this instance, not a silence.
 */
export const CLEANERS = ["schedules", "default-agent", "workspace", "status"] as const

export type CleanerName = (typeof CLEANERS)[number]

type Cleaner = { readonly name: CleanerName; readonly clear: (agentID: string) => Effect.Effect<void> }

/**
 * ⚠️ **Per GRAPH, not per process** — `agent/graph-registry.ts` carries the argument. A
 * module-level `Set` here did two things at once: instance A's retirement ran instance B's cleaners
 * against B's stores, and {@link registered} answered the UNION across graphs, so a graph that
 * shipped a cleaner inert reported it wired as long as any other graph in the process had one. The
 * second defeats this list's whole purpose on its own terms.
 */
const cleaners = GraphRegistry.make<Cleaner>()

/** Register one subsystem's cleaner for the life of a scope, in the CALLING graph. */
export const registerCleaner = (name: CleanerName, clear: (agentID: string) => Effect.Effect<void>) =>
  cleaners.register({ name, clear })

/**
 * Which declared cleaners are wired IN ONE GRAPH — the test seam for "did this ship inert?".
 *
 * ⚠️ The graph is named by its `Database` handle, the same object {@link everything} is handed, so
 * the report and the run answer for the same instance.
 */
export const registered = (graph?: GraphRegistry.Graph): ReadonlyArray<CleanerName> =>
  cleaners.entries(graph).map((entry) => entry.name)

export const everything = (input: {
  readonly db: Database.Interface["db"]
  readonly events: EventV2.Interface
  readonly memory: MemoryClient.Interface
  /** Automatic recall/extraction graph, when the caller owns that separate store too. */
  readonly worldMemory?: MemoryClient.Interface
  readonly agent: string
  /** When the retirement happened, in epoch millis — it names the set-aside scope. Passed in rather
   *  than read from the clock so a caller can make the name deterministic in a test. */
  readonly at: number
}): Effect.Effect<void> =>
  Effect.gen(function* () {
    yield* AgentUsage.forget(input.db, input.agent)
    // The CHAT goes too — archived, exactly as "Clear chat" archives it, and for the same reason
    // scaled up. `RosterChat.chatFor` finds a colleague's chat by AGENT ID and ignores nothing else,
    // so a live root session left behind is a transcript the next holder of that id would open into:
    // months of somebody else's conversation, presented as their own. Archived rather than deleted —
    // the user may still want the history, and a retirement is not a purge of the record.
    yield* archiveChats({ db: input.db, events: input.events, agent: input.agent })
    const scope = cabinetOf(input.agent)
    if (scope === undefined) return
    // 🔴 SET ASIDE, not destroyed — changed 2026-08-21 once Nova could retire on its own judgement.
    //
    // Clearing satisfied the anti-bleed rule and nothing else: it also made a retirement final, and a
    // model holding a delete key with no undo is precisely the thing that breaks in your hands. The
    // move satisfies the same rule for free — `agent:<id>` ends up empty either way, so a future
    // colleague drawn on that name inherits nothing — while the bytes survive under a scope no recall
    // path reads (`recallScopes` reads session, agent and global; never `retired:`).
    //
    // ⚠️ It is also the asymmetry this function had against itself: the CHAT was archived and the
    // memories deleted, so a mistaken retire took back half of what it left. One rule now.
    const setAside = `retired:${input.agent}:${input.at}`
    yield* input.memory.moveScope(scope, setAside).pipe(
      Effect.catch((error) =>
        Log.event("kb.scope.clear.failed", {
          "agent.id": input.agent,
          "kb.scope": scope,
          "kb.fault": Log.fault(error),
        }),
      ),
    )
    if (input.worldMemory !== undefined)
      yield* input.worldMemory.moveScope(scope, setAside).pipe(
        Effect.catch((error) =>
          Log.event("kb.scope.clear.failed", {
            "agent.id": input.agent,
            "kb.scope": scope,
            "kb.fault": Log.fault(error),
          }),
        ),
      )

    // 🔴 …and every OTHER subsystem that keys something on this id. Each runs independently and each
    // failure is REPORTED, never fatal: a schedule that could not be cleared must not stop the
    // memory cabinet being set aside, and half a retirement with no account of which half is the
    // state an operator cannot clean up by hand.
    // ⚠️ Keyed on THIS retirement's own `db`, so a second instance in the same process neither
    // contributes a cleaner nor is reported as having wired one.
    const wired = new Set(registered(input.db))
    for (const entry of cleaners.entries(input.db))
      yield* entry.clear(input.agent).pipe(
        Effect.catchCause((cause) =>
          Log.event("agent.retire.cleaner.failed", {
            "agent.id": input.agent,
            "agent.cleaner": entry.name,
            "agent.fault": Log.fault(cause),
          }),
        ),
      )
    // ⚠️ A DECLARED cleaner that nothing registered is reported too. `AgentRemoval`'s own listener
    // ships inert if its node is left out of the instance graph — everything still compiles and
    // passes — so "nobody registered" has to be a line in the log rather than a silence.
    for (const name of CLEANERS)
      if (!wired.has(name))
        yield* Log.event("agent.retire.cleaner.missing", { "agent.id": input.agent, "agent.cleaner": name })
  })
