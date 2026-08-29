export * as SessionCompaction from "./compaction"

import { LLM, LLMError, LLMEvent, Message, type LLMRequest, type Model } from "@novaclaw/llm"
import { DateTime, Effect, Stream } from "effect"
import type { Config } from "../config"
import type { EventV2 } from "../event"
import { CompactionPrune } from "./compaction-prune"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { ColleagueNote } from "./colleague-note"
import { isSteerText, stripSteerProvenance } from "./steer-provenance"
import { Token } from "../util/token"
import { CalloutPolicy } from "../callout-policy"
import { Log } from "@novaclaw/schema/log"

const DEFAULT_BUFFER = 20_000
const DEFAULT_KEEP_TOKENS = 8_000
const TOOL_OUTPUT_MAX_CHARS = 2_000
/**
 * B2 — the speaker label for a harness steer inside the summarization prompt. A steer rides the
 * `user` role into the transcript, so `[User]: …` would tell the summarizer that the harness's own
 * instruction text is something the USER said — and this summary is DURABLE, so the misattribution
 * outlives the turn (the template's "Constraints & Preferences — user constraints" section is
 * exactly where a nudge would land). We RELABEL rather than drop, for the same reason the renderer
 * keeps steers as a folded "Automated nudge" notice: a doom-loop redirect is the reason the
 * assistant changed course, and a summary that omits it invites the summarizer to invent one (or to
 * credit the user for it). The label is spelled out rather than terse because its only reader is a
 * model — and it carries the provenance, so the body is stripped instead of repeating the prefix.
 */
const STEER_LABEL = "[Automated harness check — not the user]: "
const SUMMARY_OUTPUT_TOKENS = 4_096
const SUMMARY_TEMPLATE = `Output exactly the Markdown structure shown inside <template> and keep the section order unchanged. Do not include the <template> tags in your response.
<template>
## Goal
- [single-sentence task summary]

## Constraints & Preferences
- [user constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work or "(none)"]

### In Progress
- [current work or "(none)"]

### Blocked
- [blockers or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [important technical facts, errors, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section, even when empty.
- Use terse bullets, not prose paragraphs.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Do not mention the summary process or that context was compacted.`

export type Entry = {
  readonly seq: number
  readonly message: SessionMessage.Message
}

type Settings = {
  readonly auto: boolean
  readonly buffer: number
  readonly tokens: number
  /**
   * A2-a — the cheap (non-LLM) reclaim tier, `ConfigV2.Compaction.prune`. OFF unless configured:
   * the flag has existed on the config schema since before this tier was restored, so an absent
   * value must keep behaving exactly as it did (inert), and only an explicit `true` erases history.
   */
  readonly prune: boolean
  /**
   * Whether a cycle may write an LLM summary, or stops after the cheap prune (`prune only`).
   *
   * ⚠️ Defaults TRUE, the opposite of `prune`, and for the opposite reason: summarising is what has
   * always happened, so an absent value must keep doing it. Only an explicit `false` stops it.
   */
  readonly summarize: boolean
}

type Dependencies = {
  readonly events: EventV2.Interface
  readonly llm: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  }
  readonly config: readonly Config.Entry[]
  readonly prefixHash: (sessionID: SessionSchema.ID, prefixSeq: number) => Effect.Effect<string>
}

type Input = {
  readonly sessionID: SessionSchema.ID
  readonly entries: readonly Entry[]
  readonly model: Model
  readonly request: LLMRequest
}

/**
 * What ONE media part costs the threshold, instead of its base64 length.
 *
 * 🔴 **Measured 2026-08-29 against the Spark's own accounting**, two requests differing only by the
 * image part: a 256 px icon costs the provider **66 prompt tokens**, and it is CONSTANT — a 27 KB PNG
 * and a 49 KB PNG both cost 66, because the model resizes to a fixed tile count. Two images cost
 * exactly 132.
 *
 * `JSON.stringify` of the same part is 47,000 characters of base64, which `Token.estimate` prices at
 * **11,772** — a 178x over-count, and 250x for a larger file. The estimator was tracking base64
 * length, a quantity the model never sees, so the error grew with how badly the PNG compressed.
 *
 * ⚠️ **1,500 rather than 66, deliberately.** 66 is this model's price for a small icon; a large
 * photograph tiles into many more. The estimator's contract is to err SAFE (its own header:
 * *"a soft over-budget, never a hard overflow"*), so this keeps a ~23x margin over the measured icon
 * while removing an error two orders of magnitude larger. Under-estimating is also recoverable —
 * `compactAfterOverflow` exists for the case the provider rejects a request outright.
 *
 * ⚠️ **A constant is honest about what is known.** Pricing by decoded dimensions would be closer, but
 * the assembled part carries a `data:` URI, not a decoded bitmap, and inventing a tile count from a
 * compressed byte length would repeat the mistake this replaces.
 */
const MEDIA_PART_TOKENS = 1_500

/**
 * Token estimate for an assembled request.
 *
 * 🔴 Media parts are counted at {@link MEDIA_PART_TOKENS} each and their `data` excluded, because
 * weighing an image by the character length of its base64 made the harness compact an image session
 * when its images occupied **0.5 % of the model's window** (report §30).
 */
/**
 * ⚠️ Exported as a SEAM, the same reason `serializeMessage` below is: the media-part rule is the
 * whole point of this function and it cannot be asserted through `compactIfNeeded` without building
 * a model route, a request and a config just to read one number back out of a boolean.
 */
export const estimate = (value: unknown) => {
  let mediaParts = 0
  const json = JSON.stringify(value, (_key, item: unknown) => {
    if (item !== null && typeof item === "object" && (item as { readonly type?: unknown }).type === "media") {
      mediaParts++
      // The rest of the part still counts — `mediaType` and `filename` are real prompt content.
      return { ...(item as Record<string, unknown>), data: "" }
    }
    return item
  })
  return Token.estimate(json) + mediaParts * MEDIA_PART_TOKENS
}

const truncate = (value: string) =>
  value.length <= TOOL_OUTPUT_MAX_CHARS ? value : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`

export const serializeToolContent = (content: SessionMessage.ToolStateCompleted["content"]) =>
  content
    .map((item) =>
      item.type === "text" ? item.text : `[Attached ${item.mime}${item.name === undefined ? "" : `: ${item.name}`}]`,
    )
    .join("\n")

/**
 * One transcript message → the line(s) that represent it inside the summarization prompt. Exported
 * as a seam so the speaker label of every arm can be asserted directly (see
 * `test/session-compaction.test.ts`); `serializeToolContent` above is exported for the same reason.
 */
export const serializeMessage = (message: SessionMessage.Message) => {
  if (message.type === "user") {
    // Ask the provenance question BEFORE claiming the user said this (session/steer-provenance.ts).
    if (isSteerText(message.text)) return `${STEER_LABEL}${stripSteerProvenance(message.text)}`
    const files = message.files?.map((file) => `[Attached ${file.mime}: ${file.name ?? file.uri}]`) ?? []
    // 🔴 A DELIVERED PEER MESSAGE IS A USER MESSAGE, and labelling it `[User]` launders a colleague's
    // question into something the owner asked. Durable, too: after one compaction nothing downstream
    // can recover who actually said it. Same misattribution the line above prevents for steers —
    // the provenance question, asked of the other writer that lands here.
    const origin = message.origin
    if (origin?.via === "agent" && origin.relation === "peer") {
      const who = origin.label ?? origin.sessionID
      // A group message names the room, because "who spoke" and "who heard it" are different facts
      // and a summary keeping only the roster has kept the wrong one.
      const room = origin.conversation !== undefined ? ", to the room" : ""
      // The reply note is a route back, spent once the exchange is over — see `stripReplyNote`.
      return [`[Colleague ${who}${room}]: ${ColleagueNote.stripReplyNote(message.text)}`, ...files].join("\n")
    }
    return [`[User]: ${message.text}`, ...files].join("\n")
  }
  if (message.type === "assistant") {
    return message.content
      .flatMap((part) => {
        if (part.type === "text") return [`[Assistant]: ${part.text}`]
        if (part.type === "reasoning") return part.text ? [`[Assistant reasoning]: ${part.text}`] : []
        const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
        if (part.state.status === "completed")
          return [
            `[Assistant tool call]: ${part.name}(${input})`,
            `[Tool result]: ${truncate(serializeToolContent(part.state.content))}`,
          ]
        if (part.state.status === "error")
          return [`[Assistant tool call]: ${part.name}(${input})`, `[Tool error]: ${part.state.error.message}`]
        return [`[Assistant tool call]: ${part.name}(${input})`]
      })
      .join("\n")
  }
  if (message.type === "system") return `[System update]: ${message.text}`
  if (message.type === "synthetic") return `[Synthetic context]: ${message.text}`
  if (message.type === "shell") return `[Shell]: ${message.command}\n${truncate(message.output)}`
  return ""
}

/**
 * Fold every `compaction` block in the config chain into one settings record, later documents
 * winning per key. Exported as a seam so each key can be asserted directly — `prune` in particular
 * was DECLARED on `ConfigV2.Compaction` while nothing read it, and a reduce that silently drops a
 * key compiles green (see `test/session-compaction-prune.test.ts`); `serializeToolContent` and
 * `selectContext` are exported for the same reason.
 */
export const settings = (documents: readonly Config.Entry[]) => {
  const configured = documents
    .filter((entry): entry is Config.Document => entry.type === "document")
    .flatMap((entry) => (entry.info.compaction ? [entry.info.compaction] : []))
  return configured.reduce<Settings>(
    (result, current) => ({
      auto: current.auto ?? result.auto,
      buffer: current.buffer ?? result.buffer,
      tokens: current.keep?.tokens ?? result.tokens,
      prune: current.prune ?? result.prune,
      // Default TRUE: prune-then-summarise is what has always shipped, so an absent setting must not
      // silently turn summarising off for every existing install.
      summarize: current.summarize ?? result.summarize,
    }),
    { auto: true, buffer: DEFAULT_BUFFER, tokens: DEFAULT_KEEP_TOKENS, prune: false, summarize: true },
  )
}

/**
 * Split the serialized transcript into the `head` that gets summarized away and the `recent` tail
 * kept verbatim. Both are durable — `head` feeds the summary prompt, `recent` is stored on the
 * compaction message — so both are asserted directly in the tests.
 */
export const selectContext = (
  entries: readonly Entry[],
  tokens: number,
): { readonly head: string; readonly recent: string } | undefined => {
  const conversation = entries
    .filter((entry) => entry.message.type !== "compaction")
    .map((entry) => ({ message: entry.message, text: serializeMessage(entry.message) }))
    .filter((entry) => entry.text.length > 0)
  if (conversation.length === 0) return
  let total = 0
  let recentStart = conversation.length
  for (let index = conversation.length - 1; index >= 0; index--) {
    const next = total + Token.estimate(conversation[index]!.text)
    if (next > tokens) break
    total = next
    recentStart = index
  }
  // A context overlay may cut only AFTER a completed assistant turn. If the token target lands in
  // the middle of an exchange, retain whole messages until the preceding message is an assistant.
  // This makes the retained tail agentic history rather than a bag of token fragments.
  while (recentStart > 0 && conversation[recentStart - 1]!.message.type !== "assistant") recentStart--
  return {
    head: conversation
      .slice(0, recentStart)
      .map((entry) => entry.text)
      .join("\n\n"),
    recent: conversation
      .slice(recentStart)
      .map((entry) => entry.text)
      .join("\n\n"),
  }
}

/**
 * 🔴 **The wording is fixed; the ORDER is deliberately unchanged.**
 *
 * It used to say "the conversation history above" while `...input.context` is appended BELOW it.
 * This call carries no system prompt, so that sentence is the whole framing and a bad summary is
 * durable — it replaces the transcript it summarises (NC-PROMPT-LANG-002).
 *
 * ⚠️ **CACHE-009's reorder was tried and REVERTED.** Putting `SUMMARY_TEMPLATE` first would make the
 * constant a reusable prefix, but the first 100-file run after that change recorded **0 compactions
 * against 8** in the run before it, and went 2x slower past 20 files — the signature of a context that
 * never shrinks. Causation is UNPROVEN; what is certain is that this builder has no test, so a
 * structural change to it is unobservable until a long run behaves badly. Reorder it only behind a
 * test that pins a compaction actually committing.
 */
export const buildPrompt = (input: { readonly previousSummary?: string; readonly context: readonly string[] }) =>
  [
    input.previousSummary
      ? `Update the anchored summary in <previous-summary> using the conversation history that follows it.
Preserve still-true details, remove stale details, and merge in the new facts.
<previous-summary>
${input.previousSummary}
</previous-summary>`
      : "Create a new anchored summary from the conversation history that follows.",
    SUMMARY_TEMPLATE,
    ...input.context,
  ].join("\n\n")

export const make = (dependencies: Dependencies) => {
  const config = settings(dependencies.config)
  /**
   * A2-a — the CHEAP tier, ahead of everything the summarizer does.
   *
   * Erase stale tool output (`compaction-prune.ts` owns the decision; this owns the wiring) and
   * hand the pruned transcript to the rest of the cycle, so BOTH durable halves of a compaction
   * shrink: the `head` that feeds the summary prompt, and the `recent` tail that is stored verbatim
   * on the compaction message and re-fed as context on every later turn. Under the 20k floor the
   * plan does not commit and `entries` comes back by identity — history is untouched and the
   * summarize tier proceeds exactly as before.
   *
   * ONE call site on purpose: `compactIfNeeded` reaches this through `compactAfterOverflow`, and
   * the manual `/compact` cycle enters the same function. A second copy of the tier would be the
   * duplication that produced the COMSPEC divergence (ruling 6) in miniature.
   */
  const pruneCheapTier = Effect.fn("SessionCompaction.prune")(function* (entries: readonly Entry[]) {
    if (!config.prune) return entries
    const planned = CompactionPrune.plan(entries.map((entry) => entry.message))
    yield* Log.event("session.compaction.prune.planned", {
      "session.commit": planned.commit,
      "session.targets": planned.targets.length,
      "session.reclaim": planned.reclaim,
      "session.scanned": planned.scanned,
    })
    if (!planned.commit) return entries
    const erased = CompactionPrune.erase(
      entries.map((entry) => entry.message),
      planned,
      yield* DateTime.now,
    )
    return entries.map((entry, index) => ({ ...entry, message: erased[index]! }))
  })
  // `reason` threads into the Compaction.Started/Ended events: "auto" for the runner's overflow /
  // threshold paths (the default keeps every existing caller unchanged), "manual" for the
  // user-requested compact cycle (SessionV2.compact → the runner's SessionCompactionRequest marker).
  const compactAfterOverflow = Effect.fn("SessionCompaction.compactAfterOverflow")(function* (
    input: Input,
    reason: "auto" | "manual" = "auto",
  ) {
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    const entries = yield* pruneCheapTier(input.entries)
    // PRUNE ONLY (`compaction.summarize: false`). The cheap tier has already run and its reclaim is
    // durable for this cycle; stopping here is the whole point of the setting. Returning `false`
    // means "no compaction message was written", which is exactly true — and the caller's contract
    // is already that a declined cycle leaves the transcript alone.
    //
    // ⚠️ Deliberately AFTER the prune, not instead of it: the reclaim is the part worth having, and
    // gating the tier itself is what `prune: false` already does.
    if (!config.summarize) {
      yield* Log.event("session.compaction.prune.only", { "session.id": input.sessionID })
      return false
    }
    const selected = selectContext(entries, config.tokens)
    const previousSummary = entries.find((entry) => entry.message.type === "compaction")?.message
    if (!selected || (selected.head.length === 0 && previousSummary?.type !== "compaction")) return false
    const summaryPrompt = buildPrompt({
      previousSummary: previousSummary?.type === "compaction" ? previousSummary.summary : undefined,
      context: [previousSummary?.type === "compaction" ? previousSummary.recent : "", selected.head].filter(Boolean),
    })
    const summaryOutput = Math.min(output || SUMMARY_OUTPUT_TOKENS, SUMMARY_OUTPUT_TOKENS)
    if (Token.estimate(summaryPrompt) > context - summaryOutput) return false
    const messageID = SessionMessage.ID.create()
    yield* dependencies.events.publish(SessionEvent.Compaction.Started, {
      sessionID: input.sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      reason,
    })

    const chunks: string[] = []
    let failed = false
    const summarized = yield* dependencies.llm
      .stream(
        LLM.request({
          model: input.model,
          messages: [Message.user(summaryPrompt)],
          tools: [],
          generation: { maxTokens: summaryOutput },
        }),
      )
      .pipe(
        Stream.runForEach((event) => {
          if (LLMEvent.is.providerError(event)) failed = true
          if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
          return Effect.void
        }),
        Effect.as(true),
        Effect.catchTag("LLM.Error", () => Effect.succeed(false)),
        Effect.timeoutOrElse({
          duration: CalloutPolicy.summarizer.timeoutMs,
          orElse: () => Effect.succeed(false),
        }),
      )
    const summary = chunks.join("")
    if (!summarized || failed || !summary.trim()) return false
    const prefixSeq = entries.reduce((highest, entry) => Math.max(highest, entry.seq), 0)
    yield* dependencies.events.publish(SessionEvent.Compaction.Ended, {
      sessionID: input.sessionID,
      messageID,
      timestamp: yield* DateTime.now,
      reason,
      text: summary,
      recent: selected.recent,
      prefixSeq,
      prefixHash: yield* dependencies.prefixHash(input.sessionID, prefixSeq),
    })
    return true
  })
  const compactIfNeeded = Effect.fn("SessionCompaction.compactIfNeeded")(function* (input: Input) {
    if (!config.auto) return false
    const context = input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return false
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    if (
      estimate({ system: input.request.system, messages: input.request.messages, tools: input.request.tools }) <=
      context - Math.max(output, config.buffer)
    )
      return false
    // The cheap tier runs inside `compactAfterOverflow`, ahead of the summary prompt — the
    // threshold test above reads the ALREADY-ASSEMBLED request, which prune cannot shrink.
    return yield* compactAfterOverflow(input)
  })
  return {
    compactIfNeeded,
    compactAfterOverflow,
  }
}
