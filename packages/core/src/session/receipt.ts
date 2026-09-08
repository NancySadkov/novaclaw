export * as SessionReceipt from "./receipt"

import { and, asc, eq, gte } from "drizzle-orm"
import { Context, Effect, Layer } from "effect"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import type { SessionSchema } from "./schema"
import { decodeServingIdentities, SessionExecutionTable, SessionTable, TodoSnapshotTable } from "./sql"
import { SessionQualityCheckTable } from "./quality-check.sql"
import { SessionPolicyDecisionTable } from "../tool-policy.sql"

/**
 * "What Nova checked" — the task receipt, composed from durable sources.
 *
 * The governing rule: *mechanical evidence is authoritative; model judgment may explain
 * or calibrate but never promote.* So every field here is READ from a table that something else
 * wrote as it happened. Nothing is inferred, and nothing is asked of a model.
 *
 * ⚠️ This is the relational subset, not the whole of V1. Two of the inventory's inputs are still
 * absent — tools/effects and file versions — because they live inside message JSON rather than in a
 * column, and extracting them is its own piece of work. They are absent rather than stubbed: a
 * receipt field that always says "unknown" trains its reader to skip the receipt.
 *
 * Serving provenance was the third and is now a column (`servedBy`), written by the drain from what
 * the responses themselves reported.
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

/**
 * One tool call a pre-action policy INTERVENED on. Never one per tool call.
 *
 * Typed pre-action policies (AGENTS.md design principle 13): *"bind every intervention to a receipt."* This is
 * that binding, surfaced through the receipt that already exists rather than through a second
 * document — the question *"what did Nova actually do, and what stopped it"* has one answer here or
 * it has two answers that can disagree.
 *
 * ⚠️ Rows exist only where something happened (`tool-policy.sql.ts` carries why), so an empty list
 * is a positive statement: every installed policy allowed every call in this attempt, in time.
 */
export interface PolicyDecision {
  /** The provider-assigned id of the tool call this governed. */
  readonly toolCallID: string
  readonly tool: string
  /** `context` | `patch` | `approve` | `deny` | `halt` — and `allow` only when a policy went silent. */
  readonly decision: string
  /** One sentence, in the words the model was given. */
  readonly detail: string
  /** Every consulted policy and what it answered, in policy-id order. */
  readonly providers: ReadonlyArray<{ readonly id: string; readonly outcome: string; readonly detail?: string }>
  /** The tool-input fields as REPLACED, or `undefined` when nothing was rewritten. Never a diff. */
  readonly patched?: Record<string, unknown>
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
  /** Pre-action policy interventions inside this attempt's window. See {@link PolicyDecision}. */
  readonly policies: readonly PolicyDecision[]
  /**
   * WHICH serving processes answered this attempt's turns, in first-seen order.
   *
   * The model name on a turn is the alias the config asked for; this is what the endpoint said
   * about ITSELF (`system_fingerprint`). It is what distinguishes two runs of the same alias
   * against a server that was restarted or repointed in between.
   *
   * ⚠️ EMPTY is the common case and does not mean "unknown process" — it means no response
   * reported an identity, which is true of every wire that does not carry the field.
   *
   * ⚠️ More than one entry is not a fault: it says the attempt outlived a change of server. That
   * is a fact about the run, and the receipt is the place it belongs.
   */
  readonly servedBy: readonly string[]
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
          servedBy: SessionExecutionTable.served_by,
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

      /**
       * ⚠️ Bracketed by time, exactly as `checks` is above, and for the same reason: a policy
       * decides inside the drain loop, which does not carry the attempt in scope. The soundness
       * argument is the one stated there — attempts are SERIAL per session — and it fails in the
       * same place if that ever stops being true.
       */
      const policies = yield* db
        .select({
          toolCallID: SessionPolicyDecisionTable.tool_call_id,
          tool: SessionPolicyDecisionTable.tool,
          decision: SessionPolicyDecisionTable.decision,
          detail: SessionPolicyDecisionTable.detail,
          providers: SessionPolicyDecisionTable.providers,
          patched: SessionPolicyDecisionTable.patched,
          at: SessionPolicyDecisionTable.time_created,
        })
        .from(SessionPolicyDecisionTable)
        .where(
          and(
            eq(SessionPolicyDecisionTable.session_id, sessionID),
            gte(SessionPolicyDecisionTable.time_created, attempt.startedAt),
          ),
        )
        .orderBy(asc(SessionPolicyDecisionTable.time_created))
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
        policies: policies.map((row) => ({
          toolCallID: row.toolCallID,
          tool: row.tool,
          decision: row.decision,
          detail: row.detail,
          providers: row.providers,
          // `null` in the column means "nothing was rewritten"; the interface says that with
          // `undefined`, so the two spellings of absence do not both reach a reader.
          ...(row.patched === null ? {} : { patched: row.patched }),
          at: row.at,
        })),
        servedBy: decodeServingIdentities(attempt.servedBy),
        children: children.map((row) => row.id),
      } satisfies Receipt
    })

    return Service.of({ forSession })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Database.node] })
