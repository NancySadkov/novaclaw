export * as MemoryAccessLedger from "./access-ledger"

import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm"
import { Effect } from "effect"
import type { Database } from "../database/database"
import { ascending } from "@novaclaw/schema/identifier"
import { MemoryAccessTable, MemoryUsageTable } from "./access-ledger.sql"

type Db = Database.Interface["db"]

/**
 * THE RETRIEVAL ACCESS LEDGER — what recall delivered, and what became of it.
 *
 * 🔴 **Every function here DEGRADES rather than fails, and that is deliberate.** The ledger is a
 * measurement surface hanging off the store boundary; a locked database or a missing table must cost
 * an observation, never a turn. So the writes end in `Effect.ignore` and the reads in
 * `orElseSucceed`, exactly as `memory-observed.ts` treats the event bus — and for the same reason:
 * memory degrades, it does not take the turn down with it.
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

/** Record one recall: a raw row per returned memory, and the durable rollup each one belongs to. */
export const record = (db: Db, input: RecordInput) =>
  Effect.suspend(() => {
    if (input.hits.length === 0) return Effect.void
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
    }))
    return db
      .insert(MemoryAccessTable)
      .values(rows)
      .run()
      .pipe(
        Effect.flatMap(() =>
          // One statement per memory rather than one bulk upsert: `onConflictDoUpdate` needs the
          // incoming row's values, and the accumulate-or-insert shape is per-row anyway. A recall
          // returns at most `k` memories (10 by default), so this is a bounded handful of writes on
          // a background-ish path, not a scan.
          Effect.forEach(
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
                })
                .onConflictDoUpdate({
                  target: MemoryUsageTable.memory_id,
                  set: {
                    accesses: sql`${MemoryUsageTable.accesses} + 1`,
                    last_accessed_at: input.at,
                    // The scope and the identity are re-stamped because a memory can MOVE cabinets
                    // (`moveScope` on a colleague retirement) and its identity is only known when it
                    // is recalled. A rollup carrying the pre-move scope would file a live memory
                    // under a cabinet that no longer holds it.
                    scope: hit.scope,
                    conflict_key: hit.conflictKey ?? null,
                  },
                })
                .run(),
            { discard: true },
          ),
        ),
        degradeWrite,
      )
  })

/** The recall's consumer confirms which of the returned memories actually reached the model. */
export const markUsed = (
  db: Db,
  input: { readonly recallID: string; readonly ids: ReadonlyArray<string>; readonly at: number },
) =>
  Effect.suspend(() => {
    if (input.ids.length === 0) return Effect.void
    return db
      .update(MemoryAccessTable)
      .set({ used_at: input.at })
      .where(and(eq(MemoryAccessTable.recall_id, input.recallID), inArray(MemoryAccessTable.memory_id, input.ids)))
      .run()
      .pipe(
        Effect.flatMap(() =>
          db
            .update(MemoryUsageTable)
            .set({ uses: sql`${MemoryUsageTable.uses} + 1` })
            .where(inArray(MemoryUsageTable.memory_id, input.ids))
            .run(),
        ),
        degradeWrite,
      )
  })

/**
 * A person's judgement about a memory recall handed them.
 *
 * `useful: false` RETRACTS rather than counting a negative — the column protects a memory from
 * pruning, so the only two states that matter are "somebody vouched for this" and "nobody did".
 */
export const feedback = (db: Db, input: { readonly id: string; readonly useful: boolean; readonly at: number }) =>
  db
    .update(MemoryUsageTable)
    .set({ useful: input.useful ? sql`${MemoryUsageTable.useful} + 1` : sql`0` })
    .where(eq(MemoryUsageTable.memory_id, input.id))
    .run()
    .pipe(
      Effect.flatMap(() =>
        db
          .update(MemoryAccessTable)
          .set({ useful_at: input.useful ? input.at : null })
          .where(eq(MemoryAccessTable.memory_id, input.id))
          .run(),
      ),
      degradeWrite,
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
    return db
      .select({ id: MemoryUsageTable.memory_id })
      .from(MemoryUsageTable)
      .where(inArray(MemoryUsageTable.memory_id, ids))
      .all()
      .pipe(
        Effect.map((rows) => new Set(rows.map((row) => row.id))),
        Effect.orElseSucceed(() => new Set<string>()),
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
export const trim = (db: Db, keep = 50_000) =>
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

/** Oldest-first rollups within a scope set — the paging arm of the noise views. */
export const leastRecent = (db: Db, limit = 50): Effect.Effect<ReadonlyArray<Usage>> =>
  db
    .select()
    .from(MemoryUsageTable)
    .orderBy(asc(MemoryUsageTable.last_accessed_at))
    .limit(bounded(limit))
    .all()
    .pipe(
      Effect.map((rows) => rows.map(toUsage)),
      Effect.orElseSucceed(() => [] as ReadonlyArray<Usage>),
    )

const bounded = (limit: number) => Math.max(1, Math.min(Math.trunc(limit), 1000))
