export * as ScratchHorizon from "./horizon"

import path from "node:path"
import { and, eq, isNull } from "drizzle-orm"
import { Effect, Semaphore } from "effect"
import { DAY_MS, DEFAULT_HORIZON_DAYS } from "@novaclaw/schema/scratch-horizon"
import { Log } from "@novaclaw/schema/log"
import { AgentV2 } from "../agent"
import { AgentConfigStore } from "../agent-config-store"
import type { ConfigAgent } from "../config/agent"
import type { Database } from "../database/database"
import { Scratch } from "../scratch"
import type { SessionSchema } from "../session/schema"
import { SessionTable } from "../session/sql"
import { ScratchHorizonTable } from "./horizon.sql"
import { ScratchTrash } from "./trash"

type Db = Database.Interface["db"]
const lock = Semaphore.makeUnsafe(1)

export interface Notice {
  readonly agent: string
  readonly sessionID: SessionSchema.ID
  readonly sessionEpoch: number
  readonly cycleAt: number
  readonly text: string
}

export type Deliver = (notice: Notice) => Effect.Effect<void, unknown>

export const noticeText = (list: string, days: number) =>
  `Scratch cleanup: "${list}" lists files older than ${days} days. ` +
  `If you still need any of these files, touch them. If you need most of them, delete the ones you don't need ` +
  `and then delete trash-list.txt. Listed files still older than ${days} days will be deleted at the next ` +
  `cleanup, in ${days} days.`

export const sweep = (
  db: Db,
  roster: Record<string, readonly ConfigAgent.Info[]>,
  deliver: Deliver,
  now: number,
): Effect.Effect<number> =>
  lock.withPermit(
    Effect.gen(function* () {
      const sessions = yield* db
        .select({
          id: SessionTable.id,
          agent: SessionTable.agent,
          born: SessionTable.time_created,
        })
        .from(SessionTable)
        .where(and(isNull(SessionTable.parent_id), isNull(SessionTable.time_archived)))
        .all()
        .pipe(Effect.orDie)
      let completed = 0
      for (const chat of sessions) {
        const agent = chat.agent
        if (!agent || (agent !== AgentV2.NOVA_ID && roster[agent] === undefined)) continue
        const configured = AgentConfigStore.fold(roster[agent] ?? [])
        if (
          !AgentV2.isColleague({ id: agent, ...configured }) ||
          AgentV2.kindOf(configured) !== "agent" ||
          configured?.disabled
        )
          continue
        const days = configured?.horizonDays ?? DEFAULT_HORIZON_DAYS
        const finished = yield* Effect.gen(function* () {
          const stored = yield* db
            .select()
            .from(ScratchHorizonTable)
            .where(eq(ScratchHorizonTable.agent, agent))
            .get()
            .pipe(Effect.orDie)
          let state = stored?.session_id === chat.id ? stored : undefined
          const policyChanged = state !== undefined && state.horizon_days !== days
          if (
            !policyChanged &&
            (!state || state.phase === "idle") &&
            now - (state?.completed_at ?? chat.born) < days * DAY_MS
          )
            return false
          const folder = path.resolve(Scratch.forAgent(agent))
          if (path.dirname(folder) !== path.resolve(Scratch.root())) throw new Error(`Invalid scratch owner: ${agent}`)
          const trash = yield* Effect.tryPromise(() => ScratchTrash.open(folder))
          if (!trash) return false
          if (!state || state.phase === "idle" || policyChanged) {
            const previous = policyChanged ? undefined : state
            state = { agent, session_id: chat.id, completed_at: null, cycle_at: now, horizon_days: days, phase: "scan" }
            yield* db
              .insert(ScratchHorizonTable)
              .values(state)
              .onConflictDoUpdate({
                target: ScratchHorizonTable.agent,
                set: state,
              })
              .run()
              .pipe(Effect.orDie)
            if (previous)
              yield* Effect.tryPromise(() => trash.removeListed(now - days * DAY_MS)).pipe(Effect.uninterruptible)
          }
          const cycle = state
          const update = (values: Partial<typeof ScratchHorizonTable.$inferInsert>) =>
            db
              .update(ScratchHorizonTable)
              .set(values)
              .where(
                and(
                  eq(ScratchHorizonTable.agent, agent),
                  eq(ScratchHorizonTable.session_id, chat.id),
                  eq(ScratchHorizonTable.cycle_at, cycle.cycle_at),
                ),
              )
              .run()
              .pipe(Effect.orDie)
          if (cycle.phase === "scan") {
            const files = yield* Effect.tryPromise(() => trash.scan(cycle.cycle_at - cycle.horizon_days * DAY_MS))
            yield* Effect.tryPromise(() => trash.write(files)).pipe(Effect.uninterruptible)
            yield* update({ phase: "notify" })
          }
          if ((yield* Effect.tryPromise(() => trash.read())).length > 0) {
            yield* deliver({
              agent,
              sessionID: chat.id,
              sessionEpoch: chat.born,
              cycleAt: cycle.cycle_at,
              text: noticeText(trash.list, cycle.horizon_days),
            })
          }
          yield* update({ phase: "idle", completed_at: now })
          return true
        }).pipe(
          Effect.catchCause((cause) =>
            Log.event("instance.schedule.tick.failed", {
              "instance.cause": Log.fault(cause),
            }).pipe(Effect.as(false)),
          ),
        )
        if (finished) completed++
      }
      return completed
    }),
  )
