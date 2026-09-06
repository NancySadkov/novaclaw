export * as AgentUsage from "./usage"

import { and, desc, eq, gte, inArray, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"

/** The drizzle handle the projector and the stores share. */
type Db = Database.Interface["db"]
import { AgentTokenMinuteTable } from "./usage.sql"

// Reading and writing a colleague's per-minute spend (`usage.sql.ts` holds the why).

/** The bucket a moment belongs to. ONE definition, so a writer and a reader can never disagree
 *  about which minute a step landed in. */
export const minuteOf = (instant: number): number => Math.floor(instant / 60_000)

/** Generated tokens = what the model PRODUCED. Prompt ingestion is not work a person recognises. */
export const generatedOf = (tokens: { readonly output?: number; readonly reasoning?: number }): number =>
  (tokens.output ?? 0) + (tokens.reasoning ?? 0)

/**
 * Add one step's spend to a colleague's minute.
 *
 * 🔴 **Nothing is written for a zero.** A step that produced no tokens (a pure tool call, a refusal,
 * an interrupted turn) leaves no row, so an absent minute keeps meaning "nothing happened" rather
 * than "observed, and it was zero". Guarded here rather than at the call site so every future caller
 * inherits the rule instead of having to remember it.
 */
export const record = (db: Db, input: { readonly agent: string; readonly generated: number; readonly at: number }) =>
  Effect.suspend(() => {
    if (input.generated <= 0 || input.agent === "") return Effect.void
    const minute = minuteOf(input.at)
    return db
      .insert(AgentTokenMinuteTable)
      .values({ agent: input.agent, minute, generated: input.generated })
      .onConflictDoUpdate({
        target: [AgentTokenMinuteTable.agent, AgentTokenMinuteTable.minute],
        // Several steps can finish inside one minute, and sub-agents finish concurrently with their
        // officer — so the row ACCUMULATES rather than being replaced. A last-writer-wins update
        // here would silently under-report exactly when a colleague is busiest.
        set: { generated: sql`${AgentTokenMinuteTable.generated} + ${input.generated}` },
      })
      .run()
      .pipe(Effect.orDie)
  })

export interface Minute {
  readonly minute: number
  readonly generated: number
}

/** A colleague's spend since a given minute, newest first. Sparse by construction — the gaps are
 *  the quiet minutes, and a caller that wants a dense series fills them itself. */
export const since = (db: Db, input: { readonly agent: string; readonly minute: number }) =>
  db
    .select({ minute: AgentTokenMinuteTable.minute, generated: AgentTokenMinuteTable.generated })
    .from(AgentTokenMinuteTable)
    .where(and(eq(AgentTokenMinuteTable.agent, input.agent), gte(AgentTokenMinuteTable.minute, input.minute)))
    .orderBy(desc(AgentTokenMinuteTable.minute))
    .all()
    .pipe(Effect.orDie)

/** One query for a roster's sparse usage series. Missing agents remain present as empty arrays. */
export const sinceMany = (db: Db, input: { readonly agents: readonly string[]; readonly minute: number }) => {
  const agents = [...new Set(input.agents)].filter((agent) => agent.length > 0)
  if (agents.length === 0) return Effect.succeed({} as Record<string, readonly Minute[]>)
  return db
    .select({
      agent: AgentTokenMinuteTable.agent,
      minute: AgentTokenMinuteTable.minute,
      generated: AgentTokenMinuteTable.generated,
    })
    .from(AgentTokenMinuteTable)
    .where(and(inArray(AgentTokenMinuteTable.agent, agents), gte(AgentTokenMinuteTable.minute, input.minute)))
    .orderBy(desc(AgentTokenMinuteTable.minute))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => {
        const result: Record<string, Minute[]> = Object.fromEntries(agents.map((agent) => [agent, []]))
        for (const row of rows) result[row.agent]?.push({ minute: row.minute, generated: row.generated })
        return result
      }),
    )
}

/**
 * Drop everything recorded for a colleague.
 *
 * 🔴 Called when an agent is RETIRED, and the reason is identity bleed rather than tidiness: a
 * retired name returns to the pool, so a future "Theron" would otherwise open with the old Theron's
 * rate on its row — a measurement of work it never did, under a name it did not do it under. The
 * session rows keep their own totals, so nothing about what the instance spent is lost here; what
 * goes is the attribution to a colleague that no longer exists.
 */
export const forget = (db: Db, agent: string) =>
  db.delete(AgentTokenMinuteTable).where(eq(AgentTokenMinuteTable.agent, agent)).run().pipe(Effect.orDie)
