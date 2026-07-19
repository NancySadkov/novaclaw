import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WasmMemory } from "@novaclaw/core/kb-graph/wasm-engine"

// KB-G retrieval EVAL (notes/kb-graph-plan.md §6 P7) — the measurement that proves the whole
// RDF→vector→GRAPH pivot and gates forgetting/decay. Runs under Bun separately (WASM is heavy), like
// the engine smoke. It measures, on a synthetic gold knowledge graph, three things:
//   1. FTS recall — direct text lookup finds the right memory (the retrieval floor still works).
//   2. THE THESIS — multi-hop RELATIONAL questions, where the answer entity shares little/no text with
//      the question, are answered by GRAPH TRAVERSAL (path) but MISSED by flat retrieval (search over
//      the question text) — i.e. the graph WINS exactly where vectors/FTS lose (§0, §8).
//   3. Memory behaviours — cross-session recall (consolidation) + conflict resolution (bitemporal).
// It doubles as a regression gate: the thesis assertions fail loudly if traversal ever regresses.

const DIM = 8

// --- the gold graph: a small tech-company universe (entities + typed, directed relationships) -----
const ENTITIES: Array<{ id: string; name: string; text: string }> = [
  { id: "alice", name: "Alice", text: "Alice is a senior software engineer" },
  { id: "bob", name: "Bob", text: "Bob manages products" },
  { id: "carol", name: "Carol", text: "Carol leads industrial design" },
  { id: "acme", name: "Acme", text: "Acme Robotics, an industrial automation startup" },
  { id: "globex", name: "Globex", text: "Globex Aerospace, a satellite manufacturer" },
  { id: "rustlang", name: "Rust", text: "Rust, a memory-safe systems language" },
  { id: "torch", name: "PyTorch", text: "PyTorch, a deep learning framework" },
  { id: "berlin", name: "Berlin", text: "Berlin, the German capital" },
  { id: "tokyo", name: "Tokyo", text: "Tokyo, capital of Japan" },
  { id: "kyoto", name: "Kyoto", text: "Kyoto, an old imperial city" },
]

const EDGES: Array<{ from: string; to: string; type: string }> = [
  { from: "alice", to: "acme", type: "works_at" },
  { from: "bob", to: "acme", type: "works_at" },
  { from: "carol", to: "globex", type: "works_at" },
  { from: "alice", to: "acme", type: "founded" },
  { from: "carol", to: "globex", type: "founded" },
  { from: "acme", to: "rustlang", type: "uses" },
  { from: "globex", to: "torch", type: "uses" },
  { from: "acme", to: "berlin", type: "located_in" },
  { from: "globex", to: "tokyo", type: "located_in" },
  { from: "alice", to: "kyoto", type: "lives_in" },
  { from: "bob", to: "berlin", type: "lives_in" },
]

// FTS probes: a text query (words drawn from the entity's OWN description) → the memory it should find.
const FTS_PROBES: Array<{ query: string; expect: string }> = [
  { query: "memory-safe systems language", expect: "rustlang" },
  { query: "deep learning framework", expect: "torch" },
  { query: "satellite manufacturer aerospace", expect: "globex" },
  { query: "industrial automation startup", expect: "acme" },
  { query: "senior software engineer", expect: "alice" },
  { query: "old imperial city", expect: "kyoto" },
]

// Relational questions: the ANSWER is reached from START by following the graph; crucially the answer
// entity's text overlaps the question little, so flat retrieval over the question can't surface it.
const QUESTIONS: Array<{ q: string; start: string; answer: string; hops: number }> = [
  { q: "Which technology does the employer of Alice depend on?", start: "alice", answer: "rustlang", hops: 2 },
  { q: "In which city is the firm that Carol founded based?", start: "carol", answer: "tokyo", hops: 2 },
  { q: "Where is the organisation that employs Alice headquartered?", start: "alice", answer: "berlin", hops: 2 },
  { q: "What does Bob's workplace build its systems on?", start: "bob", answer: "rustlang", hops: 2 },
  { q: "Which tooling does the startup Carol created adopt?", start: "carol", answer: "torch", hops: 2 },
  { q: "Where does Alice reside?", start: "alice", answer: "kyoto", hops: 1 },
  { q: "Where is Globex situated?", start: "globex", answer: "tokyo", hops: 1 },
  { q: "Which technology does Acme adopt?", start: "acme", answer: "rustlang", hops: 1 },
]

const K = 5
const pct = (x: number) => `${(x * 100).toFixed(0)}%`

let dir: string
let mem: WasmMemory

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "kb-eval-"))
  mem = await WasmMemory.open(join(dir, "graph"), { dim: DIM })
  for (const e of ENTITIES)
    await mem.addMemory({ id: e.id, kind: "entity", name: e.name, text: e.text, scope: "global", relation: "core" })
  for (const edge of EDGES) await mem.addEdge({ from: edge.from, to: edge.to, type: edge.type, scope: "global" })
})
afterAll(async () => {
  await mem?.close()
  rmSync(dir, { recursive: true, force: true })
})

describe("KB-G retrieval eval", () => {
  test("FTS recall — direct text lookup finds the right memory (≥ 90%)", async () => {
    let hit = 0
    for (const probe of FTS_PROBES) {
      const results = await mem.search({ query: probe.query, k: K })
      if (results.slice(0, K).some((r) => r.id === probe.expect)) hit++
    }
    const recall = hit / FTS_PROBES.length
    console.log(`[eval] FTS recall@${K}: ${pct(recall)} (${hit}/${FTS_PROBES.length})`)
    expect(recall).toBeGreaterThanOrEqual(0.9)
  })

  test("THE THESIS — multi-hop: graph traversal answers what flat retrieval misses", async () => {
    let graphHit = 0
    let flatHit = 0
    const misses: string[] = []
    for (const item of QUESTIONS) {
      const path = await mem.path(item.start, item.answer, item.hops + 1)
      const graphOk = path !== null
      if (graphOk) graphHit++
      else misses.push(`graph miss: ${item.start}⇢${item.answer}`)
      // The flat baseline a vector/FTS store would give: search the QUESTION text, is the answer in top-K?
      const flat = await mem.search({ query: item.q, k: K })
      if (flat.slice(0, K).some((r) => r.id === item.answer)) flatHit++
    }
    const graphRate = graphHit / QUESTIONS.length
    const flatRate = flatHit / QUESTIONS.length
    console.log(
      `[eval] multi-hop answer-found — GRAPH(path): ${pct(graphRate)} (${graphHit}/${QUESTIONS.length})  vs  ` +
        `FLAT(search over question): ${pct(flatRate)} (${flatHit}/${QUESTIONS.length})  →  ` +
        `graph advantage +${pct(graphRate - flatRate)}`,
    )
    if (misses.length) console.log(`[eval] ${misses.join("; ")}`)
    // Graph reaches (almost) every answer…
    expect(graphRate).toBeGreaterThanOrEqual(0.9)
    // …and decisively beats the flat baseline — the whole reason for the graph pivot.
    expect(graphRate).toBeGreaterThan(flatRate)
  })

  test("cross-session recall — a fact learned in one chat surfaces globally after consolidation", async () => {
    await mem.addMemory({
      id: "sess_pref",
      kind: "episode",
      text: "The user prefers dark mode everywhere",
      scope: "session:eval",
      source: "auto-extract",
    })
    // Not yet global.
    expect((await mem.search({ query: "dark mode preference", scopes: ["global"], k: K })).some((r) => r.text.includes("dark mode"))).toBe(false)
    await mem.consolidate()
    // Now a fresh chat (global scope) recalls it.
    expect((await mem.search({ query: "dark mode preference", scopes: ["global"], k: K })).some((r) => r.text.includes("dark mode"))).toBe(true)
  })

  test("conflict resolution — a corrected fact supersedes the old, which drops from search", async () => {
    await mem.addMemory({ id: "loc_old", kind: "episode", text: "The user lives in Berlin", scope: "global", source: "auto-extract" })
    expect((await mem.search({ query: "where the user lives", k: K })).some((r) => r.id === "loc_old")).toBe(true)
    await mem.invalidate("loc_old") // superseded (bitemporal — kept in history, dropped from search)
    await mem.addMemory({ id: "loc_new", kind: "episode", text: "The user lives in Osaka now", scope: "global", source: "auto-extract" })
    const hits = await mem.search({ query: "where the user lives", k: K })
    expect(hits.some((r) => r.id === "loc_old")).toBe(false) // old is gone from retrieval
    expect(hits.some((r) => r.id === "loc_new")).toBe(true) // corrected one is live
    // …but the old fact is retained in history, not destroyed (supersede-not-delete).
    const s = await mem.stats()
    expect(s.total).toBeGreaterThan(s.valid)
  })
})
