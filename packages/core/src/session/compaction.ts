export * as SessionCompaction from "./compaction"

import { LLM, LLMError, LLMEvent, Message, type LLMRequest, type Model } from "@novaclaw/llm"
import { DateTime, Effect, Stream } from "effect"
import type { Config } from "../config"
import type { EventV2 } from "../event"
import { CompactionPrune } from "./compaction-prune"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { isSteerText, stripSteerProvenance } from "./steer-provenance"
import { Token } from "../util/token"
import { CalloutPolicy } from "../callout-policy"

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

const estimate = (value: unknown) => Token.estimate(JSON.stringify(value))

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
    }),
    { auto: true, buffer: DEFAULT_BUFFER, tokens: DEFAULT_KEEP_TOKENS, prune: false },
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

export const buildPrompt = (input: { readonly previousSummary?: string; readonly context: readonly string[] }) =>
  [
    input.previousSummary
      ? `Update the anchored summary below using the conversation history above.\nPreserve still-true details, remove stale details, and merge in the new facts.\n<previous-summary>\n${input.previousSummary}\n</previous-summary>`
      : "Create a new anchored summary from the conversation history.",
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
    yield* Effect.logInfo("compaction prune planned", {
      commit: planned.commit,
      targets: planned.targets.length,
      reclaim: planned.reclaim,
      scanned: planned.scanned,
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
