export * as KbTool from "./kb"

import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Kb } from "../kb"
import { KbQuery } from "../kb-query"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

// KB-E — the `kb` tool: the model-facing surface of the knowledge base (the KG-Agent shape;
// design notes/kb-query-language.md §4, validated at 96% on the qwen harness). ONE tool, a
// closed six-op vocabulary the model CHAINS; the engine (kb-query.ts) owns label→id
// resolution, joins, and predicate enumeration. A wrong query comes back as readable RESULT
// TEXT with nearest valid alternatives — the model's next call is the repair loop — so
// ToolFailure is reserved for infra faults. Read-only over local data: no permission gate
// (the tool-manual posture).

export const name = "kb"

export const Input = KbQuery.Op

const Output = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.String,
})
type Output = typeof Output.Type

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const kb = yield* Kb.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Query the local knowledge base of (subject, predicate, object) facts. Ops: find (entities by label) · " +
            "get (all facts of one entity) · predicates (the valid predicates on an entity) · neighbors (one hop from " +
            "an entity along a predicate; direction in/out) · count · match (conjunctive patterns with ?variables). " +
            'Always refer to entities by their display NAME — the engine resolves names to ids and follows joins. ' +
            'Example: {"op":"neighbors","entity":"Korvath Dreyne","predicate":"member_of"}. On an error, follow its ' +
            "suggested alternatives and retry.",
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.message }],
          execute: (input) =>
            Effect.gen(function* () {
              // Full active set per call (PoC scale; D3): `backup` is the one uncapped read on the
              // KB-A facade. The size guard is the KB-C hook — at engine scale the ops compile to
              // SPARQL instead of building an in-process index.
              const facts = yield* kb.backup()
              const active = facts.filter((fact) => fact.validTo === undefined)
              if (active.length > KbQuery.MAX_FACTS)
                return {
                  ok: false,
                  message: `The KB holds ${active.length} active facts — too many for in-process matching. A narrower op cannot help; this KB needs the external query engine.`,
                } satisfies Output
              const index = KbQuery.buildIndex(active.map((fact) => ({ s: fact.subject, p: fact.predicate, o: fact.object })))
              const result = KbQuery.exec(index, input)
              if (!result.ok) return { ok: false, message: result.error } satisfies Output
              return {
                ok: true,
                message: result.lines.length ? result.lines.join("\n") : "No results.",
              } satisfies Output
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/kb",
  layer,
  deps: [ToolRegistry.node, Kb.node],
})
