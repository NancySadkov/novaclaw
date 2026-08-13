export * as SessionReceipt from "./session-receipt"

import { Schema } from "effect"

/**
 * The wire shape of "What Nova checked" — `todo/verified-autonomy.md` V1.
 *
 * ⚠️ Lives in `@novaclaw/schema` rather than beside the composer in core, because the protocol group
 * and the app both need it and neither may import core. The composer's own interfaces are the same
 * shape; this is the copy that crosses a boundary.
 */

/** One RUN of one quality check — never one per check definition. */
export const Check = Schema.Struct({
  label: Schema.String,
  /** What actually ran. A label without its command is a claim, not evidence. */
  command: Schema.String,
  /** `passed` | `failed` | `refused` | `errored` — a refusal is not a failure. */
  outcome: Schema.String,
  /**
   * ⚠️ NULLABLE, and the null MEANS something: no process existed. `refused` never started one, so a
   * `0` here would report a clean exit for a check that never ran.
   */
  exitCode: Schema.NullOr(Schema.Number),
  timedOut: Schema.Boolean,
  durationMs: Schema.NullOr(Schema.Number),
  at: Schema.Number,
}).annotate({ identifier: "SessionReceipt.Check" })

export const PlanItem = Schema.Struct({
  content: Schema.String,
  status: Schema.String,
  priority: Schema.String,
  position: Schema.Number,
}).annotate({ identifier: "SessionReceipt.PlanItem" })

export const Info = Schema.Struct({
  attemptID: Schema.String,
  generation: Schema.Number,
  /** `busy · settled · failed · interrupted · paused · recovering`. */
  state: Schema.String,
  startedAt: Schema.Number,
  /** The plan as DECLARED, frozen when the attempt opened — never the live list. */
  declaredPlan: Schema.Array(PlanItem),
  checks: Schema.Array(Check),
  /**
   * The serving processes that answered this attempt (`system_fingerprint`), first-seen order.
   * ⚠️ Empty means no response reported one — never "unknown process".
   */
  servedBy: Schema.Array(Schema.String),
  /** Spawned sessions, by id. Their receipts are separate reads, deliberately — see the composer. */
  children: Schema.Array(Schema.String),
}).annotate({ identifier: "SessionReceipt.Info" })
export type Info = typeof Info.Type
