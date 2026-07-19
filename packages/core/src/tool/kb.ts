export * as KbTool from "./kb"

import { ascending } from "@novaclaw/schema/identifier"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { MemoryClient } from "../kb-graph/memory-client"
import { Memory } from "../kb-graph/memory"
import { MemorySetting } from "../kb-graph/memory-setting"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

// The `kb` tool — the model-facing surface of the graph MEMORY tier (notes/kb-graph-plan.md §3; the
// KB is now the Ladybug in-process graph, not the KB-V doc store). ONE tool, a closed op vocab the
// model CHAINS: `search` (find memories) → `neighbors` (what's linked) plus the deliberate writes
// `remember` / `forget`. The measured KB-E/KB-V rules carry over: results are LINEARIZED text lines,
// never nested JSON; a fruitless query settles as readable repair text (the model's next call IS the
// repair loop); ToolFailure stays reserved for infra faults. Two SCOPES: `session:<id>` (this chat)
// and `global` (durable, cross-chat). Memory disabled/unavailable → the ops degrade to repair text,
// never a hard failure.

export const name = "kb"

const SearchOp = Schema.Struct({
  op: Schema.Literal("search"),
  query: Schema.String.annotate({ description: "Free-text query; matches remembered facts by keyword" }),
  k: Schema.Finite.pipe(Schema.optional).annotate({ description: "Max results (default 8)" }),
  scope: Schema.Literals(["session", "global", "all"])
    .pipe(Schema.optional)
    .annotate({ description: "session = this chat only · global = durable cross-chat · all (default)" }),
})

const RememberOp = Schema.Struct({
  op: Schema.Literal("remember"),
  text: Schema.String.annotate({ description: "The fact to remember, as one clear standalone sentence" }),
  name: Schema.String.pipe(Schema.optional).annotate({ description: "Short subject/label (e.g. the person or thing it's about)" }),
  scope: Schema.Literals(["session", "global"])
    .pipe(Schema.optional)
    .annotate({ description: "global (default) = remember durably across all chats · session = only this chat" }),
})

const ForgetOp = Schema.Struct({
  op: Schema.Literal("forget"),
  id: Schema.String.annotate({ description: "A memory id from search results (mem_…)" }),
  secret: Schema.Boolean.pipe(Schema.optional).annotate({
    description: "true = hard-delete with no history (for secrets/credentials); default keeps it in history",
  }),
})

const NeighborsOp = Schema.Struct({
  op: Schema.Literal("neighbors"),
  id: Schema.String.annotate({ description: "A memory id (mem_…) whose directly-linked memories to list" }),
  k: Schema.Finite.pipe(Schema.optional).annotate({ description: "Max results (default 10)" }),
})

export const Input = Schema.Union([SearchOp, RememberOp, ForgetOp, NeighborsOp])

const Output = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.String,
})
type Output = typeof Output.Type

// --- linearized rendering (pure; unit-tested) --------------------------------------------------

const oneLine = (text: string) => text.replaceAll(/\s+/g, " ").trim()

export const formatHits = (hits: ReadonlyArray<MemoryClient.SearchHit>): string =>
  hits
    .map((hit) => {
      const provenance = [hit.relation, hit.source].filter(Boolean).join("/")
      const label = hit.name ? `${hit.name}: ` : ""
      return `${hit.id} · ${label}${oneLine(hit.text)}${provenance ? ` · ${provenance}` : ""}`
    })
    .join("\n")

export const formatNeighbors = (rows: ReadonlyArray<MemoryClient.Neighbor>): string =>
  rows.map((row) => `${row.id} · [${row.type}] ${oneLine(row.text)}`).join("\n")

export const searchRepair = (query: string): string =>
  `No memories match "${query}". Try different or fewer words, or {"op":"remember","text":"…"} to save it.`

// -----------------------------------------------------------------------------------------------

const scopesForSearch = (session: string, scope: "session" | "global" | "all" | undefined): string[] =>
  scope === "session" ? [session] : scope === "global" ? ["global"] : [session, "global"]

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const memory = yield* MemoryClient.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "The agent's long-term memory. Ops: search (find things you've remembered, by keyword) · " +
            "remember (save a fact so you recall it later — default durably across all chats) · forget " +
            "(drop a memory by id) · neighbors (memories linked to one you found). Chain them: search " +
            'first, remember what matters. Example: {"op":"remember","text":"The user prefers TypeScript strict mode"}.',
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.message }],
          execute: (input, context) =>
            Effect.gen(function* () {
              // The user's Memory switch (Settings → Memory) is OFF → the tool stands down entirely:
              // no recall AND no writing, so "memory off" is honest for the agent too.
              if (!MemorySetting.memoryEnabled())
                return { ok: false, message: "Long-term memory is turned off in Settings, so I can't recall or save memories right now." } satisfies Output
              const sessionScope = `session:${context.sessionID}`
              switch (input.op) {
                case "search": {
                  const hits = yield* memory
                    .search({ query: input.query, k: input.k ?? 8, scopes: scopesForSearch(sessionScope, input.scope) })
                    .pipe(Effect.orElseSucceed(() => []))
                  if (hits.length === 0) return { ok: false, message: searchRepair(input.query) } satisfies Output
                  return { ok: true, message: formatHits(hits) } satisfies Output
                }
                case "remember": {
                  const id = "mem_" + ascending()
                  const scope = input.scope === "session" ? sessionScope : "global"
                  return yield* memory
                    .addMemory({
                      id,
                      kind: "entity",
                      text: input.text,
                      ...(input.name === undefined ? {} : { name: input.name }),
                      scope,
                      relation: "staged",
                    })
                    .pipe(
                      Effect.as({
                        ok: true,
                        message: `Remembered (${id})${input.scope === "session" ? " — this chat only" : ""}.`,
                      } satisfies Output),
                      Effect.catch((error) =>
                        Effect.succeed({ ok: false, message: `Couldn't save that memory right now (${error.reason}).` } satisfies Output),
                      ),
                    )
                }
                case "forget": {
                  return yield* (input.secret ? memory.purge(input.id) : memory.invalidate(input.id)).pipe(
                    Effect.as({
                      ok: true,
                      message: input.secret
                        ? `Purged "${input.id}" — no history kept.`
                        : `Forgot "${input.id}" (kept in history; it won't surface in search).`,
                    } satisfies Output),
                    Effect.catch((error) =>
                      Effect.succeed({ ok: false, message: `Couldn't forget "${input.id}" (${error.reason}).` } satisfies Output),
                    ),
                  )
                }
                case "neighbors": {
                  const rows = yield* memory
                    .neighbors(input.id, { k: input.k ?? 10 })
                    .pipe(Effect.orElseSucceed(() => []))
                  if (rows.length === 0)
                    return {
                      ok: false,
                      message: `No memories linked to "${input.id}". Ids come from search results (mem_…).`,
                    } satisfies Output
                  return { ok: true, message: formatNeighbors(rows) } satisfies Output
                }
              }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/kb",
  layer,
  deps: [ToolRegistry.node, Memory.node],
})
