#!/usr/bin/env bun
/**
 * THE RETRIEVAL/READER ABLATION RUNNER.
 *
 * Builds the fixed corpus in a throwaway WASM store, runs every condition over the same store with
 * the same retrieval path, and reports retrieval and reader results SEPARATELY.
 *
 * 🔴 **The two arms are PARAMETERS, not forks of the engine.**
 *   · supersession off = pass the full status set, so retired claims compete as equals. That is
 *     exactly what `search` does when a caller asks for history, so nothing about the engine changes.
 *   · edges off = skip the traversal leg. The leg itself lives here, in the runner, because
 *     production auto-recall does NOT traverse today — see the note below, it matters for how the
 *     numbers are read.
 *
 * ⚠️ **The edges-on arm measures a CANDIDATE capability, not the shipped path.** `session/runner/llm.ts`
 * calls `memory.search` and nothing else; there is no `neighbors` leg in auto-recall. So an edges-on
 * gain is an argument for ADDING one, and an edges-off number is what the product does today.
 *
 * Usage:
 *   bun script/ablation.ts                       # retrieval only
 *   bun script/ablation.ts --reader              # retrieval + the reader half
 *   bun script/ablation.ts --reader --samples 3
 *
 * Endpoints come from the environment so no model id is ever copied from a document:
 *   ABLATION_EMBED_URL   default http://192.168.178.40:8001/v1
 *   ABLATION_EMBED_MODEL default qwen3-embedding
 *   ABLATION_READER_URL  default http://192.168.178.40:8010/v1
 *   ABLATION_READER_MODEL — REQUIRED with --reader; list the catalog, do not copy an id.
 */

import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseArgs } from "node:util"
import { KbAblationEval } from "./ablation-eval"
import { KbClaim } from "../src/kb-graph/claim"
import { KbEmbedder } from "../src/kb-graph/embedder"
import type { MemoryClient } from "../src/kb-graph/memory-client"
import { SessionRecall } from "../src/session/runner/recall"
import { WasmMemory } from "../src/kb-graph/wasm-engine"

const args = parseArgs({
  args: process.argv.slice(2),
  options: {
    reader: { type: "boolean" },
    samples: { type: "string" },
    k: { type: "string" },
    temp: { type: "string" },
    only: { type: "string" },
  },
})
const SAMPLES = Math.max(1, Number(args.values.samples ?? 3))
const K = Math.max(1, Number(args.values.k ?? 8))
/**
 * ⚠️ **At temperature 0 more samples are more COPIES.** Three identical prompts to a greedy decoder
 * are one measurement written down three times, so a run at the default proves the retrieval effect
 * and says nothing at all about how stable the reader is. Raise this to sample the decoder for real.
 */
const TEMP = Number(args.values.temp ?? 0)
const EMBED_URL = process.env.ABLATION_EMBED_URL ?? "http://192.168.178.40:8001/v1"
const EMBED_MODEL = process.env.ABLATION_EMBED_MODEL ?? "qwen3-embedding"
const READER_URL = process.env.ABLATION_READER_URL ?? "http://192.168.178.40:8010/v1"
const READER_MODEL = process.env.ABLATION_READER_MODEL

const SCOPE = "global"

/**
 * The vector leg, through the same OpenAI-compatible shape and the same decoder production uses.
 *
 * ⚠️ NOT `KbEmbedder.embed`, and the difference is worth naming: that reads the device out of the
 * instance settings database, which this rig does not have. `parseEmbeddings` is imported from it, so
 * a reply this accepts is a reply the product would accept.
 */
const embed = async (texts: readonly string[]): Promise<number[][] | undefined> => {
  if (texts.length === 0) return []
  try {
    const res = await fetch(`${EMBED_URL}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) return undefined
    return KbEmbedder.parseEmbeddings(await res.json(), texts.length)
  } catch {
    return undefined
  }
}

const ask = async (system: string, user: string): Promise<string> => {
  const res = await fetch(`${READER_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: READER_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: TEMP,
      // ⚠️ Not a small budget. A thinking model on 300 tokens returns NOTHING at all, and an empty
      // reply scored as "no wrong answer" would flatter a run that produced no answers.
      max_tokens: 1024,
      chat_template_kwargs: { enable_thinking: false },
    }),
    signal: AbortSignal.timeout(180_000),
  })
  if (!res.ok) return ""
  const body = (await res.json()) as { choices?: { message?: { content?: string | null } }[] }
  return body.choices?.[0]?.message?.content ?? ""
}

/** Everything exactly two hops from `seed` over the undirected adjacency, seed and hubs excluded. */
const twoHop = (adjacency: ReadonlyMap<string, ReadonlyArray<string>>, seed: string): string[] => {
  const out: string[] = []
  for (const first of adjacency.get(seed) ?? [])
    for (const second of adjacency.get(first) ?? []) if (second !== seed && !out.includes(second)) out.push(second)
  return out
}

const main = async () => {
  if (args.values.reader && (READER_MODEL === undefined || READER_MODEL === "")) {
    console.error("--reader needs ABLATION_READER_MODEL. List the catalog; do not copy an id from a doc.")
    process.exit(2)
  }
  const dir = mkdtempSync(join(tmpdir(), "kb-ablation-"))
  const vectors = await embed(KbAblationEval.CORPUS.map((item) => item.text))
  if (vectors === undefined) console.error("!! no embedding device — the vector leg is OFF for this run")
  const engine = await WasmMemory.open(join(dir, "graph"), { dim: vectors ? vectors[0]!.length : 8 })
  try {
    // ── build the corpus ────────────────────────────────────────────────────────────────────────
    const idOfKey = new Map<string, string>()
    for (const [index, item] of KbAblationEval.CORPUS.entries()) {
      const embedding = vectors?.[index]
      if (item.kind === "claim") {
        const result = await engine.addClaim({
          scope: SCOPE,
          statement: item.text,
          ...(item.subject === undefined ? {} : { subject: item.subject }),
          ...(item.predicate === undefined ? {} : { predicate: item.predicate }),
          ...(embedding ? { embedding } : {}),
        })
        if (!result.ok || result.id === undefined) throw new Error(`claim refused: ${item.key} ${result.reason}`)
        idOfKey.set(item.key, result.id)
      } else {
        const id = `${item.kind === "passage" ? "psg" : "ent"}_${item.key.replaceAll(/[^a-z0-9]/gi, "_")}`
        await engine.addMemory({
          id,
          kind: item.kind,
          text: item.text,
          ...(item.name === undefined ? {} : { name: item.name }),
          scope: SCOPE,
          relation: "staged",
          ...(item.kind === "passage" ? { source: "ingest" } : {}),
          ...(embedding ? { embedding } : {}),
        })
        idOfKey.set(item.key, id)
      }
      // Distinct `t_created` per row: rows written inside one clock tick tie, and an ordering that
      // depends on a tie is a measurement that moves between runs.
      await new Promise((resolve) => setTimeout(resolve, 12))
    }
    for (const edge of KbAblationEval.EDGES) {
      const from = idOfKey.get(edge.from)
      const to = idOfKey.get(edge.to)
      if (from === undefined || to === undefined) throw new Error(`edge endpoint missing: ${edge.from}->${edge.to}`)
      const written = await engine.addEdge({ from, to, type: edge.type, scope: SCOPE })
      if (!written.ok) throw new Error(`edge refused: ${edge.from}->${edge.to}`)
    }
    const keyOfID = new Map([...idOfKey].map(([key, id]) => [id, key] as const))

    /**
     * 🔴 **THE ADJACENCY IS BUILT UNDIRECTED, FROM `graph()`, AND THAT IS A FINDING RATHER THAN A
     * CONVENIENCE.**
     *
     * `WasmMemory.neighbors` matches `(m)-[r:Rel]->(n)` — strictly OUTGOING. Measured here on the
     * shipping engine: with `ann.employer.new -> acme.entity` and `acme.product -> acme.entity`
     * stored, `neighbors(ann.employer.new)` returns the Acme entity and `neighbors(acme.entity)`
     * returns NOTHING, so the second hop is a dead end. That is not peculiar to this corpus — it is
     * the shape the lifecycle itself writes: every `subject` edge points claim → entity, so in a real
     * NovaClaw store a bridge entity is always a SINK and no `neighbors`-based traversal can ever
     * complete a two-hop question.
     *
     * The runner therefore walks the edge list `graph()` already returns, in both directions, so the
     * ablation measures what a traversal LEG buys rather than what today's outgoing-only accessor
     * happens to reach. Shipping such a leg would need a bidirectional neighbour query — a real
     * engine change, deliberately not made here.
     */
    const slice = await engine.graph({ scopes: [SCOPE], limit: 5000 })
    const adjacency = new Map<string, string[]>()
    for (const edge of slice.edges) {
      adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to])
      adjacency.set(edge.to, [...(adjacency.get(edge.to) ?? []), edge.from])
    }

    // Sanity: the lifecycle must actually have retired the two priors, or the supersession arm is
    // measuring nothing. A control that validates the PATH rather than the experiment is worthless.
    for (const key of ["ann.employer.old", "harbor.status.old"]) {
      const rows = await engine.byIds([idOfKey.get(key)!])
      if (rows[0]?.status !== "superseded") throw new Error(`${key} was not superseded — the corpus is wrong`)
    }

    // ── the runs ───────────────────────────────────────────────────────────────────────────────
    const rows: string[] = []
    const readerRows: string[] = []
    const conditions = KbAblationEval.CONDITIONS.filter(
      (condition) =>
        args.values.only === undefined || KbAblationEval.conditionName(condition).includes(args.values.only),
    )
    for (const condition of conditions) {
      const retrieval: KbAblationEval.RetrievalScore[] = []
      const reader: { id: string; kind: string; ok: number; wrong: number; empty: number }[] = []
      for (const question of KbAblationEval.QUESTIONS) {
        const queryVector = (await embed([question.text]))?.[0]
        const base = await engine.search({
          query: question.text,
          k: K,
          scopes: [SCOPE],
          ...(condition.supersession ? {} : { statuses: KbClaim.CLAIM_STATUSES }),
          ...(queryVector ? { embedding: queryVector } : {}),
        })
        /**
         * THE TRAVERSAL LEG.
         *
         * 🔴 **It is given a RESERVED SHARE of the budget, not appended below the lexical answer.**
         * The first version appended neighbours and then capped at `k`, so the lexical leg — which
         * already returns `k` — silently ate every slot and the arm measured nothing: edges-on and
         * edges-off produced byte-identical results across all eight questions. A leg that cannot
         * displace anything is not a leg. Two of eight slots is the same shape the engine already
         * uses to stop ingested passages taking a whole page of recall.
         *
         * ⚠️ **Entities are traversed THROUGH, never returned.** An entity node's text is its name,
         * so it answers nothing; spending a reserved slot on the bridge itself would make the leg
         * look busy while delivering the one row in the store with no content in it.
         *
         * ⚠️ Supersession is honoured on this leg too. A traversal that quietly reintroduced retired
         * claims would confound the two arms — the edges-off/supersession-on cell would be the only
         * one with the lifecycle actually applied.
         */
        const EDGE_SLOTS = 2
        let hits: MemoryClient.SearchHit[] = [...base]
        if (condition.edges) {
          const seen = new Set(base.map((hit) => hit.id))
          const found: MemoryClient.SearchHit[] = []
          for (const seed of base.slice(0, 3))
            for (const second of twoHop(adjacency, seed.id)) {
              if (seen.has(second) || found.some((row) => row.id === second)) continue
              const row = (await engine.byIds([second]))[0]
              if (row === undefined || row.kind === "entity") continue
              if (condition.supersession && KbClaim.isRetired(row.status)) continue
              found.push({ ...row, score: 0 })
            }
          const reserved = found.slice(0, EDGE_SLOTS)
          hits = [...base.slice(0, Math.max(0, K - reserved.length)), ...reserved]
        }
        retrieval.push(KbAblationEval.scoreRetrieval(question, hits, keyOfID))

        if (args.values.reader) {
          const pack = SessionRecall.packRecall(hits, SessionRecall.recallTokenBudget(undefined))
          const block = SessionRecall.formatRecall(pack) ?? "You remember nothing relevant."
          let ok = 0
          let wrong = 0
          let empty = 0
          for (let sample = 0; sample < SAMPLES; sample += 1) {
            const reply = await ask(block, `${question.text}\nAnswer in one short sentence.`)
            if (reply.trim() === "") empty += 1
            const graded = KbAblationEval.gradeAnswer(question, reply)
            if (graded.ok) ok += 1
            if (graded.wrong) wrong += 1
          }
          reader.push({ id: question.id, kind: question.kind, ok, wrong, empty })
        }
      }
      const name = KbAblationEval.conditionName(condition)
      const hits = retrieval.filter((row) => row.hit).length
      const stale = retrieval.filter((row) => row.staleAboveGold).length
      rows.push(
        `${name} | answerable@${K} ${hits}/${retrieval.length} | stale-above-gold ${stale} | ` +
          retrieval
            .map(
              (row) =>
                `${row.questionID}:` +
                (row.goldPresent ? `r${row.goldRank}` : "MISS") +
                (row.bridgePresent ? "" : "-nobridge") +
                (row.staleAboveGold ? "!" : ""),
            )
            .join(" "),
      )
      if (args.values.reader)
        readerRows.push(
          `${name} | correct ${reader.reduce((sum, row) => sum + row.ok, 0)}/${reader.length * SAMPLES} | ` +
            `answered-from-retired ${reader.reduce((sum, row) => sum + row.wrong, 0)} | ` +
            `empty ${reader.reduce((sum, row) => sum + row.empty, 0)} | ` +
            reader.map((row) => `${row.id}:${row.ok}/${SAMPLES}`).join(" "),
        )
    }
    console.log("\n=== RETRIEVAL (the store, alone) ===")
    for (const row of rows) console.log(row)
    if (args.values.reader) {
      console.log(`\n=== READER (${READER_MODEL}, n=${SAMPLES}, temperature=${TEMP}) ===`)
      for (const row of readerRows) console.log(row)
    } else {
      console.log("\n=== READER: not run (no --reader) ===")
    }
  } finally {
    await engine.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

await main()
