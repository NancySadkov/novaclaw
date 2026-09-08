export * as AgentStatus from "./agent-status"

import { desc, eq } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { AgentStatusTable } from "./agent-status/sql"
import { Database } from "./database/database"
import { makeGlobalNode } from "./effect/app-node"

/**
 * What each colleague is currently working on — the store half.
 *
 * Lifecycle sampling owns the derivation decision; this component only persists and removes the
 * current line. Keeping observation and storage separate lets future entity samplers (such as a
 * watchdog) share the event observer without turning this table into a scheduler.
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
   * Forget a colleague's line entirely.
   *
   * 🔴 There has to be a DELETE path, and its absence was the whole defect: officer names come from
   * a fixed pool, so a retired id returns, and a row nothing can remove is a sentence about work a
   * stranger did, stamped onto the next colleague drawn on that name. Every other component keyed on
   * an agent id already has one (`AgentRetire.CLEANERS`); this one had `set` and nothing else, so
   * the retirement had nothing to call.
   *
   * ⚠️ Deleted rather than blanked. An empty `task` is still a row — "no line yet" and "a line that
   * says nothing" are different states and only one of them is true after a retirement.
   */
  readonly remove: (agent: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/AgentStatus") {}

/** Cycle-free removal seam for entity teardown paths that already own the database. */
export const removeFrom = (db: Database.Interface["db"], agent: string): Effect.Effect<void> =>
  db.delete(AgentStatusTable).where(eq(AgentStatusTable.agent, agent)).run().pipe(Effect.orDie, Effect.asVoid)

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
      remove: Effect.fn("AgentStatus.remove")(function* (agent: string) {
        yield* removeFrom(db, agent)
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
