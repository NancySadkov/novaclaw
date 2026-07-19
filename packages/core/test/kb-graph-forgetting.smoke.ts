import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WasmMemory } from "@novaclaw/core/kb-graph/wasm-engine"

// KB-G forgetting/decay EVAL (notes/kb-graph-plan.md §1.3.5, §4.7 — P7's forgetting half). Runs under
// Bun separately (WASM is heavy). It MEASURES the gate and PROVES the mechanism:
//   • Honest measurement (logged): with well-specified queries, FTS recall for the real facts is ROBUST
//     even under a flood of near-duplicate low-value noise (BM25 keeps the tight match on top). So
//     forgetting's job is NOT to rescue degraded recall — it's to BOUND unbounded growth (§4.7, a
//     resource/hygiene guarantee) while PRESERVING the curated, high-value facts.
//   • The `prune` guarantees, proven: it caps the valid `staged` set to `maxStaged`, forgets the
//     LOWEST-importance (confidence) first, NEVER touches curated `core`, keeps recall intact, and is
//     bitemporal (forgotten = invalidated, kept in history — not destroyed).

const DIM = 8
const K = 5
const pct = (x: number) => `${(x * 100).toFixed(0)}%`

// Real facts to keep recalling: a realistic mix of CURATED (core, never forgettable) + high-confidence
// STAGED (auto-learned but strong). Each carries a probe query drawn from its own text.
const GOLD: Array<{ id: string; text: string; relation: "core" | "staged"; confidence: number; probe: string }> = [
  { id: "g_rust", text: "Rust is a memory-safe systems programming language", relation: "core", confidence: 0.95, probe: "memory-safe systems programming language" },
  { id: "g_torch", text: "PyTorch is a deep learning framework for tensor computation", relation: "core", confidence: 0.95, probe: "deep learning framework tensor computation" },
  { id: "g_berlin", text: "Berlin is the capital city of Germany", relation: "staged", confidence: 0.9, probe: "capital city of Germany" },
  { id: "g_pref", text: "The user prefers concise and direct answers", relation: "staged", confidence: 0.9, probe: "user prefers concise direct answers" },
  { id: "g_kyoto", text: "Kyoto is an old imperial city in Japan", relation: "staged", confidence: 0.9, probe: "old imperial city in Japan" },
]
const GOLD_STAGED = GOLD.filter((g) => g.relation === "staged").length // = 3
const DISTRACTORS_PER_PROBE = 12

let dir: string
let mem: WasmMemory

const seedGold = () =>
  Promise.all(
    GOLD.map((g) =>
      mem.addMemory({ id: g.id, kind: "entity", text: g.text, scope: "global", relation: g.relation, confidence: g.confidence, source: "seed" }),
    ),
  )

// Low-confidence STAGED noise that tightly overlaps each probe (the near-duplicate contamination case).
const seedNoise = async () => {
  let n = 0
  for (const g of GOLD) {
    for (let i = 0; i < DISTRACTORS_PER_PROBE; i++) {
      await mem.addMemory({ id: `noise_${n}`, kind: "entity", text: `${g.probe} note ${n}`, scope: "global", relation: "staged", confidence: 0.1, source: "auto-extract" })
      n++
    }
  }
  return n
}

const recall = async (): Promise<number> => {
  let hit = 0
  for (const g of GOLD) if ((await mem.search({ query: g.probe, k: K })).slice(0, K).some((r) => r.id === g.id)) hit++
  return hit / GOLD.length
}
const stagedvalid = async () => (await mem.list({ scopes: ["global"], limit: 5000 })).filter((m) => m.relation === "staged").length

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kb-forget-"))
  mem = await WasmMemory.open(join(dir, "graph"), { dim: DIM })
})
afterAll(async () => {
  await mem?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("KB-G forgetting / decay", () => {
  test("prune bounds staged growth to the cap, forgets lowest-value first, never touches core, keeps recall", async () => {
    await seedGold()
    const baseline = await recall()
    expect(baseline).toBe(1)

    const injected = await seedNoise()
    // Honest measurement: precise-query FTS recall is robust to near-duplicate noise (BM25 keeps the
    // tight match on top). Logged, not asserted — the point of forgetting here is growth, not recall.
    const noisyRecall = await recall()
    console.log(
      `[forget] after ${injected} low-value staged distractors: valid staged = ${await stagedvalid()}, ` +
        `recall@${K} still ${pct(noisyRecall)} (FTS robust — forgetting is for GROWTH, not recall-rescue)`,
    )

    // Forget: bound the staged set to the high-value gold. Core is exempt from the cap.
    const forgotten = await mem.prune({ scope: "global", maxStaged: GOLD_STAGED })
    console.log(`[forget] prune(maxStaged=${GOLD_STAGED}) forgot ${forgotten} memories → valid staged now ${await stagedvalid()}`)
    expect(forgotten).toBe(injected) // exactly the low-confidence distractors were dropped
    expect(await stagedvalid()).toBe(GOLD_STAGED) // growth is bounded to the cap

    // Every gold fact survived: core is never a victim, and the high-confidence staged outrank the noise.
    const survivors = new Set((await mem.list({ scopes: ["global"], limit: 5000 })).map((m) => m.id))
    for (const g of GOLD) expect(survivors.has(g.id)).toBe(true)

    // Recall for the real facts is preserved (forgetting removed only noise).
    expect(await recall()).toBe(baseline)

    // Bitemporal: forgotten memories are invalidated (kept in history), not destroyed.
    const s = await mem.stats()
    expect(s.total).toBeGreaterThan(s.valid)
    expect(s.total).toBe(GOLD.length + injected)
  }, 30_000)

  test("importance order: prune forgets the LOWEST-confidence staged first", async () => {
    const d2 = mkdtempSync(join(tmpdir(), "kb-forget2-"))
    const m2 = await WasmMemory.open(join(d2, "graph"), { dim: DIM })
    try {
      // Five staged facts, distinct confidences; keep the top 2 by importance.
      const conf = { a: 0.1, b: 0.3, c: 0.5, d: 0.7, e: 0.9 }
      for (const [id, c] of Object.entries(conf))
        await m2.addMemory({ id, kind: "entity", text: `fact ${id}`, scope: "global", relation: "staged", confidence: c })
      expect(await m2.prune({ scope: "global", maxStaged: 2 })).toBe(3)
      const kept = new Set((await m2.list({ scopes: ["global"], limit: 100 })).map((m) => m.id))
      expect([...kept].sort()).toEqual(["d", "e"]) // the two highest-confidence survive; a,b,c forgotten
    } finally {
      await m2.close()
      rmSync(d2, { recursive: true, force: true })
    }
  }, 30_000)

  test("prune is a no-op below the cap", async () => {
    const before = await mem.stats()
    expect(await mem.prune({ scope: "global", maxStaged: 100 })).toBe(0)
    expect((await mem.stats()).valid).toBe(before.valid)
  })
})
