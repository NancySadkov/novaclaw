export * as KbEmbedder from "./embedder"

import { Context, Effect, Layer, Schema } from "effect"

// KB-V P2 — the embedding device client (notes/kb-vector-plan.md §5): one POST to an
// OpenAI-compatible /embeddings endpoint per batch. Deliberately dumb: no retries here (the
// drain loop owns retry-on-next-pass semantics via embed_status), no config reads (the wiring
// layer resolves `kb.embedding` and builds this) — so tests inject a stub and the drain logic
// stays runtime-independent.

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

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/KbEmbedder") {}

export const DEFAULT_DIMS = 1024

/** Test/embedding seam: a deterministic in-process embedder. */
export const layerStub = (
  fn: (text: string) => ReadonlyArray<number>,
  info: Info = { model: "stub", dims: DEFAULT_DIMS },
): Layer.Layer<Service> =>
  Layer.succeed(
    Service,
    Service.of({
      info,
      embed: (texts) => Effect.succeed(texts.map(fn)),
    }),
  )

/**
 * The HTTP client for a live endpoint. `url` is the OpenAI-compatible BASE (…/v1); the request
 * budget is generous because a pooling vLLM's first call after boot compiles warmup graphs
 * (measured >15 s on the Spark — the P0 ledger trap).
 */
export const layerHttp = (options: {
  url: string
  model: string
  dims?: number
  timeoutMs?: number
}): Layer.Layer<Service> => {
  const info: Info = { model: options.model, dims: options.dims ?? DEFAULT_DIMS }
  return Layer.succeed(
    Service,
    Service.of({
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
    }),
  )
}
