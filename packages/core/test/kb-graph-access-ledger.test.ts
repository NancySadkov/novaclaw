import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { MemoryAccessLedger } from "@novaclaw/core/kb-graph/access-ledger"
import { testEffect } from "./lib/effect"

// The P3 retrieval access ledger, driven against a REAL SQLite store. What is pinned here is what the
// two tables end up HOLDING — and, twice, what they refuse to hold.

const it = testEffect(Database.layerFromPath(":memory:"))

const hit = (id: string, rank: number, over: Partial<MemoryAccessLedger.Hit> = {}): MemoryAccessLedger.Hit => ({
  id,
  scope: "global",
  rank,
  score: 1 / rank,
  ...over,
})

describe("MemoryAccessLedger", () => {
  it.effect("protection reads answer every requested id and survive both feedback transitions", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* MemoryAccessLedger.feedback(db, { id: "protected", useful: true, at: 100, scope: "global" })
      expect(yield* MemoryAccessLedger.protectionFor(db, ["unknown", "protected", "protected"])).toEqual([
        { id: "unknown", protected: false },
        { id: "protected", protected: true },
      ])
      yield* MemoryAccessLedger.feedback(db, { id: "protected", useful: false, at: 101, scope: "global" })
      expect(yield* MemoryAccessLedger.protectionFor(db, ["protected"])).toEqual([
        { id: "protected", protected: false },
      ])
    }),
  )

  it.effect("explicit protection reads and writes fail when their table is unavailable", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db.run("DROP TABLE memory_usage")
      expect((yield* Effect.exit(MemoryAccessLedger.protectionFor(db, ["unknown"])))._tag).toBe("Failure")
      expect((yield* Effect.exit(MemoryAccessLedger.feedback(db, { id: "unknown", useful: true, at: 100 })))._tag).toBe(
        "Failure",
      )
    }),
  )
  it.effect("a recall writes one row per returned memory, and the rollup counts the recall", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* MemoryAccessLedger.record(db, {
        recallID: "rcl_1",
        fingerprint: "qf_where_ann_works",
        surface: "auto-recall",
        at: 1_000,
        hits: [hit("clm_a", 1), hit("clm_b", 2)],
      })

      const accesses = yield* MemoryAccessLedger.accessesFor(db, "clm_a")
      expect(accesses).toHaveLength(1)
      // Fingerprint, time, surface, rank and OWNER scope — the five the spec asks for per hit.
      expect(accesses[0]).toMatchObject({
        fingerprint: "qf_where_ann_works",
        surface: "auto-recall",
        rank: 1,
        scope: "global",
        accessedAt: 1_000,
        usedAt: null,
        correctedAt: null,
      })

      const usage = yield* MemoryAccessLedger.usageFor(db, ["clm_a", "clm_b"])
      expect(usage.get("clm_a")).toMatchObject({ accesses: 1, uses: 0, useful: 0, corrections: 0 })
      expect(usage.get("clm_b")?.accesses).toBe(1)
    }),
  )

  it.effect("RETURNED is not USED — the pool is recorded, the report is what reached the model", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* MemoryAccessLedger.record(db, {
        recallID: "rcl_2",
        fingerprint: "qf_q",
        surface: "auto-recall",
        at: 2_000,
        hits: [hit("clm_a", 1), hit("clm_b", 2), hit("clm_c", 3)],
      })
      // The runner keeps two of the three: the third did not fit the turn's token budget.
      yield* MemoryAccessLedger.markUsed(db, { recallID: "rcl_2", ids: ["clm_a", "clm_b"], at: 2_500 })

      const usage = yield* MemoryAccessLedger.usageFor(db, ["clm_a", "clm_c"])
      expect(usage.get("clm_a")?.uses).toBe(1)
      // Retrieved and shown are different facts, and a ledger that conflated them would report the
      // pool size as the amount of memory the model was actually given.
      expect(usage.get("clm_c")?.uses).toBe(0)
      expect(usage.get("clm_c")?.accesses).toBe(1)
    }),
  )

  it.effect("a `kb search` is used on arrival; the Memory app's search box is not", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      // The MODEL asked, and the results go straight into its next turn — nothing downstream can
      // drop one, so the store can honestly say "used" itself.
      yield* MemoryAccessLedger.record(db, {
        recallID: "rcl_tool",
        fingerprint: "qf_tool",
        surface: "kb-tool",
        at: 2_600,
        hits: [hit("clm_tool", 1)],
      })
      // A PERSON asked. Counting that as "the model used it" would let browsing the store inflate
      // the very signal that decides what survives pruning — a viewer changing what it is viewing.
      yield* MemoryAccessLedger.record(db, {
        recallID: "rcl_http",
        fingerprint: "qf_http",
        surface: "http",
        at: 2_700,
        hits: [hit("clm_browsed", 1)],
      })

      expect((yield* MemoryAccessLedger.accessesFor(db, "clm_tool"))[0]?.usedAt).toBe(2_600)
      // The browse still leaves its TRACE in the detail view — that is the "why is this here"
      // surface, it is trimmed, and no decision reads it.
      expect((yield* MemoryAccessLedger.accessesFor(db, "clm_browsed"))[0]?.usedAt).toBeNull()
      // …and the tool's recall moves the ROLLUP, which is what the pruning policy reads. A signal
      // visible only in the detail view is a signal no decision is ever made with.
      const usage = yield* MemoryAccessLedger.usageFor(db, ["clm_tool", "clm_browsed"])
      expect(usage.get("clm_tool")?.uses).toBe(1)
      // 🔴 The browse leaves NO rollup row at all. Withholding `uses` alone was never enough: the
      // row it used to write carried `accesses: 1` and a fresh `last_accessed_at`, which is what
      // `everAccessed` and `MemoryPrunePolicy.recencyWeight` read. See the paired test in
      // `kb-graph-ledger-viewing-and-moved-cabinet.test.ts` for what that cost.
      expect(usage.has("clm_browsed")).toBe(false)
    }),
  )

  it.effect("a correction is charged only to memories recall had actually handed out", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* MemoryAccessLedger.record(db, {
        recallID: "rcl_3",
        fingerprint: "qf_employer",
        surface: "auto-recall",
        at: 3_000,
        hits: [hit("clm_old", 1, { conflictKey: "global|ann|employer" })],
      })
      // `clm_never` was superseded too, but nobody was ever told it — charging it would make the
      // review list a list of ordinary edits.
      yield* MemoryAccessLedger.markCorrected(db, { ids: ["clm_old", "clm_never"], at: 3_500 })

      const usage = yield* MemoryAccessLedger.usageFor(db, ["clm_old", "clm_never"])
      expect(usage.get("clm_old")?.corrections).toBe(1)
      expect(usage.get("clm_never")).toBeUndefined()
      expect((yield* MemoryAccessLedger.accessesFor(db, "clm_old"))[0]?.correctedAt).toBe(3_500)
    }),
  )

  it.effect("`repeatedly causes corrections` groups by IDENTITY, because a claim is corrected once", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const key = "global|ann|employer"
      // Three successive answers to ONE question, each recalled and then corrected.
      for (const [index, id] of ["clm_1", "clm_2", "clm_3"].entries()) {
        yield* MemoryAccessLedger.record(db, {
          recallID: `rcl_${index}`,
          fingerprint: "qf_employer",
          surface: "auto-recall",
          at: 4_000 + index,
          hits: [hit(id, 1, { conflictKey: key })],
        })
        yield* MemoryAccessLedger.markCorrected(db, { ids: [id], at: 4_100 + index })
      }
      // …and one unrelated identity corrected exactly once, which is not "repeatedly".
      yield* MemoryAccessLedger.record(db, {
        recallID: "rcl_x",
        fingerprint: "qf_role",
        surface: "kb-tool",
        at: 4_500,
        hits: [hit("clm_r", 1, { conflictKey: "global|bo|role" })],
      })
      yield* MemoryAccessLedger.markCorrected(db, { ids: ["clm_r"], at: 4_600 })

      const groups = yield* MemoryAccessLedger.correctionProne(db, { minCorrected: 2 })
      expect(groups).toHaveLength(1)
      expect(groups[0]).toMatchObject({ conflictKey: key, corrected: 3, corrections: 3 })
    }),
  )

  it.effect("a vouched-for memory is findable, and the vouch can be retracted", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* MemoryAccessLedger.record(db, {
        recallID: "rcl_4",
        fingerprint: "qf_pref",
        surface: "http",
        at: 5_000,
        hits: [hit("clm_p", 1)],
      })
      yield* MemoryAccessLedger.feedback(db, { id: "clm_p", useful: true, at: 5_100 })
      expect((yield* MemoryAccessLedger.usefulMemories(db)).map((row) => row.memoryID)).toEqual(["clm_p"])

      yield* MemoryAccessLedger.feedback(db, { id: "clm_p", useful: false, at: 5_200 })
      // Retraction, not a negative count: the column exists to PROTECT a memory from pruning, so the
      // only two states that mean anything are "somebody vouched" and "nobody did".
      expect(yield* MemoryAccessLedger.usefulMemories(db)).toEqual([])
    }),
  )

  it.effect("a purge erases the measurement with the memory; the rollup survives a ledger TRIM", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* MemoryAccessLedger.record(db, {
        recallID: "rcl_5",
        fingerprint: "qf_secret",
        surface: "kb-tool",
        at: 6_000,
        hits: [hit("clm_secret", 1), hit("clm_keep", 2)],
      })

      yield* MemoryAccessLedger.forget(db, ["clm_secret"])
      expect(yield* MemoryAccessLedger.accessesFor(db, "clm_secret")).toEqual([])
      expect((yield* MemoryAccessLedger.usageFor(db, ["clm_secret"])).size).toBe(0)

      // The trim bounds the RAW rows only. If it took the rollup with it, a memory would look
      // never-recalled again the moment its detail aged out — which is the one thing "never used"
      // must never say about a memory that has been used.
      yield* MemoryAccessLedger.trim(db, 1_000)
      expect(yield* MemoryAccessLedger.accessesFor(db, "clm_keep")).toHaveLength(1)
      expect((yield* MemoryAccessLedger.usageFor(db, ["clm_keep"])).get("clm_keep")?.accesses).toBe(1)
    }),
  )

  it.effect("clearing a cabinet clears what the ledger learned about it", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* MemoryAccessLedger.record(db, {
        recallID: "rcl_6",
        fingerprint: "qf_chat",
        surface: "auto-recall",
        at: 7_000,
        hits: [hit("clm_s", 1, { scope: "session:gone" }), hit("clm_g", 2, { scope: "global" })],
      })
      yield* MemoryAccessLedger.forgetScope(db, "session:gone")

      expect((yield* MemoryAccessLedger.usageFor(db, ["clm_s"])).size).toBe(0)
      expect((yield* MemoryAccessLedger.usageFor(db, ["clm_g"])).size).toBe(1)
    }),
  )

  it.effect("a vouch for a NEVER-RECALLED memory sticks, without inventing a retrieval", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      // Somebody browsing the Memory app marks a memory useful that recall has never returned. An
      // `UPDATE` would have touched nothing and answered success — the memory would have looked
      // protected and been pruned anyway.
      yield* MemoryAccessLedger.feedback(db, { id: "clm_fresh", useful: true, at: 9_000, scope: "global" })
      expect((yield* MemoryAccessLedger.usefulMemories(db)).map((row) => row.memoryID)).toEqual(["clm_fresh"])
      // …and it is still never-used, because a judgement is not a retrieval.
      expect([...(yield* MemoryAccessLedger.everAccessed(db, ["clm_fresh"]))]).toEqual([])
    }),
  )

  it.effect("erasing every memory erases the measurement of them", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* MemoryAccessLedger.record(db, {
        recallID: "rcl_8",
        fingerprint: "qf_all",
        surface: "http",
        at: 10_000,
        hits: [hit("clm_1", 1), hit("clm_2", 2, { scope: "agent:nova" })],
      })
      yield* MemoryAccessLedger.forgetEverything(db)
      expect((yield* MemoryAccessLedger.usageFor(db, ["clm_1", "clm_2"])).size).toBe(0)
      expect(yield* MemoryAccessLedger.accessesFor(db, "clm_1")).toEqual([])
    }),
  )

  it.effect("`never used` is an ABSENCE — nothing writes a zero row on ingest", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* MemoryAccessLedger.record(db, {
        recallID: "rcl_7",
        fingerprint: "qf_a",
        surface: "auto-recall",
        at: 8_000,
        hits: [hit("clm_seen", 1)],
      })
      const seen = yield* MemoryAccessLedger.everAccessed(db, ["clm_seen", "clm_unseen"])
      expect([...seen]).toEqual(["clm_seen"])
    }),
  )
})
