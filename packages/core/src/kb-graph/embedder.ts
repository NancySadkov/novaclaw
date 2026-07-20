export * as KbEmbedder from "./embedder"

import { MemorySetting } from "./memory-setting"

// The memory VECTOR leg — a minimal OpenAI-compatible embeddings client for the LAN embedding device
// (Qwen3-Embedding-0.6B on the Spark). MEASURED (notes/kb-graph-plan.md P7d, same corpus + questions):
// hybrid vector+FTS retrieval 85% vs keyword-only 77%, and OBSCURE 86% → 100% — which is why this
// exists. Retrieval is the whole ballgame: RAG answer-correctness tracked retrieval hit-rate EXACTLY
// across three runs, so recall converts 1:1.
//
// NON-NEGOTIABLE: this NEVER fails a caller. Unconfigured device, unreachable host, timeout, or a
// malformed reply all return `undefined`, and every call site falls back to keyword-only (FTS) search.
// Memory degrading to "slightly worse recall" is correct; memory breaking a turn is not.
//
// Cost note (measured): embedding is ~0.2s/item, so it must stay OFF the turn hot-path for BULK work —
// a single query embedding is fine, bulk backfill belongs on a background drain.

/** Split into request-sized batches (pure; the device rejects unbounded inputs). */
export function batches<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += Math.max(1, size)) out.push(items.slice(i, i + Math.max(1, size)))
  return out
}

/** Decode an OpenAI-compatible embeddings reply into index-ordered vectors (pure). Returns undefined
 *  when the shape isn't what we expect — a malformed reply must degrade, not throw. */
export function parseEmbeddings(body: unknown, expected: number): number[][] | undefined {
  const data = (body as { data?: unknown })?.data
  if (!Array.isArray(data) || data.length !== expected) return undefined
  const rows: { index: number; embedding: number[] }[] = []
  for (const entry of data) {
    const e = entry as { embedding?: unknown; index?: unknown }
    if (!Array.isArray(e.embedding) || e.embedding.length === 0) return undefined
    if (!e.embedding.every((n) => typeof n === "number" && Number.isFinite(n))) return undefined
    rows.push({ index: typeof e.index === "number" ? e.index : rows.length, embedding: e.embedding as number[] })
  }
  return rows.sort((a, b) => a.index - b.index).map((r) => r.embedding)
}

const BATCH = 32
const TIMEOUT_MS = 15_000

/** Embed texts with the configured device. `undefined` = no vector leg available (caller uses FTS).
 *  `dbFile` is the same settings-db override `MemorySetting.memoryEnabled` takes — tests point it at a
 *  scratch db (the hermetic test preload pins NOVACLAW_DB to ":memory:"); production passes nothing. */
export async function embed(texts: readonly string[], dbFile?: string): Promise<number[][] | undefined> {
  if (texts.length === 0) return []
  const settings = MemorySetting.embeddingSettings(dbFile)
  if (settings === undefined) return undefined
  const out: number[][] = []
  for (const batch of batches(texts, BATCH)) {
    const vectors = await requestBatch(settings, batch)
    if (vectors === undefined) return undefined // partial vectors would silently corrupt the index
    out.push(...vectors)
  }
  return out
}

/** Embed one text (the common case: a search query, or one remembered fact). */
export async function embedOne(text: string, dbFile?: string): Promise<number[] | undefined> {
  const vectors = await embed([text], dbFile)
  return vectors?.[0]
}

async function requestBatch(settings: MemorySetting.EmbeddingSettings, batch: readonly string[]): Promise<number[][] | undefined> {
  try {
    const response = await fetch(`${settings.url}/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: settings.model, input: batch }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!response.ok) return undefined
    return parseEmbeddings(await response.json(), batch.length)
  } catch {
    return undefined // unreachable / timeout / bad JSON → degrade to keyword-only
  }
}
