export * as CalendarScheduler from "./scheduler"

// Calendar / cron-session creator (P2): the ticker's decision logic, isolated from boot wiring and the real
// session launch (P3) so it is deterministically unit-testable. `tick` runs one poll cycle: fire every DUE
// schedule exactly once (idempotent via the store's fire ledger), then roll it forward. Catch-up policy is
// fire-once — a schedule missed while the instance was down fires its due occurrence once and jumps to the
// next FUTURE occurrence (advance computes strictly after `now`); missed intermediate occurrences are not
// replayed (no thundering herd). A launch failure is isolated (never wedges the loop), recorded as `error`,
// and the schedule still advances.

import { Clock, Context, Duration, Effect, Layer, Schedule } from "effect"
import { AgentV2 } from "../agent"
import { AgentConfigStore } from "../agent-config-store"
import { AgentWorkspace } from "../agent/workspace"
import { Database } from "../database/database"
import { makeGlobalNode, tags } from "../effect/app-node"
import { LayerNode } from "../effect/layer-node"
import { Global } from "../global"
import { ModelV2 } from "../model"
import { AbsolutePath } from "../schema"
import { SessionV2 } from "../session"
import type { EpochMillis } from "./recurrence"
import { CalendarStore } from "./store"
import { Log } from "@novaclaw/schema/log"

export interface LaunchInput {
  readonly schedule: CalendarStore.Schedule
  readonly occurrenceMillis: number
  readonly firedAt: number
}

/**
 * Create + start the session for a fired schedule. Returns the new session id, or null on no-session.
 * May fail — `tick` absorbs every cause so a bad launch never wedges the poll loop.
 */
export type Launch = (input: LaunchInput) => Effect.Effect<string | null, unknown>

export interface TickResult {
  /** Occurrences that launched a session this cycle. */
  readonly fired: number
  /** Due occurrences that were already claimed by a prior cycle, or whose launch produced no session. */
  readonly skipped: number
}

type Db = Database.Interface["db"]

/** One poll cycle. `now` is injected (the boot loop passes `yield* Clock.currentTimeMillis`). */
export const tick = (db: Db, launch: Launch, now: EpochMillis): Effect.Effect<TickResult> =>
  Effect.gen(function* () {
    const due = yield* CalendarStore.due(db, now)
    let fired = 0
    let skipped = 0
    for (const schedule of due) {
      const occurrence = schedule.nextFireAt
      if (occurrence === null) continue // due() already excludes nulls; defensive.

      // Claim the occurrence BEFORE doing any work — the idempotency guard against overlapping
      // ticks / a restart mid-fire. A losing claim means another cycle already handled it.
      const claimed = yield* CalendarStore.recordFire(db, {
        scheduleId: schedule.id,
        occurrenceMillis: occurrence,
        firedAt: now,
        status: "spawned",
      })
      if (claimed) {
        const sessionId = yield* launch({ schedule, occurrenceMillis: occurrence, firedAt: now }).pipe(
          // A bad launch must never kill the poll loop — record it and move on.
          Effect.catchCause(() => Effect.succeed(null)),
        )
        yield* CalendarStore.setFireOutcome(db, {
          scheduleId: schedule.id,
          occurrenceMillis: occurrence,
          sessionId,
          status: sessionId ? "spawned" : "error",
        })
        if (sessionId !== null) fired++
        else skipped++
      } else {
        skipped++
      }

      // Roll forward regardless so this occurrence is never re-returned by due().
      yield* CalendarStore.advance(db, schedule.id, now)
    }
    return { fired, skipped }
  })

/**
 * The real launch seam (P3): create a goal-oriented session at the schedule's location (its own directory,
 * else the instance home) and QUEUE its prompt through the canonical spawner. Typed to only the one
 * SessionV2 method it uses, so it is
 * unit-testable with a fake. Returns the new session id. `metadata` stamps the schedule + occurrence so a
 * fired run is traceable back to its schedule.
 */
/**
 * Where a colleague works, asked of the LIVE roster. `undefined` = no such colleague, or it has no
 * folder of its own. Passed in as a function rather than a service so this stays unit-testable with a
 * fake, exactly like `sessions`.
 */
export type FolderOf = (agentID: string) => Effect.Effect<string | undefined>

export const makeLaunch =
  (sessions: Pick<SessionV2.Interface, "spawn">, homeDir: string, folderOf?: FolderOf): Launch =>
  (input) =>
    Effect.gen(function* () {
      const { schedule } = input
      // Per-schedule overrides; absent = inherit the instance default agent/model. Model string is
      // "providerID/modelID" (split so the modelID may itself contain "/").
      let model: ModelV2.Ref | undefined
      if (schedule.model) {
        const { providerID, modelID } = ModelV2.parse(schedule.model)
        model = ModelV2.Ref.make({ id: modelID, providerID })
      }
      // 🔴 NOVA owns an unowned task (owner, 2026-08-21: *"the calendar / schedule should have a
      // model responsible for each task, defaulting to the Nova itself"*).
      //
      // Absent used to mean "the instance default agent", which is `build` — the machinery a person
      // drives, not a colleague on the roster. A scheduled run is the case with NOBODY watching, so
      // the question "who is accountable for this" has to have an answer that is a name: under the
      // metaphor that is the CEO, who routes work it does not do itself. It also means every
      // scheduled task's output lands in a chat the user can find on the roster, rather than in a
      // session belonging to an agent nobody thinks of as a person.
      const agent = AgentV2.ID.make(schedule.agent ?? AgentV2.NOVA_ID)
      // 🔴 A task inherits the RESPONSIBLE COLLEAGUE's folder, not the instance home. Under the roster
      // the folder is part of the job — you assign the bookkeeper to the books once — so a scheduled
      // run that landed in `~` would put a colleague somewhere it has never worked and give it a
      // system prompt naming a folder its files are not in. An explicit per-task folder still wins:
      // that is a user saying "this particular job happens over there".
      //
      // ⚠️ Read at FIRE time, never stored: a colleague reassigned between "save this schedule" and
      // "it fires at 6am" must fire in its new folder. A snapshot taken at save time is the same stale
      // -config bug `self` and the reassignment notice exist to prevent.
      const own = folderOf === undefined ? undefined : yield* folderOf(agent)
      const directory = schedule.location ?? own ?? homeDir
      // THE CANONICAL SEAM (v0.2.0 prep, 2026-08-11) — was `create()` + `prompt()`. A Calendar launch
      // is ROOTLESS, so it passes `location` instead of a `parentID`, and the fork-bomb guards are
      // skipped BY CONSTRUCTION (see `SessionSpawner.SpawnInput.parentID`): there is no parent to
      // count fan-out from, and what bounds a scheduled run is its own schedule. What it gains is one
      // create → enqueue → hand-to-executor path, and `started` — an honest answer to "did this
      // actually begin?" that the two-call version could not give.
      const spawned = yield* sessions.spawn({
        location: { directory: AbsolutePath.make(directory) },
        text: schedule.prompt,
        type: "goal-oriented",
        title: schedule.title || "Scheduled run",
        ...(model ? { model } : {}),
        agent,
        // Per-schedule permission posture; absent = inherit the default. A scheduled run is unattended, so
        // "ask" would stall waiting for an approval nobody's there to give — the UI defaults to "bypass"
        // (act within its work folder; external-directory writes still gate).
        ...(schedule.permissionMode
          ? { permissionMode: schedule.permissionMode as "plan" | "ask" | "surgical" | "bypass" | "yolo" }
          : {}),
        metadata: { calendarScheduleID: schedule.id, occurrenceMillis: input.occurrenceMillis },
      })
      if (!spawned.started)
        yield* Log.event("instance.scheduler.launch.unstarted", { "session.id": spawned.id })
      return spawned.id
    })

/** Seconds between poll ticks. Sub-minute so a schedule due "now" fires promptly; the scan is index-cheap. */
export const TICK_INTERVAL_SECONDS = 30

export interface Interface {
  readonly running: true
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/CalendarScheduler") {}

/**
 * The background poll loop (P3). Leaves Database + SessionV2 + Global as UNSATISFIED requirements so the
 * serve binds them to the SHARED singletons (mirror the messenger gateway). The production capability uses
 * `sharedServiceNode` before the SessionV2 provide; `node` exists for closed graphs/tests. Never put that closed
 * node in the production app group — compiling a second SessionV2 would launch into the wrong runtime.
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const sessions = yield* SessionV2.Service
    const global = yield* Global.Service
    const roster = yield* AgentConfigStore.Service
    // The store is GLOBAL (it needs only `db`), which is why this is reachable at all: `AgentV2` — the
    // per-location view of the same rows — is a LOCATION node, and a global node listing it as a dep
    // fails the graph with "Invalid tag dependencies". The scheduler is instance-wide by nature.
    const launch = makeLaunch(
      sessions,
      global.home,
      Effect.fn("CalendarScheduler.folderOf")(function* (agentID: string) {
        const declared = AgentConfigStore.fold((yield* roster.agents())[agentID] ?? [])
        if (declared === undefined) return undefined
        const directory = (declared as unknown as Record<string, unknown>)["directory"]
        return AgentWorkspace.folderFor({
          agentID,
          directory: typeof directory === "string" ? directory : undefined,
        })
      }),
    )
    yield* Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      yield* tick(db, launch, now)
    }).pipe(
      Effect.catchCause((cause) => Log.event("instance.scheduler.tick.failed", { "instance.cause": Log.fault(cause) })),
      Effect.repeat(Schedule.spaced(Duration.seconds(TICK_INTERVAL_SECONDS))),
      Effect.delay(Duration.seconds(5)),
      Effect.forkScoped,
    )
    return Service.of({ running: true })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, SessionV2.node, Global.node, AgentConfigStore.node],
})

export const sharedServiceNode = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    LayerNode.external(Database.Service, tags.values.global),
    LayerNode.external(SessionV2.Service, tags.values.global),
    LayerNode.external(Global.Service, tags.values.global),
    LayerNode.external(AgentConfigStore.Service, tags.values.global),
  ],
})

export const capabilityNode = LayerNode.capability(node, { name: "calendar-scheduler", service: Service })
export const CapabilityService = capabilityNode.service
export const sharedCapabilityNode = LayerNode.capability(sharedServiceNode, {
  name: "calendar-scheduler",
  service: Service,
})
