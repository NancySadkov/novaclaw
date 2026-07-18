export * as KbTool from "./kb"

import { Duration, Effect, Layer, Schedule, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Config } from "../config"
import { KbDocs } from "../kb-docs"
import { KbEmbedder } from "../kb-vec/embedder"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

// KB-V P3 — the `kb` tool: the model-facing surface of the DOCUMENT knowledge base
// (notes/kb-vector-plan.md §4; supersedes the KB-E six-op triple vocabulary). ONE tool, a
// closed four-op vocabulary the model CHAINS: `search` (hybrid keyword+semantic) → `get` (full
// document) → `related` (neighbors) → `sources` (what's in here). The measured KB-E design
// rules carry over verbatim: results are LINEARIZED text lines, never nested JSON; a fruitless
// query settles as readable repair text (the model's next call IS the repair loop) — ToolFailure
// stays reserved for infra faults. Read-only over local data: no permission gate.

export const name = "kb"

const SearchOp = Schema.Struct({
  op: Schema.Literal("search"),
  query: Schema.String.annotate({ description: "Free-text query; both keywords and meaning match" }),
  k: Schema.Finite.pipe(Schema.optional).annotate({ description: "Max results (default 8)" }),
  scope: Schema.Literals(["core", "staged", "all"])
    .pipe(Schema.optional)
    .annotate({ description: "core = curated only · staged = agent-written only · all (default)" }),
})

const GetOp = Schema.Struct({
  op: Schema.Literal("get"),
  doc: Schema.String.annotate({ description: "A document id from search results (doc_…)" }),
})

const RelatedOp = Schema.Struct({
  op: Schema.Literal("related"),
  doc: Schema.String.annotate({ description: "A document id from search results (doc_…)" }),
  k: Schema.Finite.pipe(Schema.optional).annotate({ description: "Max results (default 5)" }),
})

const SourcesOp = Schema.Struct({
  op: Schema.Literal("sources"),
})

export const Input = Schema.Union([SearchOp, GetOp, RelatedOp, SourcesOp])

const Output = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.String,
})
type Output = typeof Output.Type

// --- linearized rendering (pure; unit-tested) --------------------------------------------------

export const formatHits = (hits: ReadonlyArray<KbDocs.SearchHit>): string =>
  hits
    .map((hit) => {
      const provenance = [hit.relation, hit.source, hit.agent].filter(Boolean).join("/")
      const snippet = hit.snippet.replaceAll(/\s+/g, " ").trim()
      return `${hit.docID} · ${hit.title} · ${snippet} · ${provenance}`
    })
    .join("\n")

export const searchRepair = (query: string, vector: boolean): string =>
  `No matches for "${query}".` +
  (vector ? "" : " (Semantic search was unavailable — only exact keywords were tried.)") +
  ` Try different or fewer words, or {"op":"sources"} to see what this KB covers.`

export const formatDoc = (doc: KbDocs.Doc): string => {
  const provenance = [
    `id: ${doc.id}`,
    `relation: ${doc.relation}`,
    ...(doc.source !== undefined ? [`source: ${doc.source}`] : []),
    ...(doc.agent !== undefined ? [`agent: ${doc.agent}`] : []),
    ...(doc.confidence !== undefined ? [`confidence: ${doc.confidence}`] : []),
    ...(doc.validTo !== undefined ? [`RETRACTED${doc.supersededBy ? ` · superseded by ${doc.supersededBy}` : ""}`] : []),
  ].join(" · ")
  return `${doc.title}\n${provenance}\n\n${doc.text}`
}

export const formatSources = (rows: ReadonlyArray<KbDocs.SourceCount>): string =>
  rows.length === 0
    ? "The KB is empty."
    : rows
        .map((row) => `${row.source ?? row.agent ?? "(unattributed)"} · ${row.relation} · ${row.docs} docs`)
        .join("\n")

// -----------------------------------------------------------------------------------------------

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const kb = yield* KbDocs.Service
    const config = yield* Config.Service
    // The embedding device rides location config (boot-frozen like model options — restart the
    // serve after changing kb.embedding). No device = keyword-only search, fully functional.
    const entries = yield* config.entries()
    const embedder = KbEmbedder.fromConfig({ kb: Config.latest(entries, "kb") })

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Search the local knowledge base of documents. Ops: search (find documents by keywords OR meaning; " +
            "returns doc ids + snippets) · get (read one full document by id) · related (documents similar to one " +
            "you found) · sources (what this KB contains, by origin). Chain them: search first, then get the " +
            'promising ids. Example: {"op":"search","query":"how sessions spawn children"}. If results look thin, ' +
            "retry search with different words.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.message }],
          execute: (input) =>
            Effect.gen(function* () {
              switch (input.op) {
                case "search": {
                  const result = yield* kb.search({
                    query: input.query,
                    ...(input.k === undefined ? {} : { k: input.k }),
                    ...(input.scope === undefined ? {} : { scope: input.scope }),
                    ...(embedder === undefined ? {} : { embedder }),
                  })
                  if (result.hits.length === 0)
                    return { ok: false, message: searchRepair(input.query, result.vector) } satisfies Output
                  return { ok: true, message: formatHits(result.hits) } satisfies Output
                }
                case "get": {
                  const doc = yield* kb.get(input.doc)
                  if (doc === undefined)
                    return {
                      ok: false,
                      message: `No document "${input.doc}". Ids come from search results and look like doc_… — run {"op":"search"} first.`,
                    } satisfies Output
                  return { ok: true, message: formatDoc(doc) } satisfies Output
                }
                case "related": {
                  const result = yield* kb
                    .related({
                      doc: input.doc,
                      ...(input.k === undefined ? {} : { k: input.k }),
                      ...(embedder === undefined ? {} : { embedder }),
                    })
                    .pipe(Effect.catchTag("KbDocs.NotFoundError", () => Effect.succeed(undefined)))
                  if (result === undefined)
                    return {
                      ok: false,
                      message: `No active document "${input.doc}". Ids come from search results (doc_…).`,
                    } satisfies Output
                  if (result.hits.length === 0)
                    return { ok: false, message: "No related documents found." } satisfies Output
                  return { ok: true, message: formatHits(result.hits) } satisfies Output
                }
                case "sources": {
                  return { ok: true, message: formatSources(yield* kb.sources()) } satisfies Output
                }
              }
            }),
        }),
      })
      .pipe(Effect.orDie)

    // The background embedding drain: pending/failed chunks pick up vectors whenever the device
    // is reachable — ingestion never waits on it, search improves as it lands. Quiet on failure
    // (the next tick retries); only runs where an embedding device is configured.
    if (embedder !== undefined) {
      yield* kb
        .drainEmbeddings({ embedder })
        .pipe(
          Effect.catchCause(() => Effect.void),
          Effect.repeat(Schedule.spaced(Duration.seconds(60))),
          Effect.forkScoped,
        )
    }
  }),
)

export const node = makeLocationNode({
  name: "tool/kb",
  layer,
  deps: [ToolRegistry.node, KbDocs.node, Config.node],
})
