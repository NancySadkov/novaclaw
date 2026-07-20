import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { KbChunk } from "@novaclaw/core/kb-graph/chunk"
import { WasmMemory } from "@novaclaw/core/kb-graph/wasm-engine"

// RETRIEVAL regression guard over a REAL document — no model required.
//
// Why this can be a test at all: the document-RAG measurement found answer-correctness tracked
// RETRIEVAL hit-rate exactly (three runs). So the thing worth guarding is whether the passage carrying
// a fact comes back in the top-K — which is deterministic, needs no LLM, and runs in seconds.
//
// Why THIS corpus: `edds-rules.txt` is the owner's own unpublished board-game rules. No model has been
// trained on it, so retrieval cannot be faked by parametric knowledge — a passing query proves the
// index found the text. It has already earned its keep: it exposed the header/row chunking bug that a
// public-domain corpus hid (models know Alice well enough to mask retrieval failures).
//
// FTS-only on purpose: no embedding device, so this stays hermetic and deterministic. The vector leg
// is measured separately (kb-embedding-live.smoke.ts).
//
// ⚠️ WASM: loads the heavy engine runtime, so it is a `.smoke.ts` run in its own process rather than in
// the shared hermetic suite (the runtime destabilises the native fs-watcher there).
//   bun test ./test/kb-retrieval-edds.smoke.ts

const FIXTURE = path.join(import.meta.dir, "fixtures", "edds-rules.txt")
// k=10: a realistic recall budget. MEASURED FTS ranks for the golds below are 1, 2, 4 and 6 — k=5
// would flake on the rank-6 one, so the budget is set from measurement rather than taste.
const K = 10

interface Gold {
  readonly desc: string
  readonly query: string
  /** A distinctive substring of the passage that MUST be retrieved. */
  readonly passage: string
}

// Queries phrased as a user would ask them — not keyword-stuffed to flatter the index.
const GOLD: Gold[] = [
  {
    // measured rank 1
    desc: "tile 18 PUZZLE → opened by being INFORMED",
    query: "In the EDDS board game rules, on the D20 TILE exploration table, what does result 18 (PUZZLE) do, and what is required to open the way back?",
    passage: "PUZZLE",
  },
  {
    // measured rank 6 — the tightest of the four; a chunking regression shows up here first
    desc: "tile 16 CRAMPED → blocks LARGE or GIANT",
    query: "In the EDDS board game rules, on the D20 TILE table, result 16 is CRAMPED. Which creatures does it block from passing?",
    passage: "CRAMPED",
  },
  {
    // measured rank 2
    desc: "BRACED costs 10 XP (5 if CLEVER)",
    query: "In the EDDS board game rules, how much XP does a hero spend to gain BRACED, and what discount applies?",
    passage: "BRACED",
  },
  {
    // measured rank 4
    desc: "Expertise → an INFORMED hero rolling 20 acts again",
    query: "In the EDDS board game rules, under Expertise: what can an INFORMED hero who rolled 20 on an attack do?",
    passage: "act again",
  },
]

let dir: string
let mem: WasmMemory
let passages: string[] = []

beforeAll(async () => {
  const text = fs.readFileSync(FIXTURE, "utf8")
  passages = KbChunk.chunk(KbChunk.stripGutenberg(text))
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-edds-"))
  mem = await WasmMemory.open(path.join(dir, "graph"), { dim: 8 })
  for (let i = 0; i < passages.length; i++)
    await mem.addMemory({ id: `p_${i}`, kind: "passage", name: "EDDS", text: passages[i]!, scope: "global", relation: "core" })
}, 180_000)

afterAll(async () => {
  await mem?.close()
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
})

describe("EDDS retrieval (uncontaminated corpus, FTS)", () => {
  test("the corpus chunks into headed passages", () => {
    expect(passages.length).toBeGreaterThan(50)
    // The header-carrying rule is what makes table rows reachable — assert it survived ingestion.
    expect(passages.filter((p) => p.startsWith("[")).length).toBeGreaterThan(passages.length / 2)
  })

  for (const gold of GOLD) {
    test(`retrieves: ${gold.desc}`, async () => {
      const hits = await mem.search({ query: gold.query, k: K })
      const found = hits.some((h) => h.text.includes(gold.passage))
      if (!found) {
        // Make a regression legible: show what DID come back instead of a bare false.
        console.log(`   top-${K} for "${gold.desc}":\n` + hits.map((h, i) => `     ${i + 1}. ${h.text.slice(0, 110)}`).join("\n"))
      }
      expect(found).toBe(true)
    }, 60_000)
  }

  // KNOWN GAP — the NO-RARE-ANCHOR class. (Earlier called "ordinal-key"; that label was WRONG and the
  // fix it implied — structured row lookup — would have been wasted work. Measured 2026-07-20:)
  //   • The gold row lives in the [D20 ATTACK] table chunk. For the query "D20 ATTACK" that chunk ranks
  //     68th of 68 — LAST — despite containing the phrase.
  //   • Cause is term frequency, not ordinals and not the heading format: "d20" occurs in 198/302 chunks
  //     (idf 0.42) and "attack" in 68 (idf 1.48). Every term in the query is ubiquitous in a combat
  //     rulebook, so the 68 matching chunks are near-tied and ordering among them is noise. The four
  //     queries that DO pass above each contain a rare anchor — puzzle (1 chunk), cramped/braced (2).
  //   • Removing the [brackets] changes nothing; repeating the heading only moves 68 -> 38. No lexical
  //     weighting rescues a query with no rare term, so this is not FTS-tunable.
  //   • The VECTOR leg does rescue it: FTS miss -> hybrid rank 12 and 18. So these stay todo HERE (this
  //     smoke is deliberately FTS-only/hermetic) and are covered in the product by hybrid retrieval plus
  //     over-fetch: default-tier auto-recall pulls 24 candidates (budget 8 x RECALL_OVERFETCH 3), which
  //     contains both, and the reranker can promote them.
  //   • Weak tiers: this line used to read "budget 3 -> 9 candidates, still miss". STALE since
  //     9b4cfb7de decoupled the pool from the context budget (that decoupling came OUT of this very
  //     bisection). recallPoolSize now floors at 16, so a budget-3 tier retrieves 16 and DOES contain
  //     the rank-12 case; only the rank-18 one is still out of reach there. Half the gap closed, not
  //     none and not all — an honest limit of the JH floor, not something to paper over.
  test.todo("retrieves: D20 attack roll 1 → Miss and actor gains Disadvantage (no-rare-anchor class)", () => {})
  test.todo("retrieves: D20 attack roll 9 → Hit unless HARD/ABSURD/THICK (no-rare-anchor class)", () => {})
})
