#!/usr/bin/env bun
/**
 * THE ABLATION, AGAINST A REAL DOCUMENT.
 *
 * 🔴 **Why this exists beside `ablation.ts`.** That runner's corpus is 29 hand-built memories, and
 * one of its verdicts does not survive the change of scale. *"Traversal does not earn its place"* was
 * measured where the WHOLE STORE is 29 rows and every question's answer is already inside a `k = 8`
 * lexical recall — there is nothing for a hop to reach that the first leg did not already return. A
 * real document is hundreds of passages hung off a document entity by `part_of` edges, with entity
 * hubs joined to them by `mentions`, and that is the shape a traversal leg exists FOR. The
 * supersession verdict is not re-run here: its mechanism is local to a conflict pair and does not
 * depend on how much else is in the store.
 *
 * 🔴 **The document is ingested the way the PRODUCT ingests it, not a rig's imitation.**
 * `KbIngest.planIngest` is the same function `POST /memory/ingest` calls, so the chunker, the
 * document entity, the passage ids and the `part_of` edges are the shipped ones. Absorption reuses
 * `KbAbsorb.SYSTEM` (the prompt), `SessionExtract.parseExtraction` (the parser) and
 * `KbChunk.entityID` (the identity) — everything that decides WHAT the graph ends up looking like —
 * over a plain OpenAI-compatible call, because the Effect layer this rig would otherwise need brings
 * an instance settings database with it. That is the same trade `ablation.ts` already makes for
 * embeddings, where it imports `parseEmbeddings` and speaks HTTP itself.
 *
 * ⚠️ **`--absorb` is REQUIRED and has no default**, for the reason `KbAbsorb.absorb` gives: every
 * passage costs a model call and a document is hundreds of passages. A run that absorbed a subset
 * must say so in its report — an entity graph over 200 of 1160 passages is a different object from
 * one over all of them, and reading the second number off the first is how a measurement lies.
 *
 * Two phases, so questions can be written against the graph that actually exists rather than against
 * a guess, and so re-authoring them costs no model calls:
 *
 *   bun script/ablation-corpus.ts build   --doc <file> --name <label> --store <dir> --absorb 200
 *   bun script/ablation-corpus.ts inspect --store <dir> [--entity <substring>]
 *   bun script/ablation-corpus.ts measure --store <dir> --questions <file.json> [--reader] [--k 8]
 *
 * Endpoints, as in `ablation.ts` — no model id is ever copied from a document:
 *   ABLATION_EMBED_URL / ABLATION_EMBED_MODEL / ABLATION_READER_URL / ABLATION_READER_MODEL
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { parseArgs } from "node:util"
import { KbAblationEval } from "./ablation-eval"
import { KbAbsorb } from "../src/kb-graph/absorb"
import { KbChunk } from "../src/kb-graph/chunk"
import { KbClaim } from "../src/kb-graph/claim"
import { KbEmbedder } from "../src/kb-graph/embedder"
import * as KbIngest from "../src/kb-graph/ingest-plan"
import type { MemoryClient } from "../src/kb-graph/memory-client"
import { SessionExtract } from "../src/session/runner/extract"
import { SessionRecall } from "../src/session/runner/recall"
import { WasmMemory } from "../src/kb-graph/wasm-engine"

const args = parseArgs({
  args: process.argv.slice(3),
  options: {
    doc: { type: "string" },
    name: { type: "string" },
    store: { type: "string" },
    absorb: { type: "string" },
    questions: { type: "string" },
    entity: { type: "string" },
    reader: { type: "boolean" },
    samples: { type: "string" },
    k: { type: "string" },
    temp: { type: "string" },
    limit: { type: "string" },
  },
})
const PHASE = process.argv[2]
const STORE = args.values.store
const SCOPE = "global"
const K = Math.max(1, Number(args.values.k ?? 8))
const SAMPLES = Math.max(1, Number(args.values.samples ?? 1))
const TEMP = Number(args.values.temp ?? 0)
/**
 * 🔴 **HOW BIG A SLICE THE ENGINE CAN ACTUALLY SERVE — measured, not chosen.**
 *
 * `WasmMemory.graph()` clamps `limit` to 5000, and on this corpus (1833 nodes after ingesting ONE
 * 181 KB document) it dies well below its own clamp. Measured 2026-08-26 against the shipping engine:
 *
 *     limit  600  OK      9.9 s   600 nodes / 689 edges   omitted 1233
 *     limit 1200  OK     10.9 s  1200 nodes / 1507 edges  omitted  633
 *     limit 2000  FAILED 11.3 s  "Buffer manager exception: the buffer pool is full"
 *
 * `graph()` hydrates one query PER ID (`wasm-engine.ts` `hydrate`), which is what fills the pool. So
 * the whole graph of a single document is not obtainable through the only bidirectional edge source
 * the engine has — see the traversal note in `measure` below.
 *
 * ⚠️ 1200 is the largest slice that works, and it is `connected-first`, so it is the BEST-connected
 * two thirds of the store. That is deliberately generous to the traversal arm: if a hop cannot earn
 * its place there, it will not earn it on the rest.
 */
const SLICE_LIMIT = 1200

const EMBED_URL = process.env.ABLATION_EMBED_URL ?? "http://192.168.178.40:8001/v1"
const EMBED_MODEL = process.env.ABLATION_EMBED_MODEL ?? "qwen3-embedding"
const READER_URL = process.env.ABLATION_READER_URL ?? "http://192.168.178.40:8010/v1"
const READER_MODEL = process.env.ABLATION_READER_MODEL

const die = (message: string): never => {
  console.error(message)
  process.exit(2)
}
if (STORE === undefined) die("--store <dir> is required")

/** The vector leg, through the product's own reply parser. Identical to `ablation.ts`'s. */
const embed = async (texts: readonly string[]): Promise<number[][] | undefined> => {
  if (texts.length === 0) return []
  try {
    const res = await fetch(`${EMBED_URL}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
      signal: AbortSignal.timeout(120_000),
    })
    if (!res.ok) return undefined
    return KbEmbedder.parseEmbeddings(await res.json(), texts.length)
  } catch {
    return undefined
  }
}

const complete = async (system: string, user: string, maxTokens: number, thinking: boolean): Promise<string> => {
  try {
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
        max_tokens: maxTokens,
        chat_template_kwargs: { enable_thinking: thinking },
      }),
      signal: AbortSignal.timeout(240_000),
    })
    if (!res.ok) return ""
    const body = (await res.json()) as { choices?: { message?: { content?: string | null } }[] }
    return body.choices?.[0]?.message?.content ?? ""
  } catch {
    return ""
  }
}

const openStore = async (dim: number) => {
  mkdirSync(STORE!, { recursive: true })
  return WasmMemory.open(join(STORE!, "graph"), { dim })
}

/** Embed in batches: one request per 64 texts, so a 1 MB document does not become one enormous body. */
const embedAll = async (texts: readonly string[]): Promise<number[][] | undefined> => {
  const out: number[][] = []
  for (let index = 0; index < texts.length; index += 64) {
    const batch = await embed(texts.slice(index, index + 64))
    if (batch === undefined) return undefined
    out.push(...batch)
    process.stdout.write(`\r  embedded ${out.length}/${texts.length}`)
  }
  process.stdout.write("\n")
  return out
}

// ─── build ────────────────────────────────────────────────────────────────────────────────────────

const build = async () => {
  const doc = args.values.doc ?? die("--doc <file> is required for build")
  const label = args.values.name ?? basename(doc)
  if (args.values.absorb === undefined) die("--absorb <n> is required — every passage costs a model call")
  const absorbLimit = Math.max(0, Number(args.values.absorb))
  if (absorbLimit > 0 && (READER_MODEL === undefined || READER_MODEL === ""))
    die("--absorb needs ABLATION_READER_MODEL. List the catalog; do not copy an id from a doc.")

  const text = readFileSync(doc, "utf8")
  const plan = KbIngest.planIngest({ name: label, text, scope: SCOPE })
  console.log(`· ${label}: ${text.length} chars -> ${plan.passages.length} passages + 1 document entity`)

  const bodies = [plan.document.text, ...plan.passages.map((passage) => passage.text)]
  const vectors = await embedAll(bodies)
  if (vectors === undefined) console.error("!! no embedding device — the vector leg is OFF for this store")
  const dim = vectors ? vectors[0]!.length : 8
  const engine = await openStore(dim)
  const vectorOf = new Map<string, number[]>()
  if (vectors) {
    vectorOf.set(plan.document.id, vectors[0]!)
    for (const [index, passage] of plan.passages.entries()) vectorOf.set(passage.id, vectors[index + 1]!)
  }

  try {
    // The PRODUCT's own step order — node before edge, `Effect.ignore` per step, exactly as the
    // ingest handler does it. A duplicate id dedupes rather than failing, which is why the count
    // below is a delta and not a tally of successful calls.
    let steps = 0
    for (const step of plan.steps) {
      if (step.kind === "memory") {
        const vector = vectorOf.get(step.input.id)
        await engine
          .addMemory({ ...step.input, ...(vector ? { embedding: vector } : {}) })
          .catch(() => undefined)
      } else {
        await engine.addEdge(step.input).catch(() => undefined)
      }
      steps++
      if (steps % 100 === 0) process.stdout.write(`\r  wrote ${steps}/${plan.steps.length} steps`)
    }
    process.stdout.write(`\r  wrote ${steps}/${plan.steps.length} steps\n`)

    const structural = await engine.stats()
    console.log(`· after ingest: ${structural.total} nodes`)

    // ── absorption: the same prompt, parser and entity identity the product uses ────────────────
    //
    // 🔴 **RESUMABLE, because a long build died silently once.** The first run of this script over
    // the board-game rules stopped at passage 79 of 302 with exit code 0, no error and no output —
    // it was sharing the box with a `serve` and a WASM-engine test suite, and something reaped it.
    // Absorption is the expensive half (one model call per passage, ~24 s each on the fleet target),
    // so losing it to an interruption means losing hours. A passage that already has an outgoing
    // `mentions` edge has been absorbed; the store itself is the progress record, so there is no
    // second file to keep true.
    const absorbedAlready = new Set(
      (await engine.graph({ scopes: [SCOPE], limit: SLICE_LIMIT })).edges
        .filter((edge) => edge.type === "mentions")
        .map((edge) => edge.from),
    )
    if (absorbedAlready.size > 0) console.log(`· resuming: ${absorbedAlready.size} passages already absorbed`)
    let entities = 0
    let absorbed = absorbedAlready.size
    for (const passage of plan.passages.slice(0, absorbLimit)) {
      if (absorbedAlready.has(passage.id)) continue
      const reply = await complete(KbAbsorb.SYSTEM, passage.text, 2048, false)
      const facts = SessionExtract.parseExtraction(reply, 20).filter(
        (fact): fact is { name: string; text: string } => typeof fact.name === "string" && fact.name.trim() !== "",
      )
      const names = facts.map((fact) => fact.name)
      const factVectors = await embed(facts.map((fact) => fact.text))
      for (const [index, fact] of facts.entries()) {
        const id = KbChunk.entityID(SCOPE, fact.name)
        const vector = factVectors?.[index]
        await engine
          .addMemory({
            id,
            kind: "entity",
            text: fact.text,
            name: fact.name,
            scope: SCOPE,
            source: "ingest",
            relation: "staged",
            ...(vector ? { embedding: vector } : {}),
          })
          .catch(() => undefined)
        await engine
          .addEdge({ from: passage.id, to: id, type: "mentions", scope: SCOPE, source: "ingest" })
          .catch(() => undefined)
        entities++
      }
      absorbed++
      process.stdout.write(`\r  absorbed ${absorbed}/${absorbLimit} passages, ${entities} entity writes  `)
      if (absorbed === 1 && names.length > 0) console.log(`\n  first passage named: ${names.join(" · ")}`)
    }
    process.stdout.write("\n")

    const final = await engine.stats()
    const finalGraph = await engine.graph({ scopes: [SCOPE], limit: SLICE_LIMIT })
    const kinds = new Map<string, number>()
    for (const node of finalGraph.nodes) kinds.set(node.kind, (kinds.get(node.kind) ?? 0) + 1)
    const types = new Map<string, number>()
    for (const edge of finalGraph.edges) types.set(edge.type, (types.get(edge.type) ?? 0) + 1)
    const manifest = {
      document: label,
      source: doc,
      chars: text.length,
      passages: plan.passages.length,
      absorbed,
      dim,
      vectors: vectors !== undefined,
      nodes: final.total,
      sliceNodes: finalGraph.nodes.length,
      sliceEdges: finalGraph.edges.length,
      slice: finalGraph.slice,
      kinds: Object.fromEntries(kinds),
      edgeTypes: Object.fromEntries(types),
      documentID: plan.document.id,
    }
    writeFileSync(join(STORE!, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
    console.log("\n=== BUILT ===")
    console.log(JSON.stringify(manifest, null, 2))
  } finally {
    await engine.close()
  }
}

// ─── inspect ──────────────────────────────────────────────────────────────────────────────────────

const inspect = async () => {
  const manifest = JSON.parse(readFileSync(join(STORE!, "manifest.json"), "utf8")) as { dim: number }
  const engine = await WasmMemory.open(join(STORE!, "graph"), { dim: manifest.dim })
  try {
    const slice = await engine.graph({ scopes: [SCOPE], limit: SLICE_LIMIT })
    const degree = new Map<string, number>()
    for (const edge of slice.edges) {
      degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1)
      degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1)
    }
    const entities = slice.nodes.filter((node) => node.kind === "entity")
    const filter = args.values.entity?.toLowerCase()
    const chosen = entities
      .filter((node) => filter === undefined || (node.name ?? node.text).toLowerCase().includes(filter))
      .map((node) => ({ node, degree: degree.get(node.id) ?? 0 }))
      .sort((a, b) => b.degree - a.degree)
      .slice(0, Number(args.values.limit ?? 40))
    console.log(`· ${slice.nodes.length} nodes / ${slice.edges.length} edges in the slice; ${entities.length} entities`)
    for (const { node, degree: d } of chosen)
      console.log(`  [${d}] ${node.name ?? "(unnamed)"} :: ${node.text.slice(0, 120).replaceAll(/\s+/g, " ")}`)
  } finally {
    await engine.close()
  }
}

// ─── measure ──────────────────────────────────────────────────────────────────────────────────────

/** The question file's shape — the same fields `ablation-eval.ts` scores, keyed by memory ID. */
interface DocQuestion {
  readonly id: string
  readonly kind: KbAblationEval.QuestionKind
  readonly text: string
  readonly gold: readonly string[]
  readonly bridge?: readonly string[]
  readonly answer: string
  readonly wrong?: string
}

const measure = async () => {
  const file = args.values.questions ?? die("--questions <file.json> is required for measure")
  if (args.values.reader && (READER_MODEL === undefined || READER_MODEL === ""))
    die("--reader needs ABLATION_READER_MODEL")
  const manifest = JSON.parse(readFileSync(join(STORE!, "manifest.json"), "utf8")) as Record<string, unknown>
  const questions = JSON.parse(readFileSync(file, "utf8")) as DocQuestion[]
  const engine = await WasmMemory.open(join(STORE!, "graph"), { dim: Number(manifest["dim"]) })
  try {
    const slice = await engine.graph({ scopes: [SCOPE], limit: SLICE_LIMIT })
    /**
     * 🔴 UNDIRECTED, built from `graph()`'s edge list — the same finding `ablation.ts` records, and
     * it is worse on a real document than on the fixture. `WasmMemory.neighbors` matches only
     * `(m)-[r:Rel]->(n)`, and BOTH edge types a document produces point away from their hub:
     * `passage -part_of-> document` and `passage -mentions-> entity`. So on an ingested document
     * every hub — the document itself and every entity — is a SINK, and a `neighbors` hop out of one
     * returns nothing at all. Traversal here measures what a bidirectional leg would buy.
     */
    const adjacency = new Map<string, string[]>()
    for (const edge of slice.edges) {
      adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to])
      adjacency.set(edge.to, [...(adjacency.get(edge.to) ?? []), edge.from])
    }
    const twoHop = (seed: string): string[] => {
      const out: string[] = []
      for (const first of adjacency.get(seed) ?? [])
        for (const second of adjacency.get(first) ?? []) if (second !== seed && !out.includes(second)) out.push(second)
      return out
    }

    // ⚠️ A control on the QUESTIONS, not on the path: a bridge term that appears in the question is
    // answerable by one lexical lookup, and scoring it would credit the graph for work FTS did.
    for (const question of questions) {
      for (const id of question.bridge ?? []) {
        const row = (await engine.byIds([id]))[0]
        const name = row?.name?.toLowerCase()
        if (name && question.text.toLowerCase().includes(name))
          die(`question ${question.id} names its own bridge (${row?.name}) — it is not multi-hop`)
      }
      for (const id of [...question.gold, ...(question.bridge ?? [])])
        if ((await engine.byIds([id])).length === 0) die(`question ${question.id} names a missing memory: ${id}`)
    }

    const keyOfID = new Map(
      [...questions.flatMap((q) => [...q.gold, ...(q.bridge ?? [])])].map((id) => [id, id] as const),
    )
    const conditions = [
      { supersession: true, edges: true },
      { supersession: true, edges: false },
    ]
    const rows: string[] = []
    const readerRows: string[] = []
    for (const condition of conditions) {
      const retrieval: KbAblationEval.RetrievalScore[] = []
      const reader: { id: string; ok: number; wrong: number; empty: number }[] = []
      for (const question of questions) {
        const queryVector = (await embed([question.text]))?.[0]
        const base = await engine.search({
          query: question.text,
          k: K,
          scopes: [SCOPE],
          ...(queryVector ? { embedding: queryVector } : {}),
        })
        const EDGE_SLOTS = 2
        let hits: MemoryClient.SearchHit[] = [...base]
        if (condition.edges) {
          const seen = new Set(base.map((hit) => hit.id))
          const found: MemoryClient.SearchHit[] = []
          for (const seed of base.slice(0, 3))
            for (const second of twoHop(seed.id)) {
              if (seen.has(second) || found.some((row) => row.id === second)) continue
              const row = (await engine.byIds([second]))[0]
              if (row === undefined || row.kind === "entity") continue
              if (KbClaim.isRetired(row.status)) continue
              found.push({ ...row, score: 0 })
            }
          const reserved = found.slice(0, EDGE_SLOTS)
          hits = [...base.slice(0, Math.max(0, K - reserved.length)), ...reserved]
        }
        retrieval.push(
          KbAblationEval.scoreRetrieval(
            { ...question, stale: [] } as KbAblationEval.Question,
            hits,
            keyOfID,
          ),
        )
        if (args.values.reader) {
          const pack = SessionRecall.packRecall(hits, SessionRecall.recallTokenBudget(undefined))
          const block = SessionRecall.formatRecall(pack) ?? "You remember nothing relevant."
          let ok = 0
          let wrong = 0
          let empty = 0
          for (let sample = 0; sample < SAMPLES; sample += 1) {
            const reply = await complete(block, `${question.text}\nAnswer in one short sentence.`, 1024, false)
            if (reply.trim() === "") empty += 1
            const graded = KbAblationEval.gradeAnswer({ ...question, stale: [] } as KbAblationEval.Question, reply)
            if (graded.ok) ok += 1
            if (graded.wrong) wrong += 1
          }
          reader.push({ id: question.id, ok, wrong, empty })
        }
      }
      const name = `edges=${condition.edges ? "on" : "off"}`
      rows.push(
        `${name} | answerable@${K} ${retrieval.filter((row) => row.hit).length}/${retrieval.length} | ` +
          retrieval
            .map(
              (row) =>
                `${row.questionID}:` +
                (row.goldPresent ? `r${row.goldRank}` : "MISS") +
                (row.bridgePresent ? "" : "-nobridge"),
            )
            .join(" "),
      )
      if (args.values.reader)
        readerRows.push(
          `${name} | correct ${reader.reduce((sum, row) => sum + row.ok, 0)}/${reader.length * SAMPLES} | ` +
            `empty ${reader.reduce((sum, row) => sum + row.empty, 0)} | ` +
            reader.map((row) => `${row.id}:${row.ok}/${SAMPLES}`).join(" "),
        )
    }
    console.log(`\n=== ${manifest["document"]} — RETRIEVAL (the store, alone) ===`)
    console.log(
      `corpus: ${manifest["passages"]} passages, ${manifest["absorbed"]} absorbed, ${manifest["nodes"]} nodes, ` +
        `${manifest["sliceEdges"]} edges in the slice`,
    )
    for (const row of rows) console.log(row)
    if (args.values.reader) {
      console.log(`\n=== READER (${READER_MODEL}, n=${SAMPLES}, temperature=${TEMP}) ===`)
      for (const row of readerRows) console.log(row)
    }
  } finally {
    await engine.close()
  }
}


// ─── bridges: the traversal verdict, DERIVED from the document's own structure ────────────────────

/**
 * 🔴 **WHY THE QUESTIONS ARE DERIVED RATHER THAN WRITTEN.**
 *
 * The verdict being re-tested is *"traversal does not earn its place"*, measured where the whole
 * store was 29 hand-built memories. Hand-authoring a fresh set here would replace one small
 * hand-built corpus with another and put the author's idea of a multi-hop question at the centre of
 * the result — and the author knows which arm is on trial.
 *
 * So the set comes from the document. Absorption joined passages to the entities they mention, so a
 * two-hop path already exists in the store: passage A -> entity E -> passage B. A question built from
 * A that never NAMES E is a question whose answer lives in B and which the lexical leg has no direct
 * route to. That is precisely the shape a traversal leg exists for, and a real document has dozens.
 *
 * ⚠️ **The bridge term is stripped MECHANICALLY, and a sentence that still contains it is discarded
 * rather than edited.** A question that names its own bridge is answerable by one lexical lookup, and
 * scoring it would credit the graph for work FTS did.
 *
 * ⚠️ **A hub joined to 200 passages is not a bridge — it is the absence of one.** The document entity
 * connects every passage to every other, so a two-hop through it reaches the whole corpus. Only
 * entities bridging 2-3 passages are used.
 *
 * ⚠️ **The noise floor is EMPIRICAL, not `k / |passages|`.** For every question the same search is
 * scored a second time against a RANDOM passage standing in for the gold. That measures what this
 * retrieval scores by accident on this corpus, which is the only floor worth comparing against — an
 * analytic floor assumes a uniform ranker and this one is anything but.
 */
const bridges = async () => {
  const manifest = JSON.parse(readFileSync(join(STORE!, "manifest.json"), "utf8")) as Record<string, unknown>
  const wanted = Math.max(1, Number(args.values.limit ?? 40))
  const seed = Number(args.values.samples ?? 7)
  const engine = await WasmMemory.open(join(STORE!, "graph"), { dim: Number(manifest["dim"]) })
  try {
    const slice = await engine.graph({ scopes: [SCOPE], limit: SLICE_LIMIT })
    const byID = new Map(slice.nodes.map((node) => [node.id, node] as const))
    const passagesOf = new Map<string, string[]>()
    for (const edge of slice.edges) {
      if (edge.type !== "mentions") continue
      passagesOf.set(edge.to, [...(passagesOf.get(edge.to) ?? []), edge.from])
    }
    const allPassages = slice.nodes.filter((node) => node.kind === "passage").map((node) => node.id)

    /** A deterministic shuffle, so a re-run measures the same set rather than a new one. */
    let state = seed
    const rand = () => ((state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)

    interface Probe {
      readonly query: string
      readonly gold: string
      readonly bridge: string
      readonly from: string
      readonly noise: string
    }
    const probes: Probe[] = []
    const entityIDs = [...passagesOf.keys()].filter((id) => {
      const count = passagesOf.get(id)?.length ?? 0
      return count >= 2 && count <= 3
    })
    const SENTENCE_SPLIT = /(?<=[.!?])\s+/
    for (const entity of entityIDs) {
      if (probes.length >= wanted) break
      const name = (byID.get(entity)?.name ?? "").trim()
      if (name.length < 3) continue
      const [from, gold] = passagesOf.get(entity)!
      if (from === undefined || gold === undefined) continue
      const text = byID.get(from)?.text ?? ""
      const needle = name.toLowerCase()
      const sentence = text
        .split(SENTENCE_SPLIT)
        .map((one) => one.trim())
        .filter((one) => one.length > 40 && one.length < 300 && !one.toLowerCase().includes(needle))
        .sort((a, b) => b.length - a.length)[0]
      if (sentence === undefined) continue
      const noise = allPassages[Math.floor(rand() * allPassages.length)]
      if (noise === undefined || noise === gold) continue
      probes.push({ query: sentence, gold, bridge: entity, from, noise })
    }
    console.log(`· ${probes.length} derived two-hop probes (entities bridging 2-3 passages, bridge term stripped)`)

    const adjacency = new Map<string, string[]>()
    for (const edge of slice.edges) {
      adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.to])
      adjacency.set(edge.to, [...(adjacency.get(edge.to) ?? []), edge.from])
    }
    const twoHop = (seedID: string): string[] => {
      const out: string[] = []
      for (const first of adjacency.get(seedID) ?? [])
        for (const second of adjacency.get(first) ?? []) if (second !== seedID && !out.includes(second)) out.push(second)
      return out
    }

    /**
     * 🔴 **THE SAME WALK, RESTRICTED TO THE DIRECTION `WasmMemory.neighbors` ACTUALLY MATCHES.**
     *
     * `neighbors` matches `(m)-[r:Rel]->(n)` — strictly OUTGOING. Both edge types a document produces
     * point away from their hub (`passage -part_of-> document`, `passage -mentions-> entity`), so on
     * an ingested document every hub is a SINK. This arm answers the open question in the ledger — is
     * the outgoing-only accessor a probe artefact or a product defect? — by counting how many of the
     * SAME probes a walk built on it can complete. It is not an argument; it is the number.
     */
    const outgoing = new Map<string, string[]>()
    for (const edge of slice.edges) outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to])
    const twoHopOutgoing = (seedID: string): string[] => {
      const out: string[] = []
      for (const first of outgoing.get(seedID) ?? [])
        for (const second of outgoing.get(first) ?? []) if (second !== seedID && !out.includes(second)) out.push(second)
      return out
    }

    const score = {
      on: 0,
      off: 0,
      offPassages: 0,
      noiseOn: 0,
      noiseOff: 0,
      bridgeReached: 0,
      hopEmpty: 0,
      outgoingReached: 0,
      outgoingEmpty: 0,
    }
    const ranksOff: number[] = []
    const ranksOn: number[] = []
    const ranksOffPassages: number[] = []
    /** How much of an unrestricted top-k is ENTITY text rather than document passages. */
    let entitySlots = 0
    let totalSlots = 0
    for (const [index, probe] of probes.entries()) {
      const vector = (await embed([probe.query]))?.[0]
      const base = await engine.search({
        query: probe.query,
        k: K,
        scopes: [SCOPE],
        ...(vector ? { embedding: vector } : {}),
      })
      /**
       * 🔴 **THE THIRD ARM, AND IT EXISTS BECAUSE THE FIRST TWO WERE NOT COMPETING FOR THE SAME
       * THING.**
       *
       * The traversal leg is forbidden to spend a reserved slot on an entity — an entity node's text
       * is a one-line gloss, so returning the bridge itself would look busy and answer nothing. But
       * the lexical arm has no such rule, and absorption put ~1000 entity nodes in this store against
       * 204 passages. So an unrestricted `k = 8` can be spent almost entirely on entity glosses, and
       * an edges-off score of zero would then be measuring CROWDING rather than the absence of a hop.
       *
       * This arm gives the lexical leg the same universe the traversal leg draws from — passages only
       * — so the comparison is between two ways of reaching a passage rather than between one that is
       * allowed entities and one that is not. Both numbers are reported: the unrestricted one is what
       * production does today, and the restricted one is the honest head-to-head.
       */
      const basePassages = await engine.search({
        query: probe.query,
        k: K,
        scopes: [SCOPE],
        kinds: ["passage"],
        ...(vector ? { embedding: vector } : {}),
      })
      const passageIDs = basePassages.map((hit) => hit.id)
      if (passageIDs.includes(probe.gold)) {
        score.offPassages += 1
        ranksOffPassages.push(passageIDs.indexOf(probe.gold) + 1)
      }
      const offIDs = base.map((hit) => hit.id)
      entitySlots += base.filter((hit) => hit.kind === "entity").length
      totalSlots += base.length
      if (offIDs.includes(probe.gold)) {
        score.off += 1
        ranksOff.push(offIDs.indexOf(probe.gold) + 1)
      }
      if (offIDs.includes(probe.noise)) score.noiseOff += 1

      // The traversal leg, with the same reserved-slot rule the fixture runner uses: a leg that
      // cannot displace anything is not a leg.
      const EDGE_SLOTS = 2
      const seen = new Set(offIDs)
      const found: string[] = []
      for (const hit of base.slice(0, 3))
        for (const second of twoHop(hit.id)) {
          if (seen.has(second) || found.includes(second)) continue
          const row = byID.get(second)
          if (row === undefined || row.kind === "entity") continue
          found.push(second)
        }
      if (found.includes(probe.gold)) score.bridgeReached += 1
      // What the SHIPPED accessor could have reached, over the same seeds and the same graph.
      const outFound: string[] = []
      for (const hit of base.slice(0, 3))
        for (const second of twoHopOutgoing(hit.id)) {
          if (seen.has(second) || outFound.includes(second)) continue
          const row = byID.get(second)
          if (row === undefined || row.kind === "entity") continue
          outFound.push(second)
        }
      if (outFound.includes(probe.gold)) score.outgoingReached += 1
      if (outFound.length === 0) score.outgoingEmpty += 1
      const reserved = found.slice(0, EDGE_SLOTS)
      const onIDs = [...offIDs.slice(0, Math.max(0, K - reserved.length)), ...reserved]
      if (onIDs.includes(probe.gold)) {
        score.on += 1
        ranksOn.push(onIDs.indexOf(probe.gold) + 1)
      }
      if (onIDs.includes(probe.noise)) score.noiseOn += 1
      if (found.length === 0) score.hopEmpty += 1
      if ((index + 1) % 10 === 0) process.stdout.write(`\r  scored ${index + 1}/${probes.length}`)
    }
    process.stdout.write("\n")

    const pct = (n: number) => `${n}/${probes.length} (${((100 * n) / probes.length).toFixed(0)}%)`
    const median = (xs: number[]) => (xs.length === 0 ? "—" : String(xs.toSorted((a, b) => a - b)[(xs.length - 1) >> 1]))
    console.log(`\n=== ${manifest["document"]} — TRAVERSAL, derived two-hop set (n=${probes.length}, k=${K}) ===`)
    console.log(`corpus: ${manifest["nodes"]} nodes; slice ${manifest["sliceNodes"]} nodes / ${manifest["sliceEdges"]} edges`)
    console.log(`  edges OFF, unrestricted   gold@k ${pct(score.off)}   median rank ${median(ranksOff)}`)
    console.log(`  edges OFF, passages only  gold@k ${pct(score.offPassages)}   median rank ${median(ranksOffPassages)}`)
    console.log(`  edges ON                  gold@k ${pct(score.on)}   median rank ${median(ranksOn)}`)
    console.log(
      `  of an unrestricted top-${K}, ${((100 * entitySlots) / Math.max(1, totalSlots)).toFixed(0)}% of slots were ENTITY glosses`,
    )
    console.log(`  the hop reached the gold at all: ${pct(score.bridgeReached)}`)
    console.log(`  the hop found NOTHING to offer:  ${pct(score.hopEmpty)}`)
    console.log(`  — the same walk restricted to OUTGOING edges, which is what \`neighbors\` matches —`)
    console.log(`    reached the gold: ${pct(score.outgoingReached)}   found nothing at all: ${pct(score.outgoingEmpty)}`)
    console.log(`  NOISE FLOOR (a random passage scored as if it were the gold, same searches):`)
    console.log(`    edges OFF ${pct(score.noiseOff)}   edges ON ${pct(score.noiseOn)}`)
  } finally {
    await engine.close()
  }
}

if (PHASE === "build") await build()
else if (PHASE === "inspect") await inspect()
else if (PHASE === "measure") await measure()
else if (PHASE === "bridges") await bridges()
else die(`unknown phase ${PHASE ?? "(none)"} — expected build | inspect | bridges | measure`)
if (!existsSync(STORE!)) die("store directory vanished")
