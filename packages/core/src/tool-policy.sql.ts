import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * ─── what a pre-action POLICY did to a tool call, and which policy did it ──────────────────────
 *
 * 🔴 *"Bind every intervention to a receipt."* An input patch that silently
 * rewrote a tool's arguments would be the product lying about what it did — the model asked to run
 * one thing, something else ran, and the transcript would show only the second. So an intervention
 * is not allowed to be invisible, and this table is the durable half of that promise (the other
 * half is the model-facing note the seam prepends to the tool's own result, so the MODEL is not
 * lied to either).
 *
 * ⚠️ **Keyed on `tool_call_id`, which is the unit an intervention actually has.** Not the session
 * (a session makes hundreds of calls), not the attempt (`session_execution` is per drain and a
 * policy decides per call), not the check (`session_quality_check`'s unit is *one RUN of one
 * check*, and every row there carries a `command` plus an exit code whose null means "no process
 * existed" — a decision that runs no process at all would have to fabricate both). This is the
 * same reasoning `recipe-verify.ts` records for refusing that table.
 *
 * ⚠️ **A row is written only when something HAPPENED** — the composed decision was not a plain
 * `allow`, or a provider failed to answer. A row per tool call would be one row per model action
 * for the life of the instance, to record that nothing intervened. The absence of a row is
 * therefore a positive statement ("every installed policy allowed this call, in time"), which is
 * only true because `providers` below records the unavailable ones too.
 *
 * ⚠️ `providers` keeps EVERY consulted policy, including the ones that said `allow`, and it is
 * sorted by policy id. A receipt that listed only the intervening policy could not answer *"was the
 * secrets guard even running?"* — and that is the question a person asks after something got
 * through. The sort is what makes two runs of the same call produce byte-identical rows regardless
 * of which provider finished first.
 *
 * ⚠️ `patched` holds the fields AS APPLIED, never a diff. A diff needs the before-value to be
 * meaningful and the before-value is the tool call itself, which the transcript already has
 * durably; storing a second copy would let the two disagree.
 */
export const SessionPolicyDecisionTable = sqliteTable(
  "session_policy_decision",
  {
    id: text().primaryKey(),
    session_id: text().notNull(),
    /** The provider-assigned id of the tool call this decision governed. */
    tool_call_id: text().notNull(),
    /** The registered tool name, as the model called it. */
    tool: text().notNull(),
    /** `allow` | `context` | `patch` | `approve` | `deny` | `halt` — the COMPOSED decision. */
    decision: text().notNull(),
    /** One sentence, in the words the model was given. Evidence has to be readable. */
    detail: text().notNull(),
    /** Every consulted policy and what it answered, sorted by id. See the header. */
    providers: text({ mode: "json" })
      .$type<ReadonlyArray<{ readonly id: string; readonly outcome: string; readonly detail?: string }>>()
      .notNull(),
    /** The tool-input fields as REPLACED, or null when nothing was patched. Never a diff. */
    patched: text({ mode: "json" }).$type<Record<string, unknown>>(),
    time_created: integer().notNull(),
  },
  (table) => [
    index("session_policy_decision_session_idx").on(table.session_id, table.time_created),
    index("session_policy_decision_call_idx").on(table.tool_call_id),
  ],
)
