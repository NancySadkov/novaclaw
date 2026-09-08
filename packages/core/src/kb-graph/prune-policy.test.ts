import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { MemoryAccessLedger } from "./access-ledger"
import { MemoryPrunePolicy } from "./prune-policy"
import { WasmMemory } from "./wasm-engine"

/**
 * FORGETTING, once there is a record of what a memory ever did.
 *
 * The first half is the policy in isolation — the ordering claims are arithmetic and deserve to be
 * pinned as arithmetic. The second half drives the REAL engine, because `candidates` is a scan and
 * this engine has two query shapes that hang and one that silently returns blank bodies; a double
 * would prove none of that.
 */

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse("2026-08-25T12:00:00.000Z")

const candidate = (id: string, over: Partial<MemoryPrunePolicy.Candidate> = {}): MemoryPrunePolicy.Candidate => ({
  id,
  scope: "global",
  kind: "episode",
  name: null,
  source: null,
  confidence: null,
  relation: "staged",
  status: "active",
  conflictKey: null,
  createdAt: new Date(NOW - 10 * DAY).toISOString(),
  ...over,
})

const usage = (over: Partial<MemoryAccessLedger.Usage> = {}): MemoryAccessLedger.Usage => ({
  memoryID: "x",
  scope: "global",
  conflictKey: null,
  firstAccessedAt: NOW - DAY,
  lastAccessedAt: NOW - DAY,
  accesses: 1,
  uses: 0,
  useful: 0,
  corrections: 0,
  ...over,
})

describe("MemoryPrunePolicy", () => {
  test("age is the TIEBREAK, not the axis — a recalled old memory outlives a never-recalled young one", () => {
    const old = candidate("clm_old", { createdAt: new Date(NOW - 400 * DAY).toISOString() })
    const young = candidate("clm_young", { createdAt: new Date(NOW - 1 * DAY).toISOString() })
    const choice = MemoryPrunePolicy.choose({
      candidates: [old, young],
      usage: new Map([["clm_old", usage({ lastAccessedAt: NOW - 2 * DAY, uses: 1 })]]),
      excess: 1,
      now: NOW,
    })
    // The whole point of the ledger. The previous policy, having nothing but `t_created` with any
    // spread in it, would have taken `clm_old` here.
    expect(choice.victims).toEqual(["clm_young"])
  })

  test("two memories the ledger cannot tell apart are separated by age, oldest first", () => {
    const choice = MemoryPrunePolicy.choose({
      candidates: [
        candidate("clm_newer", { createdAt: new Date(NOW - 2 * DAY).toISOString() }),
        candidate("clm_older", { createdAt: new Date(NOW - 200 * DAY).toISOString() }),
      ],
      usage: new Map(),
      excess: 1,
      now: NOW,
    })
    expect(choice.victims).toEqual(["clm_older"])
  })

  test("a vouched-for memory is never a victim, however cheap it otherwise looks", () => {
    const choice = MemoryPrunePolicy.choose({
      // An ingested passage is the cheapest thing in the store to lose — re-derivable, bulk, old.
      candidates: [candidate("clm_passage", { source: "ingest", kind: "passage" })],
      usage: new Map([["clm_passage", usage({ useful: 1, lastAccessedAt: NOW - 300 * DAY })]]),
      excess: 5,
      now: NOW,
    })
    // "Useful memories are protected" is a promise, not a weight, so a big enough number elsewhere
    // must not be able to out-argue it.
    expect(choice.victims).toEqual([])
    expect(choice.protectedCount).toBe(1)
  })

  test("a `core` memory is never a victim — the curated relation is still untouchable", () => {
    const choice = MemoryPrunePolicy.choose({
      candidates: [candidate("clm_core", { relation: "core", source: "ingest" })],
      usage: new Map(),
      excess: 3,
      now: NOW,
    })
    expect(choice.victims).toEqual([])
  })

  test("an excess bigger than what is prunable yields a SHORT list, not a reach into protected rows", () => {
    const choice = MemoryPrunePolicy.choose({
      candidates: [candidate("clm_a"), candidate("clm_b", { relation: "core" })],
      usage: new Map(),
      excess: 10,
      now: NOW,
    })
    expect(choice.victims).toEqual(["clm_a"])
  })

  test("re-derivability outranks a stale access: an ingested passage goes before a deliberate remember", () => {
    const choice = MemoryPrunePolicy.choose({
      candidates: [
        candidate("clm_passage", { source: "ingest", kind: "passage" }),
        candidate("clm_remembered", { source: "user" }),
      ],
      usage: new Map(),
      excess: 1,
      now: NOW,
    })
    expect(choice.victims).toEqual(["clm_passage"])
  })

  test("REPEATED corrections sink a busy memory below a never-recalled peer; one does not", () => {
    const choice = MemoryPrunePolicy.choose({
      candidates: [candidate("clm_wrong"), candidate("clm_quiet")],
      usage: new Map([
        // Recalled recently and often — but four of those answers were later superseded.
        ["clm_wrong", usage({ accesses: 5, uses: 1, corrections: 4, lastAccessedAt: NOW - DAY })],
      ]),
      excess: 1,
      now: NOW,
    })
    expect(choice.victims).toEqual(["clm_wrong"])
  })

  test("ONE correction is an ordinary fact update and does not condemn a memory", () => {
    const choice = MemoryPrunePolicy.choose({
      candidates: [candidate("clm_moved"), candidate("clm_quiet")],
      usage: new Map([
        // The user moved house once. A policy that read that as noise would forget the store's most
        // active facts fastest.
        ["clm_moved", usage({ accesses: 5, uses: 1, corrections: 1, lastAccessedAt: NOW - DAY })],
      ]),
      excess: 1,
      now: NOW,
    })
    expect(choice.victims).toEqual(["clm_quiet"])
  })

  test("a never-recalled memory is not automatically first — provenance still decides", () => {
    const choice = MemoryPrunePolicy.choose({
      candidates: [
        // Never recalled, but a deliberate `remember`: losing it loses the only copy.
        candidate("clm_remembered", { source: "user" }),
        // Recalled once a year ago, but a bulk passage that can be re-ingested.
        candidate("clm_passage", { source: "ingest" }),
      ],
      usage: new Map([["clm_passage", usage({ lastAccessedAt: NOW - 365 * DAY })]]),
      excess: 1,
      now: NOW,
    })
    // Everything is never-recalled on the day it is written; reading that as worthless would delete
    // the newest half of the store on the first pass.
    expect(choice.victims).toEqual(["clm_passage"])
  })
})

// ── the engine half ───────────────────────────────────────────────────────────────────────────────

let dir: string | undefined
let mem: WasmMemory | undefined

afterEach(async () => {
  await mem?.close()
  mem = undefined
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = undefined
})

const open = async () => {
  dir = mkdtempSync(join(tmpdir(), "kb-prune-"))
  mem = await WasmMemory.open(join(dir, "graph"), { dim: 8 })
  return mem
}

/** ⚠️ Rows written inside one clock tick share a `t_created`, and `ORDER BY` over a tie is arbitrary —
 *  which makes an ordering assertion FLAKY rather than wrong. The gap buys distinct timestamps so the
 *  claim under test ("oldest first") is the only thing that can fail here. */
const spaced = () => new Promise((resolve) => setTimeout(resolve, 15))

describe("the candidate scan, against the shipping engine", () => {
  test("short rows come back complete, oldest first, and the bodies arrive by key", async () => {
    const engine = await open()
    for (const [index, id] of ["m1", "m2", "m3"].entries()) {
      await engine.addMemory({
        id,
        kind: "episode",
        text: `body ${index} `.repeat(400),
        scope: "global",
        relation: "staged",
        source: index === 0 ? "ingest" : "user",
      })
      await spaced()
    }

    const rows = await engine.candidates({ scopes: ["global"], relation: "staged", order: "oldest" })
    expect(rows.map((row) => row.id)).toEqual(["m1", "m2", "m3"])
    // A scan on this engine loses the long string and keeps everything else. The policy reads only
    // the columns that survive, which is why it can run off a scan at all.
    expect(rows[0]).toMatchObject({ scope: "global", kind: "episode", source: "ingest", relation: "staged" })
    expect(rows.every((row) => row.createdAt !== undefined)).toBe(true)

    // …and the bodies come back whole through the primary-key door.
    const hydrated = await engine.byIds(["m2", "nope", "m3"])
    expect(hydrated.map((row) => row.id)).toEqual(["m2", "m3"])
    // Skipped, not faked: the caller asked what is there NOW.
    expect(hydrated[0]!.text.startsWith("body 1")).toBe(true)

    expect(await engine.stagedCount("global")).toBe(3)
    expect(await engine.stagedCount("agent:nobody")).toBe(0)
  })

  test("the newest ordering is the same scan reversed, not a different set", async () => {
    const engine = await open()
    for (const id of ["a", "b", "c"]) {
      await engine.addMemory({ id, kind: "entity", text: id, scope: "global", relation: "staged" })
      await spaced()
    }
    const oldest = await engine.candidates({ order: "oldest" })
    const newest = await engine.candidates({ order: "newest" })
    expect(newest.map((row) => row.id)).toEqual(oldest.map((row) => row.id).toReversed())
  })
})
