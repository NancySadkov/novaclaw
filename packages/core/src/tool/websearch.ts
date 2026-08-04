export * as WebSearchTool from "./websearch"

import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { PositiveInt } from "../schema"
import { SessionOrigin } from "../session/origin"
import { WebSearch } from "../websearch/service"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { ToolRegistry } from "./registry"

// The `websearch` tool — one door, whatever is behind it (todo.md → "Web search: a built-in
// fallback so it just works for lay users").
//
// ⚠️ This REPLACED an inherited implementation that called the Exa and Parallel product backends
// with API keys. It contradicted the product on three counts: a paid API, a branded provider
// sitting in the kernel, and — worst for the person actually using NovaClaw — a fresh instance had
// NO working search while the tool's own description promised one. The engine now lives in
// core/websearch: the user's own SearXNG when they have one, an in-process metasearch over free
// engines when they don't, and a refusal that says why in offline/airgap mode.
//
// The input stays deliberately small. The old surface exposed livecrawl / type /
// contextMaxCharacters — vendor knobs a model had to guess at, which is the harness's job to
// decide, not the model's.

export const name = "websearch"

export const MAX_NUM_RESULTS = 20

export const Input = Schema.Struct({
  query: Schema.String.annotate({ description: "What to search the web for" }),
  numResults: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(MAX_NUM_RESULTS))).annotate({
    description: `How many results to return (default 8, maximum ${MAX_NUM_RESULTS})`,
  }),
})

const Output = Schema.Struct({ ok: Schema.Boolean, message: Schema.String })
type Output = typeof Output.Type

/**
 * Linearized results — one block per hit, the shape a model reads without parsing JSON.
 *
 * ⚠️ **Every byte after the frame is a stranger's**: titles, URLs and snippets are authored by
 * whoever owns the page, and a snippet is a free-text field an attacker controls outright. So this
 * carries `SessionOrigin.externalContentFrame` — the same untrusted-input vocabulary a hostile
 * messenger turn gets, since a tool result and a prompt turn are two doors into one context window.
 *
 * ⚠️ **The frame lives HERE and not in `toModelOutput`, deliberately.** The tool's `message` field
 * also carries OUR OWN words on two other paths — "Search failed.", "No results found for that
 * query.", the offline refusal — and labelling those as external content would describe their source
 * falsely (ruling 2). This function is the one place third-party text is produced, so it is the one
 * place the label is true, and no caller can produce unframed results text by forgetting.
 *
 * An empty list stays empty and unframed: a frame around nothing announces a source that sent us
 * nothing.
 */
export const formatResults = (
  results: readonly {
    readonly title: string
    readonly url: string
    readonly snippet?: string
    readonly engine: string
  }[],
): string => {
  if (results.length === 0) return ""
  const body = results
    .map((result, index) => {
      const snippet =
        result.snippet === undefined || result.snippet.length === 0 ? "" : `\n   ${result.snippet.slice(0, 400)}`
      return `${index + 1}. ${result.title}\n   ${result.url} [${result.engine}]${snippet}`
    })
    .join("\n\n")
  return SessionOrigin.externalContentFrame("web search results") + body
}

export const description =
  "Search the web for current information — anything past your knowledge cutoff, or that you should not guess at. " +
  "Uses the user's own SearXNG instance if they configured one, otherwise NovaClaw's built-in search. " +
  "Returns titles, URLs and short snippets; follow a URL with the webfetch tool when you need the page itself. " +
  "When a result points INTO a chat platform — a Telegram channel (t.me), a Discord announcement channel, a " +
  "subreddit — webfetch will usually return an empty JavaScript shell. Read those through the `messenger` tool " +
  "instead (the user's own connected account reading a public channel), which is a real source, not a dead end. " +
  `The current year is ${new Date().getFullYear()} — say so in queries about recent events. ` +
  "If search is unavailable the result says why in plain words (offline mode, every engine throttled) — pass that on rather than inventing an answer."

// ── THE GATE, and how it COMPOSES with the offline policy rather than duplicating it ─────────────
//
// This tool shipped asserting NOTHING. It is an EGRESS channel — design-principle 4 makes the data
// plane's non-egress load-bearing — and it was the only one in the tool set with no permission at
// all, while `config/permission.ts` has advertised a `websearch` key the whole time: a config knob a
// user could set that governed nothing, which is ruling 2's *a fault is never described falsely* on
// the surface a privacy-minded user would go to first.
//
// ⚠️ IT IS NOT A SECOND OFFLINE CHECK, and it must not be read as one. There are two different
// questions here and neither answers the other:
//
//   · `Offline` (offline.ts) answers *may this INSTANCE reach the WAN at all* — a machine-level
//     policy, read live, not per-session, and deliberately NOT consentable. Web search already has
//     its own check for it (`websearch/service.ts` rule 1, "AIRGAP WINS"), which it needs because
//     its engines call raw `fetch` rather than riding the shared `HttpClient` node, so layer 1 of
//     OFF-A never sees them. Same shape npm/MCP/OTLP use.
//   · `PermissionV2` answers *may THIS SESSION do this, and does a human agree* — per-session,
//     per-agent, consentable, saveable, and the only axis on which a user or an agent rule can
//     legitimately differ from the instance default.
//
// So the assert ADDS the axis the offline policy has never had, and it cannot weaken the one it
// already has: it sits ABOVE the engine choice and can only refuse. A saved "always allow websearch"
// answer therefore never re-enables egress in airgap mode — the airgap refusal is still the answer an
// ALLOWED search receives, and it arrives as the tool's own plain-words `{ok:false, reason}` output
// rather than as a permission error, which is the honest distinction between "you may not" and
// "there is nowhere to go".
//
// ⚠️ NOT added to `AMBIENT_SAFE_BASELINE` (permission.ts), deliberately: an egress action fails the
// second of the three membership tests outright. So on a default install this ASKS once and the
// answer is saveable — exactly what `webfetch`, its sibling, already does. Under an UNATTENDED root
// it deny-fasts with `unattended-unanswerable` instead of parking a card nobody can answer.
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const search = yield* WebSearch.Service
    const permission = yield* PermissionV2.Service

    yield* tools
      .register({
        [name]: Tool.make({
          sideEffect: "read",
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: output.message }],
          execute: (input, context) =>
            Effect.gen(function* () {
              // Same shape as `tool/webfetch.ts`'s assert, so one saved answer means the same thing
              // on both halves of the web pair. The QUERY is the resource — the thing the card shows
              // and the thing a user would judge — with the same caveat `evaluate` records for
              // `bash`: matching a free-text string is prompt-reduction, never containment. What the
              // gate actually decides is whether this session may search the web at all.
              yield* permission.assert({
                action: name,
                resources: [input.query],
                save: ["*"],
                metadata: input,
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              // The session rides along because the web traffic governor's loop guard is per SESSION
              // (`websearch/service.ts` → gateFor): re-running one query past the limit is a stuck
              // agent, while the NEXT session asking the same thing is just a new conversation.
              const outcome = yield* search.search(input.query, {
                limit: input.numResults ?? 8,
                sessionID: context.sessionID,
              })
              if (!outcome.ok) return { ok: false, message: outcome.reason ?? "Search failed." } satisfies Output
              if (outcome.results.length === 0)
                return { ok: true, message: outcome.reason ?? "No results found for that query." } satisfies Output
              // A partial answer must never look complete — name the engine that dropped out.
              const degraded =
                outcome.degraded === undefined || outcome.degraded.length === 0
                  ? ""
                  : `\n\n(Partial: ${outcome.degraded.join(", ")} did not answer.)`
              return { ok: true, message: `${formatResults(outcome.results)}${degraded}` } satisfies Output
            }).pipe(
              // A denial must reach the model as the DENIAL, not as "search failed" — the difference
              // decides whether an unattended run routes around it or retries forever. `glob`/`grep`
              // do this; `webfetch` still collapses its errors and loses the wording.
              Effect.mapError((error) => {
                const denial = PermissionV2.denialMessage(error)
                if (denial) return new ToolFailure({ message: denial })
                return new ToolFailure({ message: `Unable to search the web for ${input.query}` })
              }),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/websearch",
  layer,
  deps: [ToolRegistry.node, WebSearch.node, PermissionV2.node],
})
