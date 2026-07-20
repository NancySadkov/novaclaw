import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { KbEmbedder } from "@novaclaw/core/kb-graph/embedder"
import { MemorySetting } from "@novaclaw/core/kb-graph/memory-setting"
import { WasmMemory } from "@novaclaw/core/kb-graph/wasm-engine"

// LIVE: the memory VECTOR leg end to end against the real LAN embedding device (Qwen3-Embedding on the
// Spark) and the real WASM graph engine. Proves what the product wiring depends on:
//   1. KbEmbedder reads its device from the SETTINGS store and returns real vectors.
//   2. The vector leg retrieves what keyword search STRUCTURALLY CANNOT — a query sharing no content
//      words with the stored fact ("which coding tongue does he prefer" vs "favourite programming
//      language is Rust"). FTS must miss it; hybrid must find it. That gap IS the measured 85% vs 77%.
//   3. It DEGRADES rather than failing when the device is unconfigured.
// Run:  bun test ./test/kb-embedding-live.smoke.ts
// (The settings db is a scratch file passed EXPLICITLY — the hermetic test preload pins NOVACLAW_DB to
// ":memory:", so the ambient DatabasePath can't be used here.)

const EMBED_URL = process.env.EMBED_URL ?? "http://192.168.178.40:8001/v1"
const EMBED_MODEL = process.env.EMBED_MODEL ?? "qwen3-embedding"
const DB = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kb-embed-settings-")), "novaclaw.db")

const FACT = "The user's favourite programming language is Rust"
const DISTRACTOR = "Dorothy's shoes in the book were made of silver"
// Deliberately shares NO content word with FACT: coding≠programming, tongue≠language, prefer≠favourite.
const SEMANTIC_QUERY = "which coding tongue does he prefer"

const writeSettings = (embedding: boolean) => {
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite")
  fs.rmSync(DB, { force: true })
  const db = new Database(DB)
  db.run("CREATE TABLE runtime_setting (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
  db.run("INSERT INTO runtime_setting (key, value) VALUES ('memory', ?)", [
    JSON.stringify(embedding ? { enabled: true, embedding: { url: EMBED_URL, model: EMBED_MODEL } } : { enabled: true }),
  ])
  db.close()
  MemorySetting.bust()
}

let dir: string
let mem: WasmMemory
let dim = 0

beforeAll(async () => {
  writeSettings(true)
  const probe = await KbEmbedder.embedOne("dimension probe", DB)
  if (!probe) throw new Error(`embedding device unreachable at ${EMBED_URL}`)
  dim = probe.length
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kb-embed-live-"))
  mem = await WasmMemory.open(path.join(dir, "graph"), { dim })
  for (const text of [FACT, DISTRACTOR]) {
    const vector = await KbEmbedder.embedOne(text, DB)
    await mem.addMemory({
      id: `m_${text.slice(0, 12).replace(/\W/g, "")}`,
      kind: "entity",
      text,
      scope: "global",
      relation: "core",
      ...(vector ? { embedding: vector } : {}),
    })
  }
}, 120_000)

afterAll(async () => {
  await mem?.close()
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
})

describe("memory vector leg (live)", () => {
  test("reads the device from settings and returns real vectors", () => {
    expect(MemorySetting.embeddingSettings(DB)).toEqual({ url: EMBED_URL.replace(/\/+$/, ""), model: EMBED_MODEL })
    expect(dim).toBeGreaterThan(0)
  })

  test("THE POINT — a keyword-disjoint query: FTS misses, the vector leg finds it", async () => {
    const keywordOnly = await mem.search({ query: SEMANTIC_QUERY, k: 3 })
    const queryVector = await KbEmbedder.embedOne(SEMANTIC_QUERY, DB)
    expect(queryVector).toBeDefined()
    const hybrid = await mem.search({ query: SEMANTIC_QUERY, embedding: queryVector!, k: 3 })

    const foundFact = (hits: ReadonlyArray<{ text: string }>) => hits.some((h) => h.text === FACT)
    // Keyword search cannot bridge coding→programming / tongue→language.
    expect(foundFact(keywordOnly)).toBe(false)
    // The vector leg can — this gap is the whole reason the leg exists.
    expect(foundFact(hybrid)).toBe(true)
  }, 60_000)

  test("degrades to keyword-only when no device is configured (never throws)", async () => {
    writeSettings(false)
    expect(MemorySetting.embeddingSettings(DB)).toBeUndefined()
    expect(await KbEmbedder.embedOne("anything", DB)).toBeUndefined()
    expect(await KbEmbedder.embed(["a", "b"], DB)).toBeUndefined()
    writeSettings(true)
  }, 30_000)
})
