export * as AgentStatus from "./agent-status"

import { and, desc, eq, inArray, isNotNull, max, sql } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { AgentStatusTable } from "./agent-status/sql"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"
import { SessionExecutionTable, SessionMessageTable, SessionTable } from "./session/sql"
import type { Candidate } from "./agent-status/refresh"

/**
 * What each colleague is currently working on — the store half.
 *
 * The component and the refresh DECISION live in `agent-status/`; this is what reads and writes it,
 * plus the one query that answers *"has this colleague done anything since we last looked?"*.
 */

export interface Info {
  readonly agent: string
  /** One short line, in the user's own terms. */
  readonly task: string
  /** Epoch millis of the newest activity this label was derived from. */
  readonly observed: number
}

export interface Interface {
  /** Every colleague that has a status line, for the Contacts list. */
  readonly all: () => Effect.Effect<readonly Info[]>
  readonly get: (agent: string) => Effect.Effect<Info | undefined>
  readonly set: (info: Info) => Effect.Effect<void>
  /**
   * Every colleague the refresh pass might act on, with its newest activity and current label.
   *
   * ⚠️ Returns colleagues with NO activity too, `latest: undefined`. The decision needs to see them
   * to answer "never" rather than the pass silently skipping a category — and a filter here would
   * put half the rule in a SQL string where `refresh.ts` cannot be tested against it.
   */
  readonly candidates: () => Effect.Effect<readonly Candidate[]>
  /**
   * The session carrying this colleague's NEWEST message — the one a status line is derived from.
   *
   * ⚠️ Not the colleague's root chat. A delegating officer's newest work is in a sub-session, and
   * reading the root would describe them by whatever they were last asked directly rather than by
   * what they are doing. Same reason `candidates()` counts the whole thread tree.
   */
  readonly newestSession: (agent: string) => Effect.Effect<string | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/AgentStatus") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const row = (r: typeof AgentStatusTable.$inferSelect): Info => ({
      agent: r.agent,
      task: r.task,
      observed: r.observed,
    })

    return Service.of({
      all: Effect.fn("AgentStatus.all")(function* () {
        const rows = yield* db
          .select()
          .from(AgentStatusTable)
          .orderBy(desc(AgentStatusTable.observed))
          .all()
          .pipe(Effect.orDie)
        return rows.map(row)
      }),
      get: Effect.fn("AgentStatus.get")(function* (agent: string) {
        const found = yield* db
          .select()
          .from(AgentStatusTable)
          .where(eq(AgentStatusTable.agent, agent))
          .get()
          .pipe(Effect.orDie)
        return found ? row(found) : undefined
      }),
      set: Effect.fn("AgentStatus.set")(function* (info: Info) {
        const now = Date.now()
        yield* db
          .insert(AgentStatusTable)
          .values({ agent: info.agent, task: info.task, observed: info.observed, time_created: now, time_updated: now })
          .onConflictDoUpdate({
            target: AgentStatusTable.agent,
            set: { task: info.task, observed: info.observed, time_updated: now },
          })
          .run()
          .pipe(Effect.orDie)
      }),
      candidates: Effect.fn("AgentStatus.candidates")(function* () {
        /**
         * The newest message across every session this colleague RUNS AS — its own chat and each
         * sub-session it spawned, since both carry the agent id.
         *
         * ⚠️ Messages rather than the session's `time_updated`. A session row is touched by things
         * that are not work — a title write, a config toggle, a folder move — so keying on it would
         * report a colleague as busy for changes it did not make. A message is something that was
         * actually said or done.
         */
        const activity = yield* db
          .select({ agent: SessionTable.agent, latest: max(SessionMessageTable.time_created) })
          .from(SessionMessageTable)
          .innerJoin(SessionTable, eq(SessionMessageTable.session_id, SessionTable.id))
          .where(
            and(
              isNotNull(SessionTable.agent),
              // "Clear chat" ARCHIVES rather than deletes, so an archived transcript is history the
              // user explicitly set aside. Counting it would pin a colleague's line to work they
              // asked to put away, and report them busy for a conversation they can no longer see.
              sql`${SessionTable.time_archived} IS NULL`,
              // ⚠️ A POSTURE is not a colleague. `build` and `plan` say how a chat RUNS, not whose
              // it is; neither has a Contacts row, so a status line for one is a line nothing can
              // display — and the same distinction the one-live-root index and `defaultTitle` make.
              sql`${SessionTable.agent} NOT IN ('build', 'plan')`,
            ),
          )
          .groupBy(SessionTable.agent)
          .all()
          .pipe(Effect.orDie)

        const current = yield* db.select().from(AgentStatusTable).all().pipe(Effect.orDie)
        const byAgent = new Map(current.map((r) => [r.agent, { observed: r.observed }]))

        /**
         * A status label is decode-shaped maintenance. It must never spend the same device while
         * the colleague is answering a foreground turn, and the durable execution lease is the
         * authoritative answer to whether any session in that colleague's thread tree is active.
         *
         * This is checked after the activity query but before transcript/model work. In particular,
         * the just-written USER message of an in-flight prompt makes a fresh colleague immediately
         * due; without this exclusion the first five-second scheduler tick races the real answer and
         * can reach the model first. Settled/failed/paused attempts are intentionally absent: once
         * generation has stopped, the idle tier may summarize the work it left behind.
         */
        const active = yield* db
          .selectDistinct({ agent: SessionTable.agent })
          .from(SessionTable)
          .innerJoin(SessionExecutionTable, eq(SessionExecutionTable.session_id, SessionTable.id))
          .where(
            and(
              isNotNull(SessionTable.agent),
              inArray(SessionExecutionTable.state, ["starting", "busy", "recovering"]),
            ),
          )
          .all()
          .pipe(Effect.orDie)
        const activeAgents = new Set(active.flatMap((entry) => (entry.agent === null ? [] : [entry.agent])))

        return activity
          .filter(
            (entry): entry is { agent: string; latest: number | null } =>
              entry.agent !== null && !activeAgents.has(entry.agent),
          )
          .map((entry) => ({
            agent: entry.agent,
            latest: entry.latest ?? undefined,
            current: byAgent.get(entry.agent),
          }))
      }),
      newestSession: Effect.fn("AgentStatus.newestSession")(function* (agent: string) {
        const found = yield* db
          .select({ id: SessionTable.id, at: SessionMessageTable.time_created })
          .from(SessionMessageTable)
          .innerJoin(SessionTable, eq(SessionMessageTable.session_id, SessionTable.id))
          .where(
            and(
              eq(SessionTable.agent, agent),
              // The same two exclusions `candidates()` makes, for the same reasons — a status must
              // not be derived from a transcript the user archived, and a posture has no line.
              sql`${SessionTable.time_archived} IS NULL`,
              sql`${SessionTable.agent} NOT IN ('build', 'plan')`,
            ),
          )
          .orderBy(desc(SessionMessageTable.time_created))
          .limit(1)
          .get()
          .pipe(Effect.orDie)
        return found?.id
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
