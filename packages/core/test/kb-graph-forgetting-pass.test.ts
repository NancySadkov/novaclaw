import { afterEach, describe, expect } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { EventV2 } from "@novaclaw/core/event"
import { MemoryAccessLedger } from "@novaclaw/core/kb-graph/access-ledger"
import { MemoryAccessTable } from "@novaclaw/core/kb-graph/access-ledger.sql"
import { Memory } from "@novaclaw/core/kb-graph/memory"
import { WasmMemory } from "@novaclaw/core/kb-graph/wasm-engine"
import { testEffect } from "./lib/effect"

/**
 * THE FORGETTING PASS, end to end: the real engine, the real ledger, the real policy.
 *
 * 🔴 **This replaces a SOURCE LEDGER.** `memory-cabinet-prune-ledger.test.ts` asserted that
 * `memory.ts` contained the literal text `prune({ scope, maxStaged: stagedCap })`, on the stated
 * grounds that the WASM engine was too heavy for the gate. That premise is false — a real store
 * opens here in under a second — and the cost of the ledger was exactly what a source guard always
 * costs: when the call was replaced by a ledger-aware one that keeps the same guarantee, the ledger
 * went red for a spelling while nothing about the behaviour had changed. A guard that reads the
 * source cannot see whether the quiet cabinet survived.
 *
 * Two properties, and they are the two that matter:
 *   1. **Each cabinet is capped on its own** — one talkative officer must never spend another's
 *      allowance, which is the same rule the colleague rate window follows.
 *   2. **What survives is decided by USEFULNESS, not age** — which is the whole reason the access
 *      ledger exists, and the thing the previous policy could not do.
 */

const it = testEffect(Database.layerFromPath(":memory:"))

/**
 * A bus that accepts and discards.
 *
 * ⚠️ This file is about what SURVIVES the pass, not about what it announces — the announcement is
 * `kb-graph-forgetting-loop.test.ts`'s subject, where the real layer supplies the real bus. The
 * parameter is REQUIRED rather than optional so that a caller has to decide, which is what stopped
 * the pass from being silent in production.
 */
const silentBus = { publish: () => Effect.succeed(undefined as never) } as unknown as EventV2.Interface

let dir: string | undefined
let mem: WasmMemory | undefined

afterEach(async () => {
  await mem?.close()
  mem = undefined
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

const open = async () => {
  dir = mkdtempSync(join(tmpdir(), "kb-forget-pass-"))
  mem = await WasmMemory.open(join(dir, "graph"), { dim: 8 })
  return mem
}

/** ⚠️ Rows written inside one clock tick share a `t_created`, and the policy's TIEBREAK is age — so
 *  without a gap the tiebreak is arbitrary and an ordering assertion is flaky rather than wrong. */
const spaced = () => new Promise((resolve) => setTimeout(resolve, 15))

const fill = async (engine: WasmMemory, scope: string, ids: readonly string[]) => {
  for (const id of ids) {
    await engine.addMemory({
      id,
      kind: "episode",
      text: `${scope} remembers ${id}`,
      scope,
      relation: "staged",
      source: "auto-extract",
    })
    await spaced()
  }
}

const stagedIn = async (engine: WasmMemory, scope: string) =>
  (await engine.list({ scopes: [scope], limit: 500 })).filter((row) => row.relation === "staged").map((row) => row.id)

describe("the forgetting pass", () => {
  it.effect("bounds raw recall detail while preserving the durable usage rollup", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const engine = yield* Effect.promise(() => open())
      yield* db
        .insert(MemoryAccessTable)
        .values(
          Array.from({ length: 1_001 }, (_, index) => ({
            id: `acc_${index.toString().padStart(4, "0")}`,
            recall_id: `rcl_${index}`,
            fingerprint: "qf_maintenance",
            surface: "auto-recall",
            memory_id: index === 0 ? "oldest" : index === 1_000 ? "newest" : `middle_${index}`,
            scope: "global",
            rank: 1,
            score: 1,
            accessed_at: index,
          })),
        )
        .run()
      yield* MemoryAccessLedger.feedback(db, { id: "oldest", useful: true, at: 2_000, scope: "global" })

      // Drive the same helper as the background loop with its minimum supported test horizon.
      yield* Memory.forgetEverywhere(engine, db, silentBus, 50, 1_000)

      expect(yield* MemoryAccessLedger.accessesFor(db, "oldest")).toEqual([])
      expect(yield* MemoryAccessLedger.accessesFor(db, "newest")).toHaveLength(1)
      expect((yield* MemoryAccessLedger.usageFor(db, ["oldest"])).get("oldest")?.useful).toBe(1)
    }),
  )

  it.effect("caps a loud cabinet and leaves a quiet one whole", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const engine = yield* Effect.promise(() => open())
      yield* Effect.promise(() => fill(engine, "agent:loud", ["l1", "l2", "l3", "l4", "l5", "l6"]))
      yield* Effect.promise(() => fill(engine, "agent:quiet", ["q1", "q2"]))
      // The household pile is capped too, on its own — it is not swept up by the `agent:` prefix and
      // it does not spend a cabinet's allowance.
      yield* Effect.promise(() => fill(engine, "global", ["g1", "g2", "g3", "g4", "g5"]))

      // The WHOLE pass, not a hand-rolled loop: what has to be true is that the background fiber
      // discovers each cabinet and caps it on its own, and a test that re-implemented the discovery
      // would pass against a `memory.ts` that had stopped doing it.
      yield* Memory.forgetEverywhere(engine, db, silentBus, 3)

      expect((yield* Effect.promise(() => stagedIn(engine, "agent:loud"))).length).toBe(3)
      // 🔴 Under one cap across `agent:%` the quiet colleague's two memories would have been the
      // cheapest thing in the pile to evict — it is the one that never spoke.
      expect((yield* Effect.promise(() => stagedIn(engine, "agent:quiet"))).length).toBe(2)
      expect((yield* Effect.promise(() => stagedIn(engine, "global"))).length).toBe(3)
    }),
  )

  it.effect("a memory recall has USED survives; its never-recalled elders do not", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const engine = yield* Effect.promise(() => open())
      // Written oldest-first. Under the previous policy — source tier, then confidence, then age —
      // every one of these is identical except for age, so `old1`/`old2` would go and `useful` would
      // survive only by being younger. Here it survives on its RECORD.
      yield* Effect.promise(() => fill(engine, "agent:nova", ["useful", "old1", "old2", "old3"]))
      yield* MemoryAccessLedger.record(db, {
        recallID: "rcl_pass",
        fingerprint: "qf_pass",
        surface: "auto-recall",
        at: Date.now(),
        hits: [{ id: "useful", scope: "agent:nova", rank: 1, score: 1 }],
      })
      yield* MemoryAccessLedger.markUsed(db, { recallID: "rcl_pass", ids: ["useful"], at: Date.now() })

      yield* Memory.forgetOverCap(engine, db, silentBus, "agent:nova", 2)

      const left = yield* Effect.promise(() => stagedIn(engine, "agent:nova"))
      expect(left).toHaveLength(2)
      // The oldest row in the cabinet, kept because it is the only one that ever answered anything.
      expect(left).toContain("useful")
      // …and age still decides between the three the ledger cannot tell apart.
      expect(left).not.toContain("old1")
    }),
  )

  it.effect("a vouched-for memory is not a victim even when everything else says it should be", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const engine = yield* Effect.promise(() => open())
      yield* Effect.promise(() => fill(engine, "agent:nova", ["vouched", "b", "c", "d"]))
      // A person marked it useful. It was never recalled, it is the oldest thing here, and it is
      // `auto-extract` — every signal in the policy points at it.
      yield* MemoryAccessLedger.feedback(db, { id: "vouched", useful: true, at: Date.now(), scope: "agent:nova" })

      yield* Memory.forgetOverCap(engine, db, silentBus, "agent:nova", 2)

      expect(yield* Effect.promise(() => stagedIn(engine, "agent:nova"))).toContain("vouched")
    }),
  )

  it.effect("a cabinet inside its cap is not touched at all", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const engine = yield* Effect.promise(() => open())
      yield* Effect.promise(() => fill(engine, "agent:nova", ["a", "b"]))
      yield* Memory.forgetOverCap(engine, db, silentBus, "agent:nova", 5)
      expect((yield* Effect.promise(() => stagedIn(engine, "agent:nova"))).length).toBe(2)
    }),
  )
})
