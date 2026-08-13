export * as SessionReceipt from "./receipt"

import { and, asc, eq, gte } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import type { SessionSchema } from "./schema"
import { SessionExecutionTable, SessionTable, TodoSnapshotTable } from "./sql"
import { SessionQualityCheckTable } from "./quality-check.sql"

/**
 * "What Nova checked" — the task receipt, composed from durable sources.
 *
 * `todo/verified-autonomy.md` V1: *mechanical evidence is authoritative; model judgment may explain
 * or calibrate but never promote.* So every field here is READ from a table that something else
 * wrote as it happened. Nothing is inferred, and nothing is asked of a model.
 *
 * ⚠️ This is the relational subset, not the whole of V1. Three of the inventory's inputs are still
 * absent — tools/effects, file versions and serving provenance — because they live inside message
 * JSON rather than in a column, and extracting them is its own piece of work. They are absent rather
 * than stubbed: a receipt field that always says "unknown" trains its reader to skip the receipt.
 */

/** One run of one quality check. Never per definition — the same label runs many times in a drain. */
export interface Check {
  readonly label: string
  readonly command: string
  readonly outcome: string
  /**
   * ⚠️ `null` MEANS something: no process existed. `refused` never ran one and `errored` failed
   * before or during spawn, so a `0` here would report a clean exit for a check that never started.
   */
  readonly exitCode: number | null
  readonly timedOut: boolean
  readonly durationMs: number | null
  readonly at: number
}

export interface PlanItem {
  readonly content: string
  readonly status: string
  readonly priority: string
  readonly position: number
}

export interface Receipt {
  readonly attemptID: string
  readonly generation: number
  /** `busy · settled · failed · interrupted · paused · recovering` — the authoritative terminal state. */
  readonly state: string
  readonly startedAt: number
  /** The plan as DECLARED, frozen when the attempt opened — never the live list. */
  readonly declaredPlan: readonly PlanItem[]
  readonly checks: readonly Check[]
  /**
   * Sessions this one spawned. Ordinary sessions with `parent_id` set — the inventory's *children*.
   *
   * ⚠️ Ids only, not their receipts. A receipt that inlined its children's receipts would recurse to
   * whatever depth the run reached, and a reader following one link at a time can stop; a reader
   * handed the whole tree cannot. Each child's own receipt is one more call to `forSession`.
   *
   * ⚠️ This is the tree as it stands NOW, not as of the attempt — a child spawned by a later attempt
   * appears here too. Binding children to an attempt needs a column the spawner does not yet write,
   * and inventing one would be the same lie the checks table refused.
   */
  readonly children: readonly string[]
}

export interface Interface {
  readonly forSession: (sessionID: SessionSchema.ID) => Effect.Effect<Receipt | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/SessionReceipt") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const { db } = yield* Database.Service

    const forSession = Effect.fn("SessionReceipt.forSession")(function* (sessionID: SessionSchema.ID) {
      const attempt = yield* db
        .select({
          attemptID: SessionExecutionTable.attempt_id,
          generation: SessionExecutionTable.generation,
          state: SessionExecutionTable.state,
          startedAt: SessionExecutionTable.started_at,
        })
        .from(SessionExecutionTable)
        .where(eq(SessionExecutionTable.session_id, sessionID))
        .get()
        .pipe(Effect.orDie)
      // A session that has never run has no receipt. `undefined` rather than an empty one: an empty
      // receipt asserts that nothing happened, which is a different claim from "nothing ran yet".
      if (!attempt) return undefined

      const declaredPlan = yield* db
        .select({
          content: TodoSnapshotTable.content,
          status: TodoSnapshotTable.status,
          priority: TodoSnapshotTable.priority,
          position: TodoSnapshotTable.position,
        })
        .from(TodoSnapshotTable)
        .where(eq(TodoSnapshotTable.attempt_id, attempt.attemptID))
        .orderBy(asc(TodoSnapshotTable.position))
        .all()
        .pipe(Effect.orDie)

      /**
       * ⚠️ BRACKETED BY TIME, not joined on the attempt — and that is the table's own instruction.
       * `session_quality_check` is deliberately not keyed to `attempt_id`, because checks run inside
       * the drain loop which does not carry the attempt in scope, and inventing a join key the writer
       * cannot fill would produce a column that is null in practice and lies about being a foreign key.
       *
       * The bracket is sound because attempts are SERIAL per session: the previous attempt ended
       * before this one's `started_at`, so a check at or after that instant belongs to this attempt.
       * ⛔ It stops being sound the moment two attempts of one session can overlap — if that ever
       * becomes possible, this needs the real key, not a wider window.
       */
      const checks = yield* db
        .select({
          label: SessionQualityCheckTable.label,
          command: SessionQualityCheckTable.command,
          outcome: SessionQualityCheckTable.outcome,
          exitCode: SessionQualityCheckTable.exit_code,
          timedOut: SessionQualityCheckTable.timed_out,
          durationMs: SessionQualityCheckTable.duration_ms,
          at: SessionQualityCheckTable.time_created,
        })
        .from(SessionQualityCheckTable)
        .where(
          and(
            eq(SessionQualityCheckTable.session_id, sessionID),
            gte(SessionQualityCheckTable.time_created, attempt.startedAt),
          ),
        )
        .orderBy(asc(SessionQualityCheckTable.time_created))
        .all()
        .pipe(Effect.orDie)

      // Ordinary sessions with this one as parent — the `session_parent_idx` the inventory names.
      const children = yield* db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(eq(SessionTable.parent_id, sessionID))
        .orderBy(asc(SessionTable.id))
        .all()
        .pipe(Effect.orDie)

      return {
        attemptID: attempt.attemptID,
        generation: attempt.generation,
        state: attempt.state,
        startedAt: attempt.startedAt,
        declaredPlan,
        checks: checks.map((row) => ({ ...row, timedOut: Boolean(row.timedOut) })),
        children: children.map((row) => row.id),
      } satisfies Receipt
    })

    return Service.of({ forSession })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
