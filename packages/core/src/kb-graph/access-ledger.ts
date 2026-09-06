export * as MemoryAccessLedger from "./access-ledger"

import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { ascending } from "@novaclaw/schema/identifier"
import { MemoryAccessTable, MemoryUsageTable } from "./access-ledger.sql"

type Db = Database.Interface["db"]

/** Raw per-hit detail retained after each background memory-maintenance pass. */
export const RAW_ROW_HORIZON = 50_000

/**
 * THE RETRIEVAL ACCESS LEDGER — what recall delivered, and what became of it.
 *
 * Background observations DEGRADE rather than fail. The ledger is a
 * measurement surface hanging off the store boundary; a locked database or a missing table must cost
 * an observation, never a turn. So the writes end in `Effect.ignore` and the reads in
 * `orElseSucceed`, exactly as `memory-observed.ts` treats the event bus — and for the same reason:
 * memory degrades, it does not take the turn down with it.
 * Explicit protection reads and feedback writes are different: the UI must learn whether they
 * succeeded. `protectionFor` and `feedback` preserve failures instead of inventing an empty state.
 *
 * ⚠️ **`Effect.orDie` is what the sibling stores use and it is the wrong stance HERE.** A defect
 * from `AgentUsage.record` surfaces on a path the user is already watching; a defect from a recall
 * ledger would abort auto-recall, which is best-effort by construction, and turn "we could not
 * measure that recall" into "the turn failed".
 *
 * The four signals, and where each honestly comes from:
 *
 *   · **accessed** — recall RETURNED it. Known at the store boundary, which is where it is written.
 *   · **used**     — it survived the context budget and reached the model. Only the recall's
 *                    CONSUMER knows this: the store hands back a pool and the runner keeps what
 *                    fits. Reported by `markUsed`.
 *   · **useful**   — a judgement. There is no deterministic derivation, so this is set by an
 *                    explicit act (the Memory app's feedback control) and by nothing else. Inventing
 *                    it from a model's opinion would be a measurement of the model.
 *   · **corrected**— a later claim SUPERSEDED a memory this ledger had handed out. Derived at the
 *                    store boundary from `addClaim`'s own `superseded` list — deterministic, and no
 *                    model is asked whether a correction happened.
 */

export interface Hit {
  readonly id: string
  readonly scope: string
  /** 1-based, in the order the caller was handed them. */
  readonly rank: number
  readonly score: number
  /** The claim identity that was answered, when it had one. `null` for anything without one. */
  readonly conflictKey?: string | null
}

export interface RecordInput {
  /** Groups one recall's rows. Callers that do not care may pass a fresh id. */
  readonly recallID: string
  readonly fingerprint: string
  readonly surface: string
  readonly at: number
  readonly hits: ReadonlyArray<Hit>
}

const degradeWrite = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.ignore, Effect.asVoid)

/**
 * Which surfaces hand every returned memory straight to the model, with no budget in between.
 *
 * 🔴 `kb-tool` is a search the MODEL asked for and the results go directly into its next turn —
 * there is nothing downstream that could drop one, so "returned" and "used" are the same event and
 * the store can say so itself. `auto-recall` cannot: it gets a POOL and the runner keeps what fits a
 * token budget, which is why that one reports back through `markUsed`.
 *
 * ⚠️ `http` is deliberately NOT here. The Memory app's search box shows results to a PERSON, and
 * counting that as "the model used it" would let browsing the store inflate the usefulness signal
 * that decides what survives pruning — a viewer changing what it is viewing. It is excluded from the
 * ROLLUP entirely — see `VIEWING_SURFACES`, which is where that argument actually bites.
 */
const SELF_USING_SURFACES: ReadonlySet<string> = new Set(["kb-tool"])

/**
 * Surfaces where a PERSON is reading the store rather than a recall answering a question.
 *
 * 🔴 **These write no rollup row at all**, and withholding `uses` from them was never enough. The
 * rollup is the row every decision is made from: `everAccessed` reads `accesses > 0` to build
 * *Memory → never used*, and `MemoryPrunePolicy.recencyWeight` reads `last_accessed_at` and pays a
 * memory touched in the last seven days a full 1.5 points of protection. So a person typing "car
 * insurance" into the Memory app used to delete every match from the list that exists to FIND noise
 * and shield it from the next forgetting pass — the pruning policy then acting on a number the
 * viewer manufactured. The observer changed what it observed.
 *
 * ⚠️ The raw `memory_access` row is still written, and that is the deliberate half: it is the "why
 * is this here" detail view, it is trimmed, and nothing that decides a memory's fate reads it. What
 * a browse may leave behind is a trace; what it may not leave behind is a vote.
 *
 * 🔴 The predicate lives HERE rather than in each reader, because the readers are the part that
 * grows. `everAccessed` and `recencyWeight` are two today; a third would have inherited the bug by
 * writing the obvious query. A row the ledger never wrote cannot be misread by a reader nobody has
 * written yet — the rollup's own doc says a row in it means "recall has returned this", and a
 * viewer's read is not a recall.
 */
const VIEWING_SURFACES: ReadonlySet<string> = new Set(["http"])

/** Record one recall: a raw row per returned memory, and the durable rollup each one belongs to. */
export const record = (db: Db, input: RecordInput) =>
  Effect.suspend(() => {
    if (input.hits.length === 0) return Effect.void
    const selfUsing = SELF_USING_SURFACES.has(input.surface)
    const viewing = VIEWING_SURFACES.has(input.surface)
    const rows = input.hits.map((hit) => ({
      id: "acc_" + ascending(),
      recall_id: input.recallID,
      fingerprint: input.fingerprint,
      surface: input.surface,
      memory_id: hit.id,
      scope: hit.scope,
      rank: hit.rank,
      score: hit.score,
      accessed_at: input.at,
      ...(selfUsing ? { used_at: input.at } : {}),
    }))
    /**
     * The durable rollup — SKIPPED for a viewer. See `VIEWING_SURFACES`: this is the row every
     * decision is made from, so writing it on a browse is how opening the Memory app changed which
     * memories the next forgetting pass evicted.
     *
     * One statement per memory rather than one bulk upsert: `onConflictDoUpdate` needs the incoming
     * row's values, and the accumulate-or-insert shape is per-row anyway. A recall returns at most
     * `k` memories (10 by default), so this is a bounded handful of writes on a background-ish path,
     * not a scan.
     */
    const rollup = viewing
      ? Effect.void
      : Effect.forEach(
          input.hits,
          (hit) =>
            db
              .insert(MemoryUsageTable)
              .values({
                memory_id: hit.id,
                scope: hit.scope,
                conflict_key: hit.conflictKey ?? null,
                first_accessed_at: input.at,
                last_accessed_at: input.at,
                accesses: 1,
                // The rollup is what the pruning policy reads, so a self-using surface has to
                // move it here too — setting `used_at` on the raw row alone would leave the
                // signal visible in the detail view and absent from every decision made with it.
                uses: selfUsing ? 1 : 0,
              })
              .onConflictDoUpdate({
                target: MemoryUsageTable.memory_id,
                set: {
                  accesses: sql`${MemoryUsageTable.accesses} + 1`,
                  ...(selfUsing ? { uses: sql`${MemoryUsageTable.uses} + 1` } : {}),
                  last_accessed_at: input.at,
                  // The identity is re-stamped because it is only known when the memory is
                  // recalled. The SCOPE is re-stamped for the same reason, but it is not what
                  // repairs a MOVED cabinet: a retired colleague's memories are never recalled
                  // again (`recallScopes` reads session, agent and global — never `retired:`), so
                  // this line could not fire for that case. `moveScope` below is the repair.
                  scope: hit.scope,
                  conflict_key: hit.conflictKey ?? null,
                },
              })
              .run(),
          { discard: true },
        )
    return db
      .insert(MemoryAccessTable)
      .values(rows)
      .run()
      .pipe(
        Effect.flatMap(() => rollup),
        degradeWrite,
      )
  })

/**
 * The recall's consumer confirms which of the returned memories actually reached the model.
 *
 * 🔴 **The rollup is incremented from the rows this call actually PROMOTED, never from `input.ids`.**
 * The raw update is scoped to one recall and to rows not already marked, so it is idempotent; an
 * unscoped `uses + 1` beside it was not, and the two halves disagreed. Any repeat — a retried turn,
 * or a `kb-tool` recall that `record` already counted as self-using and that a consumer also reports
 * — charged a second `use` for one delivery. `uses > 0` is worth a full point in
 * `MemoryPrunePolicy.usefulnessWeight`, so the double count decided which memories survived.
 *
 * ⚠️ `RETURNING` rather than a second `SELECT`: the set that matters is exactly the set the `UPDATE`
 * changed, and reading it back separately would be a different query answering a similar question.
 * An id the consumer names that this recall never returned promotes nothing and is charged nothing.
 */
export const markUsed = (
  db: Db,
  input: { readonly recallID: string; readonly ids: ReadonlyArray<string>; readonly at: number },
) =>
  Effect.suspend(() => {
    if (input.ids.length === 0) return Effect.void
    return db
      .update(MemoryAccessTable)
      .set({ used_at: input.at })
      .where(
        and(
          eq(MemoryAccessTable.recall_id, input.recallID),
          inArray(MemoryAccessTable.memory_id, input.ids),
          isNull(MemoryAccessTable.used_at),
        ),
      )
      .returning({ id: MemoryAccessTable.memory_id })
      .all()
      .pipe(
        Effect.flatMap((promoted) => {
          // One recall returns a memory once, but the de-dup costs nothing and makes the rollup's
          // arithmetic independent of that being true.
          const ids = [...new Set(promoted.map((row) => row.id))]
          if (ids.length === 0) return Effect.void
          return db
            .update(MemoryUsageTable)
            .set({ uses: sql`${MemoryUsageTable.uses} + 1` })
            .where(inArray(MemoryUsageTable.memory_id, ids))
            .run()
        }),
        degradeWrite,
      )
  })

/**
 * A person's judgement about a memory recall handed them.
 *
 * `useful: false` RETRACTS rather than counting a negative — the column protects a memory from
 * pruning, so the only two states that matter are "somebody vouched for this" and "nobody did".
 */
export const feedback = (
  db: Db,
  input: { readonly id: string; readonly useful: boolean; readonly at: number; readonly scope?: string },
) =>
  db
    // ⚠️ An UPSERT, because a person can vouch for a memory recall has never returned — that is
    // exactly the case worth protecting, and an `UPDATE` would have touched nothing and answered
    // success. The inserted row carries `accesses: 0`, which is why `everAccessed` reads the COUNT
    // rather than the row's existence: a vouch must not make a never-recalled memory look recalled.
    .insert(MemoryUsageTable)
    .values({
      memory_id: input.id,
      scope: input.scope ?? "",
      first_accessed_at: input.at,
      last_accessed_at: input.at,
      accesses: 0,
      useful: input.useful ? 1 : 0,
    })
    .onConflictDoUpdate({
      target: MemoryUsageTable.memory_id,
      set: { useful: input.useful ? sql`${MemoryUsageTable.useful} + 1` : sql`0` },
    })
    .run()
    .pipe(
      Effect.flatMap(() =>
        db
          .update(MemoryAccessTable)
          .set({ useful_at: input.useful ? input.at : null })
          .where(eq(MemoryAccessTable.memory_id, input.id))
          .run(),
      ),
      Effect.asVoid,
    )

/**
 * A later claim superseded memories this ledger had handed out.
 *
 * 🔴 **Only ids the ledger already knows are counted**, and there is no insert here. A claim that was
 * corrected before it was ever recalled cost nobody a wrong answer, so counting it would make the
 * "repeatedly causes corrections" list a list of ordinary edits.
 */
export const markCorrected = (db: Db, input: { readonly ids: ReadonlyArray<string>; readonly at: number }) =>
  Effect.suspend(() => {
    if (input.ids.length === 0) return Effect.void
    return db
      .update(MemoryUsageTable)
      .set({ corrections: sql`${MemoryUsageTable.corrections} + 1` })
      .where(inArray(MemoryUsageTable.memory_id, input.ids))
      .run()
      .pipe(
        Effect.flatMap(() =>
          db
            .update(MemoryAccessTable)
            .set({ corrected_at: input.at })
            .where(inArray(MemoryAccessTable.memory_id, input.ids))
            .run(),
        ),
        degradeWrite,
      )
  })

export interface Usage {
  readonly memoryID: string
  readonly scope: string
  readonly conflictKey: string | null
  readonly firstAccessedAt: number
  readonly lastAccessedAt: number
  readonly accesses: number
  readonly uses: number
  readonly useful: number
  readonly corrections: number
}

const toUsage = (row: typeof MemoryUsageTable.$inferSelect): Usage => ({
  memoryID: row.memory_id,
  scope: row.scope,
  conflictKey: row.conflict_key,
  firstAccessedAt: row.first_accessed_at,
  lastAccessedAt: row.last_accessed_at,
  accesses: row.accesses,
  uses: row.uses,
  useful: row.useful,
  corrections: row.corrections,
})

/** Complete protection state for the requested ids. A missing ledger row means unprotected;
 * a failed query does not. This is an explicit UI read, unlike best-effort recall observations. */
export const protectionFor = (db: Db, ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const unique = [...new Set(ids)]
    if (!unique.length) return [] as { id: string; protected: boolean }[]
    const rows = yield* db
      .select({ id: MemoryUsageTable.memory_id, useful: MemoryUsageTable.useful })
      .from(MemoryUsageTable)
      .where(inArray(MemoryUsageTable.memory_id, unique))
      .all()
    const protectedIDs = new Set(rows.filter((row) => row.useful > 0).map((row) => row.id))
    return unique.map((id) => ({ id, protected: protectedIDs.has(id) }))
  })

/** The rollup for a specific set of memories — what the pruning policy reads. */
export const usageFor = (db: Db, ids: ReadonlyArray<string>): Effect.Effect<Map<string, Usage>> =>
  Effect.suspend(() => {
    if (ids.length === 0) return Effect.succeed(new Map<string, Usage>())
    return db
      .select()
      .from(MemoryUsageTable)
      .where(inArray(MemoryUsageTable.memory_id, ids))
      .all()
      .pipe(
        Effect.map((rows) => new Map(rows.map((row) => [row.memory_id, toUsage(row)] as const))),
        Effect.orElseSucceed(() => new Map<string, Usage>()),
      )
  })

/** Memories a person vouched for. These are PROTECTED from pruning. */
export const usefulMemories = (db: Db, limit = 200): Effect.Effect<ReadonlyArray<Usage>> =>
  db
    .select()
    .from(MemoryUsageTable)
    .where(sql`${MemoryUsageTable.useful} > 0`)
    .orderBy(desc(MemoryUsageTable.last_accessed_at))
    .limit(bounded(limit))
    .all()
    .pipe(
      Effect.map((rows) => rows.map(toUsage)),
      Effect.orElseSucceed(() => [] as ReadonlyArray<Usage>),
    )

/** Every memory the ledger has ever seen, by id. The anti-set for "never used". */
export const everAccessed = (db: Db, ids: ReadonlyArray<string>): Effect.Effect<ReadonlySet<string>> =>
  Effect.suspend(() => {
    if (ids.length === 0) return Effect.succeed(new Set<string>())
    return (
      db
        .select({ id: MemoryUsageTable.memory_id })
        .from(MemoryUsageTable)
        // 🔴 `accesses > 0`, not merely "a row exists". A vouch inserts a row for a memory recall has
        // never returned, and treating that as an access would quietly remove it from the never-used
        // list — turning a person's judgement into a fabricated retrieval.
        .where(and(inArray(MemoryUsageTable.memory_id, ids), sql`${MemoryUsageTable.accesses} > 0`))
        .all()
        .pipe(
          Effect.map((rows) => new Set(rows.map((row) => row.id))),
          Effect.orElseSucceed(() => new Set<string>()),
        )
    )
  })

export interface CorrectionGroup {
  /** The claim identity — `scope + subject + predicate` — that keeps being corrected. */
  readonly conflictKey: string
  readonly scope: string
  /** How many DISTINCT recalled memories under this identity were later superseded. */
  readonly corrected: number
  /** Total corrections charged across them. */
  readonly corrections: number
  readonly lastAccessedAt: number
}

/**
 * Identities whose recalled answers keep being corrected — the review list.
 *
 * 🔴 Grouped by `conflict_key`, never by memory id. A single claim is superseded at most once, so a
 * per-claim count can never reach "repeatedly"; the thing that repeats is the QUESTION.
 */
export const correctionProne = (
  db: Db,
  input: { readonly minCorrected?: number; readonly limit?: number } = {},
): Effect.Effect<ReadonlyArray<CorrectionGroup>> =>
  db
    .select({
      conflictKey: MemoryUsageTable.conflict_key,
      scope: sql<string>`min(${MemoryUsageTable.scope})`,
      corrected: sql<number>`count(*)`,
      corrections: sql<number>`sum(${MemoryUsageTable.corrections})`,
      lastAccessedAt: sql<number>`max(${MemoryUsageTable.last_accessed_at})`,
    })
    .from(MemoryUsageTable)
    .where(and(isNotNull(MemoryUsageTable.conflict_key), sql`${MemoryUsageTable.corrections} > 0`))
    .groupBy(MemoryUsageTable.conflict_key)
    .all()
    .pipe(
      // Ranked and capped in JS rather than with `HAVING … ORDER BY count(*)`: the `WHERE` has
      // already reduced this to identities that were corrected at all, which is a short list on any
      // real store, and keeping the SQL to the shapes every builder in this repo already uses is
      // worth more than pushing a sort down into it.
      Effect.map((rows) =>
        rows
          .map((row) => ({
            conflictKey: row.conflictKey ?? "",
            scope: row.scope,
            corrected: Number(row.corrected),
            corrections: Number(row.corrections),
            lastAccessedAt: Number(row.lastAccessedAt),
          }))
          .filter((group) => group.corrected >= Math.max(1, Math.trunc(input.minCorrected ?? 2)))
          .sort((a, b) => b.corrected - a.corrected || b.lastAccessedAt - a.lastAccessedAt)
          .slice(0, bounded(input.limit ?? 50)),
      ),
      Effect.orElseSucceed(() => [] as ReadonlyArray<CorrectionGroup>),
    )

/** The rollups filed under a set of identities — what the review list shows once a group is opened. */
export const usageForConflictKeys = (db: Db, keys: ReadonlyArray<string>): Effect.Effect<ReadonlyArray<Usage>> =>
  Effect.suspend(() => {
    if (keys.length === 0) return Effect.succeed([] as ReadonlyArray<Usage>)
    return db
      .select()
      .from(MemoryUsageTable)
      .where(inArray(MemoryUsageTable.conflict_key, keys))
      .all()
      .pipe(
        Effect.map((rows) => rows.map(toUsage)),
        Effect.orElseSucceed(() => [] as ReadonlyArray<Usage>),
      )
  })

export interface Access {
  readonly fingerprint: string
  readonly surface: string
  readonly memoryID: string
  readonly scope: string
  readonly rank: number
  readonly score: number
  readonly accessedAt: number
  readonly usedAt: number | null
  readonly usefulAt: number | null
  readonly correctedAt: number | null
}

/** The raw per-hit rows for one memory, newest first — the "why is this here" detail view. */
export const accessesFor = (db: Db, id: string, limit = 50): Effect.Effect<ReadonlyArray<Access>> =>
  db
    .select()
    .from(MemoryAccessTable)
    .where(eq(MemoryAccessTable.memory_id, id))
    .orderBy(desc(MemoryAccessTable.accessed_at))
    .limit(bounded(limit))
    .all()
    .pipe(
      Effect.map((rows) =>
        rows.map((row) => ({
          fingerprint: row.fingerprint,
          surface: row.surface,
          memoryID: row.memory_id,
          scope: row.scope,
          rank: row.rank,
          score: row.score,
          accessedAt: row.accessed_at,
          usedAt: row.used_at,
          usefulAt: row.useful_at,
          correctedAt: row.corrected_at,
        })),
      ),
      Effect.orElseSucceed(() => [] as ReadonlyArray<Access>),
    )

/**
 * Keep the raw ledger bounded.
 *
 * ⚠️ **The rollup is NOT trimmed with it.** Eight rows a turn is unbounded growth, so the per-hit
 * detail has a horizon; but deleting a memory's last raw row must never make it look never-recalled
 * again, which is the whole reason the rollup is a separate table.
 */
export const trim = (db: Db, keep = RAW_ROW_HORIZON) =>
  db
    .run(
      sql`DELETE FROM ${MemoryAccessTable} WHERE ${MemoryAccessTable.id} NOT IN (
        SELECT ${MemoryAccessTable.id} FROM ${MemoryAccessTable}
        ORDER BY ${MemoryAccessTable.accessed_at} DESC LIMIT ${Math.max(1000, Math.trunc(keep))}
      )`,
    )
    .pipe(degradeWrite)

/** Drop everything the ledger holds about specific memories — what a PURGE owes the measurement. */
export const forget = (db: Db, ids: ReadonlyArray<string>) =>
  Effect.suspend(() => {
    if (ids.length === 0) return Effect.void
    return db
      .delete(MemoryUsageTable)
      .where(inArray(MemoryUsageTable.memory_id, ids))
      .run()
      .pipe(
        Effect.flatMap(() => db.delete(MemoryAccessTable).where(inArray(MemoryAccessTable.memory_id, ids)).run()),
        degradeWrite,
      )
  })

/**
 * A whole cabinet MOVED — the measurement of it moves too.
 *
 * 🔴 **This is the repair `record`'s re-stamp could not be.** That upsert only re-files a memory the
 * moment recall returns it again, and the one case it named — a colleague retirement, which sets
 * `agent:<id>` aside as `retired:<id>:<t>` — is precisely the case where recall never returns it
 * again: `SessionRecall.recallScopes` reads `session:`, `agent:` and `global`, never `retired:`. So
 * every rollup and every raw row kept pointing at a cabinet that no longer held the memory, and two
 * things went wrong with it: the next holder of a reused colleague id clearing their own cabinet
 * deleted the PREVIOUS holder's rollups — including the `useful` vouches that are the hard
 * protection `MemoryPrunePolicy.score` reads — and the Memory app's scope-filtered views attributed
 * a retired colleague's history to the live one.
 *
 * ⚠️ Both tables, because both carry `scope` and both are read by scope (`forgetScope` deletes from
 * each). A repair that moved only the rollup would leave the raw detail behind for the same
 * `forgetScope` to take.
 */
export const moveScope = (db: Db, from: string, to: string) =>
  db
    .update(MemoryUsageTable)
    .set({ scope: to })
    .where(eq(MemoryUsageTable.scope, from))
    .run()
    .pipe(
      Effect.flatMap(() =>
        db.update(MemoryAccessTable).set({ scope: to }).where(eq(MemoryAccessTable.scope, from)).run(),
      ),
      degradeWrite,
    )

/** Drop everything the ledger holds about a scope — what clearing a cabinet owes the measurement. */
export const forgetScope = (db: Db, scope: string) =>
  db
    .delete(MemoryUsageTable)
    .where(eq(MemoryUsageTable.scope, scope))
    .run()
    .pipe(
      Effect.flatMap(() => db.delete(MemoryAccessTable).where(eq(MemoryAccessTable.scope, scope)).run()),
      degradeWrite,
    )

/** Every memory in every scope is gone; the measurement of them goes too. */
export const forgetEverything = (db: Db) =>
  db
    .delete(MemoryUsageTable)
    .run()
    .pipe(
      Effect.flatMap(() => db.delete(MemoryAccessTable).run()),
      degradeWrite,
    )

const bounded = (limit: number) => Math.max(1, Math.min(Math.trunc(limit), 1000))
