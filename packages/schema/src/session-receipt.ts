export * as SessionReceipt from "./session-receipt"

import { Schema } from "effect"

/**
 * The wire shape of "What Nova checked" — the verified-autonomy receipt.
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
  exitCode: Schema.NullOr(Schema.Finite),
  timedOut: Schema.Boolean,
  durationMs: Schema.NullOr(Schema.Finite),
  at: Schema.Finite,
}).annotate({ identifier: "SessionReceipt.Check" })

export const PlanItem = Schema.Struct({
  content: Schema.String,
  status: Schema.String,
  priority: Schema.String,
  position: Schema.Finite,
}).annotate({ identifier: "SessionReceipt.PlanItem" })

/**
 * One tool call a pre-action policy INTERVENED on. Never one per tool call.
 *
 * 🔴 **The wire half of *"bind every intervention to a receipt"* — the typed pre-action policies of
 * AGENTS.md design principle 13.** The composer has read these rows since the kernel landed, and until this
 * field existed the success schema dropped them on the way out — so an intervention was durable,
 * correct in every unit test, and invisible to every caller. A rewritten tool call the product
 * never tells anyone about is precisely what the receipt exists to prevent, so the absence was the
 * feature failing quietly rather than a field nobody had got round to.
 *
 * ⚠️ **Everything here except `at` is DATA, not our claim.** `decision`, `providers[].id` and the
 * two prose fields are supplied by whichever policy provider was installed — today only NovaClaw's
 * own built-ins, but the `Provider` interface is the same one a plugin implements. A surface
 * rendering these must treat them as third-party author text (the Skills app's `authorText` rule),
 * and must not promote an unrecognised `decision` into a verdict it understands.
 */
export const PolicyDecision = Schema.Struct({
  /** The provider-assigned id of the tool call this governed — the join back to the transcript. */
  toolCallID: Schema.String,
  /** The registered tool name, as the model called it. */
  tool: Schema.String,
  /**
   * `context` | `patch` | `approve` | `deny` | `halt` — and `allow` only when a policy went silent.
   *
   * ⚠️ Deliberately a `String` and not a literal union. The vocabulary is the kernel's
   * (`ToolPolicy.RANK`), a stored row outlives the build that wrote it, and a decoder that refused
   * an unfamiliar word would turn a receipt written by a newer NovaClaw into a 500 on the one
   * screen a user consults after something was refused.
   */
  decision: Schema.String,
  /** One sentence, in the words the MODEL was given. Evidence has to read the same to both. */
  detail: Schema.String,
  /**
   * Every consulted policy and what it answered, in policy-id order.
   *
   * 🔴 Carries the ones that said `allow` too, and that is the point: a list of only the intervening
   * policy cannot answer *"was the guard even running?"* — the question a person asks after
   * something got through. `outcome` is also where an unavailable provider is reported as
   * `timed-out`/`errored` rather than as the deny it was composed into.
   */
  providers: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      outcome: Schema.String,
      detail: Schema.optional(Schema.String),
    }),
  ),
  /**
   * The tool-input fields as REPLACED, never a diff — the before-value is the tool call itself,
   * which the transcript already holds. Absent when nothing was rewritten.
   */
  patched: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  at: Schema.Finite,
}).annotate({ identifier: "SessionReceipt.PolicyDecision" })

export const Info = Schema.Struct({
  attemptID: Schema.String,
  generation: Schema.Finite,
  /** `busy · settled · failed · interrupted · paused · recovering`. */
  state: Schema.String,
  startedAt: Schema.Finite,
  /** The plan as DECLARED, frozen when the attempt opened — never the live list. */
  declaredPlan: Schema.Array(PlanItem),
  checks: Schema.Array(Check),
  /**
   * Pre-action policy interventions inside this attempt's window. See {@link PolicyDecision}.
   *
   * ⚠️ EMPTY is a positive statement, not an absence of information: a row exists only where
   * something happened, so an empty list says every installed policy allowed every call in this
   * attempt, in time. A surface must render it as that sentence rather than hiding the section.
   */
  policies: Schema.Array(PolicyDecision),
  /**
   * The serving processes that answered this attempt (`system_fingerprint`), first-seen order.
   * ⚠️ Empty means no response reported one — never "unknown process".
   */
  servedBy: Schema.Array(Schema.String),
  /** Spawned sessions, by id. Their receipts are separate reads, deliberately — see the composer. */
  children: Schema.Array(Schema.String),
}).annotate({ identifier: "SessionReceipt.Info" })
export type Info = typeof Info.Type
