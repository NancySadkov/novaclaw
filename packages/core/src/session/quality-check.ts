export * as SessionQualityCheck from "./quality-check"

import { createHash } from "node:crypto"
import { and, desc, eq, gte } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { SessionQualityCheckTable } from "./quality-check.sql"

/**
 * Durable evidence that a quality check RAN — verified autonomy's only new write.
 *
 * The table's header carries the shape decisions. This module carries the two rules a CALLER has to
 * get right, and both exist because the alternative silently produces a receipt that reads well and
 * is wrong.
 */

/**
 * What a check did. CLOSED, and `refused` is a member for a reason: a policy refusal is not a failed
 * check. `llm.ts` already draws that line for the steer ("a policy refusal is not a broken check"),
 * and an evidence row that spelled both `failed` would let a receipt report the user's own permission
 * posture as a defect in their code.
 */
export type Outcome = "passed" | "failed" | "refused" | "errored"

export interface Record {
  readonly sessionID: string
  readonly label: string
  readonly command: string
  readonly outcome: Outcome
  /** Absent = NO PROCESS RAN. Never pass 0 to mean "we do not know" — see {@link record}. */
  readonly exitCode?: number
  readonly timedOut?: boolean
  readonly durationMs?: number
  readonly at: number
}

/**
 * A deterministic id, so the same check recorded twice for one moment collides instead of doubling.
 *
 * ⚠️ The drain runs the SAME label many times per turn (`dueMidLoop` fires per touched file), and
 * those are genuinely different runs that must all survive — so `at` is in the key. This dedups a
 * retry of one write, not two real runs.
 */
const id = (input: Record) =>
  "qc_" +
  createHash("sha256")
    .update(`${input.sessionID}\n${input.label}\n${input.command}\n${input.at}`)
    .digest("hex")
    .slice(0, 24)

/**
 * Write one row. Best-effort by contract: the caller is a drain step that must not be broken by its
 * own bookkeeping.
 *
 * ⚠️ **`exitCode` is written as NULL when absent, never coerced to 0.** A receipt that cannot tell
 * "the process exited 0" from "no process ever ran" is the ambiguous blank
 * that verified autonomy names as its second gap — and on an evidence document an ambiguous
 * blank reads as zero, i.e. as success.
 */
export const record = (db: Database.Interface["db"], input: Record) =>
  Effect.gen(function* () {
    yield* db
      .insert(SessionQualityCheckTable)
      .values({
        id: id(input),
        session_id: input.sessionID,
        label: input.label,
        command: input.command,
        outcome: input.outcome,
        exit_code: input.exitCode ?? null,
        timed_out: input.timedOut ?? false,
        duration_ms: input.durationMs ?? null,
        time_created: input.at,
      })
      .onConflictDoNothing()
  })

/** Every recorded run for one session, newest first. The read half a receipt composes from. */
export const forSession = (db: Database.Interface["db"], sessionID: string, since?: number) =>
  Effect.gen(function* () {
    const where =
      since === undefined
        ? eq(SessionQualityCheckTable.session_id, sessionID)
        : and(eq(SessionQualityCheckTable.session_id, sessionID), gte(SessionQualityCheckTable.time_created, since))
    return yield* db
      .select()
      .from(SessionQualityCheckTable)
      .where(where)
      .orderBy(desc(SessionQualityCheckTable.time_created))
  })
