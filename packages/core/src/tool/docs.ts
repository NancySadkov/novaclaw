export * as DocsTool from "./docs"

import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { DocsIndex } from "./docs-index"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

/**
 * The `docs` tool — the shipped NovaClaw manual, reachable by the agent (v0.2.0 batch plan 4.2).
 *
 * **Why ONE tool with a closed op vocab, and not three tools.** Tool-count pressure is a live
 * constraint (degradation is reported from 30–50 tools and we are already past
 * it), so a docs surface that costs three schema slots would be paying the tax this repo is trying to
 * stop paying. The house answer is `kb`'s: one agentic tool, a small closed op set the model CHAINS,
 * with the engine owning resolution. `list` → `read` → `search` is that same shape, and every op's
 * output is a legal input to the next one (a topic name from `list`, a heading from `list topic`, a
 * topic+heading from `search`).
 *
 * **Why it is RESIDENT and not `withDeferred`.** The item's whole design is *names in the prompt,
 * pages on demand*. A deferred tool has no prompt presence at all, so the topic names would vanish
 * with it and the manual would only be reachable by a model that already guessed it exists. The
 * names ARE the index, so they are what the prompt pays for — and nothing else is. Measured cost of
 * that half: see `docs.test.ts`'s prompt-budget guard, which fails if a page body ever leaks into
 * the description.
 *
 * **No permission gate.** This is read-only text we ship inside the binary; there is nothing to
 * authorize, exactly as `tool_manual` reasons about recipe manuals. It reads no user file, no store
 * and no network.
 *
 * ⚠️ **The manual is the same text for the human and for the agent, deliberately.** AGENTS.md's
 * mission says the product teaches as it works and meets each user at their expertise level — which
 * a *split* manual actively defeats: an agent explaining a page the user cannot open, or a user
 * reading a page the agent has never seen, is the "two sources that disagree" defect aimed at the
 * user instead of at us. Meeting someone at their level is a RENDERING act (the assistant explains
 * this page in their terms, at their depth), not a second corpus. So: one text, and the level
 * adaptation is the conversation.
 */
export const name = "docs"

const ListOp = Schema.Struct({
  op: Schema.Literal("list"),
  topic: Schema.optional(Schema.String).annotate({
    description: "Optional topic name: lists that page's sections instead of the topic list",
  }),
})

const ReadOp = Schema.Struct({
  op: Schema.Literal("read"),
  topic: Schema.String.annotate({ description: "A topic name from the list in this tool's description" }),
  section: Schema.optional(Schema.String).annotate({
    description: "Optional section heading from `list`: returns just that section",
  }),
})

const SearchOp = Schema.Struct({
  op: Schema.Literal("search"),
  query: Schema.String.annotate({ description: "Words to find across all pages; returns matching lines" }),
  k: Schema.optional(Schema.Finite).annotate({ description: "Max results (default 10)" }),
})

export const Input = Schema.Union([ListOp, ReadOp, SearchOp])

export const Output = Schema.Struct({
  ok: Schema.Boolean,
  message: Schema.String,
})
export type Output = typeof Output.Type

export const DEFAULT_SEARCH_LIMIT = 10
const MAX_SEARCH_LIMIT = 30

/**
 * The prompt-visible half, and the ONLY part of the manual that costs tokens every turn.
 *
 * Every line after the preamble is `<topic> — <that page's own second line>`; nothing here is typed
 * by hand, so this string cannot disagree with the pages. Keeping page BODIES out of it is the
 * item's entire economic claim, and `docs.test.ts` asserts it mechanically rather than trusting this
 * comment.
 */
export const description = [
  "The shipped NovaClaw manual — the same pages the user reads. Use it instead of guessing whenever",
  "you need to know how NovaClaw itself works, or to explain it: settings, models, permissions,",
  "sessions, recipes, where something lives, what to check when something breaks.",
  "Ops: {op:'read',topic,section?} · {op:'list',topic?} · {op:'search',query}. Topics:",
  ...DocsIndex.promptLines(),
].join("\n")

const renderTopics = () =>
  ["NovaClaw manual — topics (read one with {op:'read',topic:'<name>'}):", ...DocsIndex.promptLines()].join("\n")

const unknownTopic = (topic: string) =>
  new ToolFailure({
    message: `No manual topic named "${topic}". Topics: ${DocsIndex.topics.join(", ")}`,
  })

export const run = (input: typeof Input.Type): Output | ToolFailure => {
  switch (input.op) {
    case "list": {
      if (input.topic === undefined || input.topic.trim() === "") return { ok: true, message: renderTopics() }
      const page = DocsIndex.find(input.topic)
      if (!page) return unknownTopic(input.topic)
      const headings = DocsIndex.sectionLines(page)
      return {
        ok: true,
        message: [
          `${page.topic} — ${page.description}`,
          ...(headings.length === 0
            ? ["(no sections — read the whole page)"]
            : ["Sections (read one with {op:'read',topic,section}):", ...headings.map((heading) => `- ${heading}`)]),
        ].join("\n"),
      }
    }
    case "read": {
      const page = DocsIndex.find(input.topic)
      if (!page) return unknownTopic(input.topic)
      if (input.section === undefined || input.section.trim() === "") return { ok: true, message: page.text.trimEnd() }
      const wanted = input.section.trim().toLowerCase()
      const section = page.sections.find((candidate) => candidate.heading.toLowerCase() === wanted)
      if (!section) {
        // Repair text, not a failure: a wrong section is one step from a right one, and the model's
        // next call IS the repair loop (the measured `kb` rule). The whole page is never wrong.
        const headings = DocsIndex.sectionLines(page)
        return {
          ok: false,
          message: [
            `"${input.section}" is not a section of ${page.topic}.`,
            ...(headings.length === 0 ? [] : [`Sections: ${headings.join(" · ")}`]),
            `Read the whole page with {op:'read',topic:'${page.topic}'}.`,
          ].join("\n"),
        }
      }
      return { ok: true, message: `# ${page.title} → ${section.heading}\n\n${section.text}` }
    }
    case "search": {
      const requested = input.k === undefined ? DEFAULT_SEARCH_LIMIT : Math.floor(input.k)
      const limit = Math.max(1, Math.min(MAX_SEARCH_LIMIT, Number.isFinite(requested) ? requested : DEFAULT_SEARCH_LIMIT))
      const hits = DocsIndex.search(input.query, limit)
      if (hits.length === 0) {
        return {
          ok: false,
          message: [
            `Nothing in the manual matches "${input.query}".`,
            `Topics: ${DocsIndex.topics.join(", ")} — read one with {op:'read',topic:'<name>'}.`,
          ].join("\n"),
        }
      }
      return {
        ok: true,
        message: hits
          .map((hit) => `${hit.topic}${hit.heading === undefined ? "" : ` › ${hit.heading}`} · ${hit.line}`)
          .join("\n"),
      }
    }
  }
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.message }],
          execute: (input) => {
            const result = run(input)
            return result instanceof ToolFailure ? Effect.fail(result) : Effect.succeed(result)
          },
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({ name: "tool/docs", layer, deps: [ToolRegistry.node] })
