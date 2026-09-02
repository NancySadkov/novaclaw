import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Database } from "@novaclaw/core/database/database"
import { EventV2 } from "@novaclaw/core/event"
import { MemoryAccessLedger } from "@novaclaw/core/kb-graph/access-ledger"
import { MemoryClient } from "@novaclaw/core/kb-graph/memory-client"
import { MemoryObserved } from "@novaclaw/core/kb-graph/memory-observed"
import { testEffect } from "./lib/effect"

/**
 * THREE WAYS THE ACCESS LEDGER MEASURED THE WRONG THING.
 *
 * 1. **The observer changed what it observed.** Every search wrote the durable rollup, the Memory
 *    app's included — so a person typing a word into the search box removed every match from
 *    *Memory → never used* (the surface that exists to FIND noise) and bought each one a week of
 *    pruning protection, because `MemoryPrunePolicy.recencyWeight` pays 1.5 points for anything
 *    touched in the last seven days. Browsing the store decided what the store forgot.
 *
 * 2. **A documented repair that could not run.** `record`'s upsert re-stamps `scope` and its comment
 *    cites `moveScope` on a colleague retirement as the reason. But a retirement moves the cabinet to
 *    `retired:<id>:<t>`, which no recall path reads — so the memories are never returned again and
 *    the re-stamp can never fire for the only case it names.
 *
 * 3. **Two halves of one report that disagreed.** The raw per-hit update was scoped to a recall; the
 *    rollup increment beside it was not, so a repeat report charged a second `use` for one delivery.
 *
 * 🔴 **Every case here is a PAIR.** "A browse writes nothing" passes on a ledger that writes nothing
 * at all, and "the rollup did not move" passes on a ledger with no rows in it. Each test drives the
 * thing that must NOT be recorded and the thing that MUST be, in one run, against a real SQLite
 * store and the real store wrapper the product ships.
 */

const layer = AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node]))
const it = testEffect(layer)

/** Build the observed store the way `memory.ts` does: bus and ledger handed in at construction. */
const observing = Effect.gen(function* () {
  const events = yield* EventV2.Service
  const ledger = (yield* Database.Service).db
  return MemoryObserved.observed(MemoryClient.stub(), { events, ledger })
})

const hit = (id: string, rank: number, scope = "global"): MemoryAccessLedger.Hit => ({
  id,
  scope,
  rank,
  score: 1 / rank,
})

describe("the access ledger records retrievals, not readings", () => {
  it.effect("the Memory app's search box leaves the store's own numbers alone; an agent recall does not", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const store = yield* observing
      const SCOPE = "global"
      yield* store.addMemory({ id: "mem_browsed", kind: "episode", text: "car insurance renews in May", scope: SCOPE })
      yield* store.addMemory({ id: "mem_recalled", kind: "episode", text: "car service is booked", scope: SCOPE })

      // A PERSON typing into the Memory app. This is the read that must change nothing.
      const browsed = yield* store.search({ query: "car insurance", scopes: [SCOPE], surface: "http" })
      // …and the agent's own recall, in the same run. Without it every assertion below would pass on
      // a ledger that had simply stopped working.
      const recalled = yield* store.search({ query: "car service", scopes: [SCOPE], surface: "auto-recall" })

      // The searches really did return the rows — otherwise this is a test about two empty lists.
      expect(browsed.map((row) => row.id)).toEqual(["mem_browsed"])
      expect(recalled.map((row) => row.id)).toEqual(["mem_recalled"])

      // ── the anti-set behind *Memory → never used* ──────────────────────────────────────────────
      const seen = yield* MemoryAccessLedger.everAccessed(db, ["mem_browsed", "mem_recalled"])
      expect([...seen]).toEqual(["mem_recalled"])

      // ── and the rollup the pruning policy scores from ──────────────────────────────────────────
      const usage = yield* MemoryAccessLedger.usageFor(db, ["mem_browsed", "mem_recalled"])
      // No row at all, so there is no `last_accessed_at` for `recencyWeight` to pay out on.
      expect(usage.has("mem_browsed")).toBe(false)
      expect(usage.get("mem_recalled")?.accesses).toBe(1)

      // ── what a browse MAY leave: the trace in the detail view ──────────────────────────────────
      // "Why is this here" still answers, and nothing that decides a memory's fate reads it.
      const detail = yield* MemoryAccessLedger.accessesFor(db, "mem_browsed")
      expect(detail.map((row) => row.surface)).toEqual(["http"])
      expect(detail[0]?.usedAt).toBeNull()
    }),
  )

  it.effect("a retired colleague's cabinet takes its measurement with it, and the next holder cannot erase it", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const store = yield* observing
      const CABINET = "agent:lysander"
      const SET_ASIDE = "retired:lysander:1700"
      yield* store.addMemory({ id: "mem_lys", kind: "episode", text: "prefers the early train", scope: CABINET })
      yield* store.search({ query: "prefers", scopes: [CABINET], surface: "auto-recall" })
      // A person vouched for it — the hard protection `MemoryPrunePolicy.score` reads.
      yield* MemoryAccessLedger.feedback(db, { id: "mem_lys", useful: true, at: 1_700 })
      expect((yield* MemoryAccessLedger.usageFor(db, ["mem_lys"])).get("mem_lys")?.scope).toBe(CABINET)

      // The retirement: the bytes are SET ASIDE under a scope no recall path reads.
      yield* store.moveScope(CABINET, SET_ASIDE)
      const moved = (yield* MemoryAccessLedger.usageFor(db, ["mem_lys"])).get("mem_lys")
      expect(moved?.scope).toBe(SET_ASIDE)
      // Both tables, because both are read by scope. A repair that moved only the rollup would leave
      // the detail behind for the very `forgetScope` this test is about to fire.
      expect((yield* MemoryAccessLedger.accessesFor(db, "mem_lys")).map((row) => row.scope)).toEqual([SET_ASIDE])

      // THE NEXT HOLDER of a reused colleague id clears their own — empty — cabinet.
      yield* store.clearScope(CABINET)
      const survivor = (yield* MemoryAccessLedger.usageFor(db, ["mem_lys"])).get("mem_lys")
      expect(survivor?.useful).toBe(1)
      // PAIRED with a real deletion, so "it survived" is not "forgetScope stopped working".
      yield* store.clearScope(SET_ASIDE)
      expect((yield* MemoryAccessLedger.usageFor(db, ["mem_lys"])).size).toBe(0)
    }),
  )

  it.effect("a repeated report of one recall charges one use, and an id that recall never returned charges none", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* MemoryAccessLedger.record(db, {
        recallID: "rcl_repeat",
        fingerprint: "qf_repeat",
        surface: "auto-recall",
        at: 4_000,
        hits: [hit("clm_shown", 1), hit("clm_dropped", 2)],
      })

      // The turn is retried, so the consumer reports the same delivery twice.
      yield* MemoryAccessLedger.markUsed(db, { recallID: "rcl_repeat", ids: ["clm_shown"], at: 4_100 })
      yield* MemoryAccessLedger.markUsed(db, { recallID: "rcl_repeat", ids: ["clm_shown"], at: 4_200 })
      const usage = yield* MemoryAccessLedger.usageFor(db, ["clm_shown", "clm_dropped"])
      // One delivery, one use. `uses > 0` is a full point in `MemoryPrunePolicy.usefulnessWeight`,
      // so a second charge here is a decision about what survives the forgetting pass.
      expect(usage.get("clm_shown")?.uses).toBe(1)
      // The raw row keeps the FIRST report's timestamp: promoting is not re-stamping.
      expect((yield* MemoryAccessLedger.accessesFor(db, "clm_shown"))[0]?.usedAt).toBe(4_100)
      // …and the pool member that did not fit the budget is still only ACCESSED.
      expect(usage.get("clm_dropped")?.uses).toBe(0)
      expect(usage.get("clm_dropped")?.accesses).toBe(1)

      // An id from somebody ELSE's recall promotes nothing here, and is charged nothing.
      yield* MemoryAccessLedger.record(db, {
        recallID: "rcl_other",
        fingerprint: "qf_other",
        surface: "auto-recall",
        at: 5_000,
        hits: [hit("clm_elsewhere", 1)],
      })
      yield* MemoryAccessLedger.markUsed(db, { recallID: "rcl_repeat", ids: ["clm_elsewhere"], at: 5_100 })
      expect((yield* MemoryAccessLedger.usageFor(db, ["clm_elsewhere"])).get("clm_elsewhere")?.uses).toBe(0)
      // PRESENCE, so the assertion above is not "markUsed stopped working": a fresh, correctly
      // scoped report on that recall does move it.
      yield* MemoryAccessLedger.markUsed(db, { recallID: "rcl_other", ids: ["clm_elsewhere"], at: 5_200 })
      expect((yield* MemoryAccessLedger.usageFor(db, ["clm_elsewhere"])).get("clm_elsewhere")?.uses).toBe(1)
    }),
  )
})
