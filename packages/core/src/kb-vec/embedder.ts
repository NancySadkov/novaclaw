export * as KbEmbedder from "./embedder"

import { Effect, Schema } from "effect"

// KB-V P2 — the embedding device client (notes/kb-vector-plan.md §5): one POST to an
// OpenAI-compatible /embeddings endpoint per batch. Deliberately dumb: no retries here (the
// drain loop owns retry-on-next-pass semantics via embed_status), no config reads (the KB tool
// layer resolves `kb.embedding` from location config and passes an Interface into KbDocs calls)
// — so tests inject a stub and the store logic stays runtime-independent.

export class EmbedError extends Schema.TaggedErrorClass<EmbedError>()("KbEmbedder.EmbedError", {
  reason: Schema.String,
}) {}

export interface Info {
  readonly model: string
  readonly dims: number
}

export interface Interface {
  readonly info: Info
  readonly embed: (texts: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<ReadonlyArray<number>>, EmbedError>
}

export const DEFAULT_DIMS = 1024

/** Test/embedding seam: a deterministic in-process embedder. */
export const stub = (fn: (text: string) => ReadonlyArray<number>, info: Info = { model: "stub", dims: DEFAULT_DIMS }): Interface => ({
  info,
  embed: (texts) => Effect.succeed(texts.map(fn)),
})

/**
 * The HTTP client for a live endpoint. `url` is the OpenAI-compatible BASE (…/v1); the request
 * budget is generous because a pooling vLLM's first call after boot compiles warmup graphs
 * (measured >15 s on the Spark — the P0 ledger trap).
 */
export const make = (options: { url: string; model: string; dims?: number; timeoutMs?: number }): Interface => {
  const info: Info = { model: options.model, dims: options.dims ?? DEFAULT_DIMS }
  return {
    info,
    embed: (texts) =>
      Effect.tryPromise({
        try: async () => {
          const response = await fetch(`${options.url.replace(/\/+$/, "")}/embeddings`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: options.model, input: texts }),
            signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const body = (await response.json()) as {
            data?: Array<{ index?: number; embedding?: unknown }>
          }
          const rows = Array.isArray(body.data) ? body.data : []
          const vectors = rows
            .map((row, at) => ({ index: typeof row.index === "number" ? row.index : at, embedding: row.embedding }))
            .sort((a, b) => a.index - b.index)
            .map((row) => row.embedding)
          if (vectors.length !== texts.length || vectors.some((vector) => !Array.isArray(vector)))
            throw new Error(`Malformed embeddings response: ${vectors.length}/${texts.length} vectors`)
          return vectors as ReadonlyArray<ReadonlyArray<number>>
        },
        catch: (cause) => new EmbedError({ reason: String(cause).slice(0, 300) }),
      }),
  }
}

/** Resolve the configured embedding device from a config object, if any. */
export const fromConfig = (config: {
  kb?: { embedding?: { url?: string; model?: string; dims?: number } }
}): Interface | undefined => {
  const embedding = config.kb?.embedding
  if (embedding?.url === undefined || embedding.url.length === 0) return undefined
  return make({
    url: embedding.url,
    model: embedding.model ?? "qwen3-embedding",
    ...(embedding.dims === undefined ? {} : { dims: embedding.dims }),
  })
}
