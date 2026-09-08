import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * ─── which quality checks RAN, and what they returned ──────────────────────────────────────────
 *
 * 🔴 The finding: *"`checks` are LOG EVENTS, not evidence."* The whole program
 * rests on *mechanical evidence is authoritative*, and until now the only record that a check had run
 * was `session.quality.check.passed/failed/refused/errored` in the rotating text log. A receipt built
 * over log scraping would make its central claim the least trustworthy part of it — the log rotates,
 * it is not queryable per attempt, and a line that says `failed` cannot say what the exit code was.
 *
 * The item asks for this half FIRST *"because it is the only new durable write, so its shape
 * constrains the schema while the other eight are reads"*. So the shape is deliberate:
 *
 * · **One row per RUN of one check**, never per check definition. The same label runs many times in a
 *   drain (`dueMidLoop` fires per touched file), and collapsing them would answer "did typecheck
 *   pass?" with the last one — which is exactly the question a receipt must not guess at.
 * · **`outcome` is a CLOSED vocabulary** and includes `refused`. A policy refusal is not a failed
 *   check, and `llm.ts` already draws that line for the steer; an evidence table that spelled both
 *   `failed` would let a receipt report the user's own posture as a defect.
 * · **`exit_code` is nullable and that null MEANS something** — there was no process. `refused` never
 *   ran one, and `errored` failed before or during spawn. A receipt reading this must distinguish
 *   "exited 0" from "never started", which a `0` default would destroy (the *explicit unknowns*
 *   half of verified autonomy, arrived at from the write side).
 * · **`command` is stored**, because a check's label is a name the user chose and the command is what
 *   actually ran. A receipt that names `typecheck` without saying what `typecheck` was is not
 *   evidence, and provisioned commands change.
 *
 * ⚠️ NOT keyed to `session_execution.attempt_id`. Checks run inside the drain loop, which does not
 * carry the attempt in scope, and inventing a join key the writer cannot fill would produce a column
 * that is null in practice and lies about being a foreign key. `session_id` + `time_created` is
 * enough to bracket a row against an attempt's window, and the attempt binding is V1's own job once
 * it threads an id down — at which point this table gains the column and the old rows keep their
 * honest null.
 */
export const SessionQualityCheckTable = sqliteTable(
  "session_quality_check",
  {
    id: text().primaryKey(),
    session_id: text().notNull(),
    /** The user-facing name from the provisioned command set (`typecheck`, `test`, …). */
    label: text().notNull(),
    /** What actually ran. A label without its command is a claim, not evidence. */
    command: text().notNull(),
    /** `passed` | `failed` | `refused` | `errored` — closed, see the header. */
    outcome: text().notNull(),
    /** Null = no process ran (refused, or a spawn that errored). Never defaulted to 0. */
    exit_code: integer(),
    /** Whether the check hit its own timeout — a `failed` that means "too slow", not "wrong". */
    timed_out: integer({ mode: "boolean" }).notNull().default(false),
    duration_ms: integer(),
    time_created: integer().notNull(),
  },
  (table) => [index("session_quality_check_session_idx").on(table.session_id, table.time_created)],
)
