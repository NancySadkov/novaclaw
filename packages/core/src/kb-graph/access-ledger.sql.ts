import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core"

/**
 * WHAT RECALL ACTUALLY DELIVERED — the P3 access ledger.
 *
 * 🔴 **The fingerprint IS the query's representation here, and there is no second column holding the
 * words.** A recall query is built from the user's own prompt, so a ledger that stored it verbatim
 * would be a copy of the prompt stream living in the instance database for the sake of analytics —
 * the data plane leaking into a measurement surface. `MemoryObserved.fingerprint` folds whitespace
 * and case first, which is what makes "this is the same question again" answerable without keeping
 * the question. Nothing downstream can invert it, and nothing downstream needs to.
 *
 * ⚠️ **Two tables, because they answer two questions with two lifetimes.** `memory_access` is the
 * per-hit record the spec asks for — fingerprint, time, surface, rank, owner scope — and it is
 * TRIMMED, because eight rows a turn is unbounded growth in the instance DB. `memory_usage` is the
 * durable per-memory rollup the pruning policy and the noise queries read, and it survives the trim.
 * Rolling the aggregates up as they are written, rather than computing them with a `GROUP BY` over
 * the raw rows, is what makes "never used" still true after the raw rows are gone.
 *
 * ⚠️ **Every default here is a real SQL DEFAULT.** Drizzle's `$default` runs in JavaScript and emits
 * no `DEFAULT` clause at all, so a column added that way is `NOT NULL` with nothing behind it and
 * the first insert from any path that does not go through Drizzle fails — on an upgraded instance,
 * at boot, with the whole test gate still green.
 */
export const MemoryAccessTable = sqliteTable(
  "memory_access",
  {
    id: text().primaryKey(),
    /** Groups the rows of ONE recall, so "which memories did that question return" stays answerable. */
    recall_id: text().notNull(),
    /** `MemoryObserved.fingerprint` of the query. Opaque by construction — see the note above. */
    fingerprint: text().notNull(),
    /** `auto-recall` | `kb-tool` | `http` | `unknown` — who asked, as the caller declared it. */
    surface: text().notNull(),
    memory_id: text().notNull(),
    /** The OWNER scope of the returned memory, not the asker's — which cabinet answered. */
    scope: text().notNull(),
    /** 1-based position in the order the caller was handed them. */
    rank: integer().notNull(),
    score: real().notNull(),
    accessed_at: integer().notNull(),
    /**
     * Set when the memory survived the context budget and actually reached the model.
     *
     * ⚠️ Returned ≠ used. The store hands back a POOL (`recallPoolSize`) and the runner keeps what
     * fits its token budget, so a ledger that treated every hit as used would report the pool.
     */
    used_at: integer(),
    /** Set by an explicit judgement — the Memory app marking a memory useful. Protects it from pruning. */
    useful_at: integer(),
    /** Set when a later claim SUPERSEDED this memory: the recall handed out an answer that was wrong. */
    corrected_at: integer(),
  },
  (table) => [
    index("memory_access_memory_idx").on(table.memory_id),
    index("memory_access_recall_idx").on(table.recall_id),
    index("memory_access_at_idx").on(table.accessed_at),
  ],
)

/**
 * The durable rollup: one row per memory that recall has ever returned.
 *
 * 🔴 **A memory with no row here has never been recalled**, and that — not its age — is what "never
 * used" means. The absence is the signal, which is why nothing writes a zero row on ingest.
 */
export const MemoryUsageTable = sqliteTable(
  "memory_usage",
  {
    memory_id: text().primaryKey(),
    scope: text().notNull(),
    /**
     * The claim's conflict key at the time it was recalled, when it had one.
     *
     * 🔴 This is what makes "repeatedly causes corrections" mean anything. A single claim can only
     * be superseded ONCE, so per-claim correction counts can never exceed one and "repeatedly" would
     * be unanswerable. The identity — `scope + subject + predicate` — is the thing that keeps
     * getting corrected, so the count that matters is grouped by this column.
     */
    conflict_key: text(),
    first_accessed_at: integer().notNull(),
    last_accessed_at: integer().notNull(),
    accesses: integer().notNull().default(0),
    uses: integer().notNull().default(0),
    useful: integer().notNull().default(0),
    corrections: integer().notNull().default(0),
  },
  (table) => [
    index("memory_usage_scope_idx").on(table.scope),
    index("memory_usage_conflict_idx").on(table.conflict_key),
    index("memory_usage_last_idx").on(table.last_accessed_at),
  ],
)
