export * as SessionCompaction from "./compaction"

import { LLM, LLMError, LLMEvent, Message, type FinishReason, type LLMRequest, type Model } from "@novaclaw/llm"
import { DateTime, Effect, Stream } from "effect"
import { OldContext } from "./old-context"
import type { Config } from "../config"
import type { EventV2 } from "../event"
import { CompactionPrune } from "./compaction-prune"
import { SessionEvent } from "./event"
import { SessionMessage } from "./message"
import { SessionToolContent } from "./tool-content"
import { SessionSchema } from "./schema"
import { ColleagueNote } from "./colleague-note"
import { isSteerText, stripSteerProvenance, stripAutomatedEcho } from "./steer-provenance"
import { Token } from "../util/token"
import { Log } from "@novaclaw/schema/log"
import { ReasoningBudget } from "./runner/reasoning-budget"
import { PromptEstimate } from "./runner/prompt-estimate"
import { Flag } from "../flag/flag"
import { SessionScheduler } from "./scheduler"
import { ProviderDispatch } from "./runner/provider-dispatch"
import { ContextBudget } from "./runner/context-budget"
import type { SessionRunnerModel } from "./runner/model"

const DEFAULT_BUFFER = 20_000
const DEFAULT_KEEP_TOKENS = 8_000
/**
 * Where a compaction cycle fires when nothing is configured: 80% of the model's context window.
 *
 * Owner, 2026-09-19: *"expose the Compaction Threshold (default 80%). Once the usage goes over 80%,
 * we do compaction."* It is the earlier of this and the response-reserve ceiling, so it never lets a
 * prompt reach a window the packer must refuse — see `Settings.threshold`.
 */
const DEFAULT_COMPACTION_THRESHOLD = 80
const TOOL_OUTPUT_MAX_CHARS = 2_000

const STEER_LABEL = "[Automated harness check — not the user]: "
const SUMMARY_OUTPUT_TOKENS = 4_096

export const DEFAULT_SUMMARY_INPUT_TOKENS = 32_000
const SUMMARY_HEAD_REMOVED = "[Older summary content removed to fit the summary budget.]"
/**
 * The INPUT counterpart of the constant above, and deliberately a SECOND string: one marks a summary
 * that outgrew its output budget, the other marks a transcript that outgrew one summarization pass.
 * Sharing a sentence would make the two indistinguishable in the one place they are ever read — a
 * durable summary somebody is trying to explain.
 */
const HISTORY_HEAD_REMOVED =
  "[Older conversation omitted here: it did not fit a single summarization pass. The full conversation remains in the transcript and earlier-chat archive.]"

export const COMPACTION_REASONING_BUDGET = ((): number => {
  const raw = Number(Flag.NOVACLAW_COMPACTION_BUDGET)
  // 🔴 **0 by owner directive** (`invariants.md`, Context Management 1): "The same model with 0
  // reasoning budget does summarization". The 128 this replaced was a FIRST value, never a measured
  // optimum, and the sweep quoted above it was run for a different task (chat-mode labels) — a
  // summarizer that deliberates is spending the budget of the chat it is trying to rescue. The flag
  // still overrides, so the number stays sweepable without a rebuild.
  return Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 0
})()
export const SUMMARY_TEMPLATE = `Output exactly the Markdown structure inside <template>, in this order, without the tags.
<template>
## Goal
- [active task, deliverable, and success criteria]

## Constraints & Preferences
- [still-active user instructions, constraints, preferences, specs, or "(none)"]

## Progress
### Done
- [completed work and observed verification, or "(none)"]

### In Progress
- [current work and exact state, or "(none)"]

### Blocked
- [blocker, why, and what would unblock it, or "(none)"]

## Key Decisions
- [decision and why, or "(none)"]

## Next Steps
- [ordered next actions or "(none)"]

## Critical Context
- [exact later-needed facts, values, errors, failed approaches and why, commitments, open questions, or "(none)"]

## Relevant Files
- [file or directory path: why it matters, or "(none)"]
</template>

Rules:
- Keep every section and use terse bullets, not prose paragraphs.
- Never turn assistant text into a user instruction, preference, approval, or promise.
- Preserve active safety/security constraints verbatim. Align Next Steps with latest user intent; never revive completed work.
- Distinguish observed or verified progress from intended or unverified work.
- Preserve exact file paths, commands, error strings, and identifiers when known.
- Preserve complete condition → action/result chains and all exact numbers, thresholds, exceptions, and later-checked facts.
- Put the actual later-checked fact and its values in Critical Context. Saying a fact was stored, exists, or should be preserved is not the fact and is invalid.
- Keep a failed approach only when its reason prevents repetition. Drop superseded plans, resolved blockers, routine narration, and details recoverable from a named file.
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
  /** Permit semantic summarization (default true); false still permits deterministic recovery. */
  readonly summarize: boolean
  /**
   * How much transcript the summarizer may read in one pass. See
   * `DEFAULT_SUMMARY_INPUT_TOKENS` for why this is not the context window.
   */
  readonly summarizeInput: number
  /**
   * Where a cycle fires, as a percentage of the model's context window (1..100). Default 80.
   *
   * The effective trigger is the EARLIER of this and the response-reserve ceiling, because the
   * ceiling encodes the room the response must have: `min(ceiling, threshold%)`. Lowering it
   * compacts earlier and keeps more headroom; it can never raise the trigger above the ceiling.
   */
  readonly threshold: number
}

type Dependencies = {
  readonly events: EventV2.Interface
  readonly llm: {
    readonly stream: (request: LLMRequest) => Stream.Stream<LLMEvent, LLMError>
  }
  readonly config: readonly Config.Entry[]
  readonly prefixHash: (sessionID: SessionSchema.ID, prefixSeq: number) => Effect.Effect<string>
  readonly scheduler?: SessionScheduler.Interface
}

export type Outcome = { readonly mode: "semantic" | "deterministic"; readonly reason?: DeclineReason }

export type Input = {
  readonly sessionID: SessionSchema.ID
  readonly entries: readonly Entry[]
  readonly model: Model
  readonly request: LLMRequest
  /** System, tools and dynamic messages that remain after replacing the conversation. */
  readonly fixedPromptTokens?: number
  /** Native schema tokens removed by rebuilding the next epoch for a smaller model. */
  readonly replacedPrefixTokens?: number
  readonly promptEstimate?: PromptEstimate.Result
  /** Resolved patch side for this exact model/server route; absent keeps the measured default. */
  readonly imagePatchPixels?: number
  /** Exact-route prompt prefix known to remain reusable; absent keeps the context-only guard. */
  readonly prefixCacheRetentionTokens?: number
  /** Empirically honoured window for this exact serving route; overrides an optimistic catalog. */
  readonly contextWindowTokens?: number
  /** Admission identity for this decode-shaped maintenance pass. */
  readonly maintenance?: SessionScheduler.MaintenanceInput
  /** Last-mile switch check; production supplies it, while isolated compactor seams may omit it. */
  readonly guard?: SessionRunnerModel.DispatchGuard
  /** Exact calibrated prompt size that the provider rejected. Present only for overflow recovery. */
  readonly overflowPromptTokens?: number
  /** One fixed post-compaction target derived from that rejected prompt. */
  readonly overflowTargetTokens?: number
  /**
   * Called with the NAMED reason whenever this cycle declines. Optional because the auto path has
   * nobody to tell; the manual path passes it so the notice the user reads is the branch that
   * actually fired rather than a guess — see `DeclineReason`.
   */
  readonly onDecline?: (reason: DeclineReason) => void
  readonly onOutcome?: (outcome: Outcome) => void

  readonly summaryAllowed?: boolean

  readonly scratchFolder?: string
}

export type DeclineReason =
  /** The route declares no usable context window, so there is no budget to compact against. */
  | "context-window-unknown"
  /** `compaction.auto` is off: the automatic trigger is not allowed to fire at all. */
  | "auto-disabled"
  /** `compaction.summarize` is off; recovery retains original text instead of a model summary. */
  | "prune-only"
  /** The assembled prompt is under the trigger's ceiling. The ordinary, healthy decline. */
  | "under-threshold"
  /** Nothing foldable: no conversation to summarize, or an empty head with no previous summary. */
  | "nothing-to-fold"
  /** The window is too small to hold any summary at all, let alone the retry envelope. */
  | "context-too-small"
  /** Even a maximally trimmed transcript will not fit one summarization pass. */
  | "transcript-too-large"
  /** The summarizer returned nothing usable — unreachable, errored, timed out, or empty. */
  | "summarizer-unavailable"
  /** The summarizer answered, but out of budget in a shape no bounded retry can rescue. */
  | "summary-unusable"
  /**
   * The summarizer failed recently and the retry watermark has not elapsed. **Measured, not
   * attempted** — see `Input.summaryAllowed`.
   */
  | "summarizer-backoff"

/**
 * The ONE sentence a declined compaction may show a user, keyed by the branch that actually fired.
 *
 * ⚠️ It says what happened AND what to do, because every one of these has a different next move and
 * the user is reading it instead of a screen that changed. Principle 14: it goes in the reply.
 */
export const declineNotice = (reason: DeclineReason): string => {
  switch (reason) {
    case "context-window-unknown":
      return "⚠️ Compaction didn't run — this model's context window isn't known, so there's nothing to measure a summary against. Set the model's context limit and try again."
    case "auto-disabled":
      return "⚠️ Compaction didn't run — automatic compaction is switched off for this chat."
    case "prune-only":
      return "Compaction used original conversation text because model summarization is disabled for this chat."
    case "under-threshold":
    case "nothing-to-fold":
      return "⚠️ Compaction didn't run — the conversation is still small enough that there is nothing to fold up."
    case "context-too-small":
      return "⚠️ Compaction didn't run — this model's context window is too small to hold a summary of it. Switch this chat to a model with a larger window."
    case "transcript-too-large":
      return "⚠️ Compaction didn't run — this conversation is too large to summarise in one pass on this model. Switch this chat to a model with a larger context window, or start a fresh chat and carry over what matters."
    case "summarizer-unavailable":
      return "⚠️ Compaction didn't run — the summary model didn't answer. Check the model is reachable and try again."
    case "summary-unusable":
      return "⚠️ Compaction didn't run — the summary model answered, but not within the budget its summary has to fit. Try again, or switch this chat to a different model."
    case "summarizer-backoff":
      // Reachable only from the automatic path, which has nobody to tell; kept exhaustive on purpose
      // so a future manual caller cannot inherit a silent `undefined`.
      return "⚠️ Compaction didn't run — the last summary attempt failed, so NovaClaw is waiting before spending another one. Your conversation is untouched."
  }
}

export const estimate = (value: unknown, imagePatchPixels?: number) => Token.estimateStructured(value, imagePatchPixels)

const truncate = (value: string) =>
  value.length <= TOOL_OUTPUT_MAX_CHARS ? value : `${value.slice(0, TOOL_OUTPUT_MAX_CHARS)}\n[truncated]`

export const serializeToolContent = SessionToolContent.serialize

/**
 * One transcript message → the line(s) that represent it inside the summarization prompt. Exported
 * as a seam so the speaker label of every arm can be asserted directly (see
 * `test/session-compaction.test.ts`); `serializeToolContent` above is exported for the same reason.
 */
export const serializeMessage = (message: SessionMessage.Message, complete = false) => {
  const output = complete ? (text: string) => text : truncate
  if (message.type === "colleague") {
    const room = message.conversation !== undefined ? ", to the room" : ""
    return `[Colleague ${message.sender}${room}, ${message.turn}]: ${ColleagueNote.stripReplyNote(message.text)}`
  }
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
        if (part.type === "text") {
          const text = stripAutomatedEcho(part.text)
          return text ? [`[Assistant]: ${text}`] : []
        }
        if (part.type === "reasoning") {
          const text = stripAutomatedEcho(part.text)
          return text ? [`[Assistant reasoning]: ${text}`] : []
        }
        const input = typeof part.state.input === "string" ? part.state.input : JSON.stringify(part.state.input)
        if (part.state.status === "completed")
          return [
            `[Assistant tool call]: ${part.name}(${input})`,
            `[Tool result]: ${output(serializeToolContent(part.state.content))}`,
          ]
        if (part.state.status === "error")
          return [`[Assistant tool call]: ${part.name}(${input})`, `[Tool error]: ${part.state.error.message}`]
        return [`[Assistant tool call]: ${part.name}(${input})`]
      })
      .join("\n")
  }
  if (message.type === "system") return `[System update]: ${message.text}`
  if (message.type === "synthetic") return `[Synthetic context]: ${message.text}`
  if (message.type === "shell") return `[Shell]: ${message.command}\n${output(message.output)}`
  return ""
}

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
      // ⚠️ `??` and not a falsy test: the schema is `PositiveInt`, so a stored `0` is refused at
      // decode rather than silently reinterpreted as "use the default".
      summarizeInput: current.summarizeInput ?? result.summarizeInput,
      // `??` for the same reason: the schema is 1..100, so a stored value is a real choice.
      threshold: current.threshold ?? result.threshold,
    }),
    {
      auto: true,
      buffer: DEFAULT_BUFFER,
      tokens: DEFAULT_KEEP_TOKENS,
      prune: false,
      summarize: true,
      summarizeInput: DEFAULT_SUMMARY_INPUT_TOKENS,
      threshold: DEFAULT_COMPACTION_THRESHOLD,
    },
  )
}

export const triggerAt = (input: {
  readonly context: number
  readonly promptCeilingTokens: number
  readonly thresholdPercent: number
}): number => {
  const percent = Math.max(1, Math.min(100, Math.trunc(input.thresholdPercent)))
  const byPercent = Math.max(1, Math.floor((input.context * percent) / 100))
  return Math.max(1, Math.min(input.promptCeilingTokens > 0 ? input.promptCeilingTokens : byPercent, byPercent))
}

/**
 * Split the serialized transcript into the `head` that gets summarized away and the `recent` tail
 * kept verbatim. Both are durable — `head` feeds the summary prompt, `recent` is stored on the
 * compaction message — so both are asserted directly in the tests.
 */
export const summarizeInputCeiling = (
  contextTokens: number,
  summaryOutputTokens: number,
  summarizeInputTokens: number | undefined,
): number => {
  const providerCeiling = Math.max(0, Math.floor(contextTokens - summaryOutputTokens))
  if (summarizeInputTokens === undefined || !Number.isSafeInteger(summarizeInputTokens) || summarizeInputTokens <= 0)
    return providerCeiling
  return Math.max(1, Math.min(providerCeiling, summarizeInputTokens))
}

/** Owner-specified operation, appended after the evidence. */
export const SUMMARY_OPERATION =
  "Summarize above text, extracting key details, current work and the goal, required to continue work. Dont include system prompt."

/** Keep the summary operation after the evidence, outside the officer's system prompt. */
export const buildInstruction = (previousSummary?: string, evidence: "history" | "prefix" = "history") => {
  const source = evidence === "prefix" ? "the conversation above" : "the conversation history in <history>"
  return [
    SUMMARY_OPERATION,
    previousSummary
      ? `Update the anchored summary in <previous-summary> using ${source}.
Preserve still-true details, remove stale details, and merge in the new facts.
<previous-summary>
${previousSummary}
</previous-summary>`
      : `Create a new anchored summary from ${source}.`,
    SUMMARY_TEMPLATE,
  ].join("\n\n")
}

/** Bounded standalone request; the anchored summary is retained while older history may be cut. */
export const buildPrompt = (input: { readonly previousSummary?: string; readonly context: readonly string[] }) =>
  [`<history>\n${input.context.join("\n\n")}\n</history>`, buildInstruction(input.previousSummary)].join("\n\n")

/**
 * Enforce the shared token estimate on every summary. Provider-reported visible usage is an
 * additional ceiling when it exists; some local servers omit it, but a missing count must never be
 * mistaken for a free/unbounded output.
 */
export const summaryWithinBudget = (text: string, budgetTokens: number, reportedTokens?: number) => {
  if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) return false
  if (Token.estimate(text) > budgetTokens) return false
  return reportedTokens === undefined || !Number.isFinite(reportedTokens) || reportedTokens <= budgetTokens
}

export const trimSummaryHead = (
  text: string,
  budgetTokens: number,
  markLoss = false,
  measure = Token.estimate,
  marker = SUMMARY_HEAD_REMOVED,
) => {
  const value = text.trimEnd()
  if (!value || !Number.isFinite(budgetTokens) || budgetTokens <= 0) return ""
  const fits = (candidate: string) => measure(candidate) <= budgetTokens
  if (!markLoss && fits(value)) return value

  // Search by Unicode scalar rather than UTF-16 code unit so the kept tail never begins with half
  // a surrogate pair. Mechanical recovery is allowed to lose the oldest prose, not corrupt the
  // newest identifier or emoji into an invalid string.
  const suffix = (length: number) => {
    let start = value.length - length
    const code = value.charCodeAt(start)
    if (code >= 0xdc00 && code <= 0xdfff) start++
    return value.slice(start)
  }

  const withMarker = (length: number) => (length <= 0 ? marker : `${marker}\n${suffix(length)}`)
  const markerFits = fits(marker)
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const candidate = markerFits ? withMarker(middle) : suffix(middle)
    if (fits(candidate)) low = middle
    else high = middle - 1
  }
  if (low === 0) return markerFits ? marker : ""
  return markerFits ? withMarker(low) : suffix(low)
}

export const make = (dependencies: Dependencies) => {
  const config = settings(dependencies.config)
  const summarize = Effect.fn("SessionCompaction.summarize")(function* (input: {
    readonly request: LLMRequest
    readonly model: Model
    readonly outputTokens: number
    readonly sessionID: SessionSchema.ID
    readonly messageID: SessionMessage.ID
    readonly maintenance?: SessionScheduler.MaintenanceInput
    readonly guard?: SessionRunnerModel.DispatchGuard
  }) {
    const chunks: string[] = []
    let generatedChars = 0
    let checkpointChars = 0
    let checkpointAt = Date.now()
    let failed = false
    let overBudget = false
    let receivedChars = 0
    const characterCeiling = Math.max(4096, input.outputTokens * 16)
    let finish: FinishReason | undefined
    let reportedTokens: number | undefined
    const deltaTimestamp = yield* DateTime.now
    const guardedStream = (request: LLMRequest) => {
      const source =
        input.guard === undefined
          ? dependencies.llm.stream(request)
          : Stream.unwrap(input.guard(Effect.sync(() => dependencies.llm.stream(request))))
      // Bound raw provider events before the reasoning controller can buffer or filter them.
      return source.pipe(
        Stream.takeWhile((event) => {
          if (LLMEvent.is.textDelta(event) || LLMEvent.is.reasoningDelta(event)) receivedChars += event.text.length
          overBudget = receivedChars > characterCeiling
          return !overBudget
        }),
      )
    }

    const request = COMPACTION_REASONING_BUDGET <= 0 ? ProviderDispatch.withoutReasoning(input.request) : input.request
    const phases = ReasoningBudget.stream({
      request,
      stream: guardedStream,
      budget: COMPACTION_REASONING_BUDGET,
      // This request is itself a postfix operation. Keep its exact instruction last; token
      // checkpoints and the hard stop still apply without the informational opening prime.
      prime: false,
    })
    const generation = phases.pipe(
      Stream.runForEach((event) => {
        if (LLMEvent.is.providerError(event)) failed = true
        if (LLMEvent.is.textDelta(event)) {
          generatedChars += event.text.length
          chunks.push(event.text)
          return Effect.gen(function* () {
            yield* dependencies.events.publish(SessionEvent.Compaction.Delta, {
              sessionID: input.sessionID,
              messageID: input.messageID,
              timestamp: deltaTimestamp,
              text: event.text,
            })
            const now = Date.now()
            if (generatedChars - checkpointChars < 512 && now - checkpointAt < 500) return
            checkpointChars = generatedChars
            checkpointAt = now
            yield* dependencies.events.publish(SessionEvent.Compaction.Progress, {
              sessionID: input.sessionID,
              messageID: input.messageID,
              timestamp: yield* DateTime.now,
              generatedChars,
            })
          })
        }
        if (event.type === "finish" || event.type === "step-finish") {
          finish = event.reason
          const visible = event.usage?.visibleOutputTokens
          if (visible !== undefined && Number.isFinite(visible) && visible > 0)
            reportedTokens = Math.max(reportedTokens ?? 0, visible)
        }
        return Effect.void
      }),
      Effect.as(true),
      Effect.catchTags({
        "LLM.Error": () => Effect.succeed(false),
        "SessionRunnerModel.ModelUnavailableError": () => Effect.succeed(false),
      }),
    )
    const completed = yield* dependencies.scheduler !== undefined && input.maintenance !== undefined
      ? SessionScheduler.runMaintenance(dependencies.scheduler, input.maintenance, generation, Effect.succeed(false))
      : generation
    return { text: chunks.join(""), completed, failed, overBudget, finish, reportedTokens, generatedChars } as const
  })

  const pruneCheapTier = Effect.fn("SessionCompaction.prune")(function* (
    entries: readonly Entry[],
    imagePatchPixels?: number,
  ) {
    if (!config.prune) return entries
    const planned = CompactionPrune.plan(
      entries.map((entry) => entry.message),
      imagePatchPixels,
    )
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

  const saveFoldedChat = Effect.fnUntraced(function* (input: {
    readonly scratchFolder: string
    readonly text: string
    readonly sessionID: SessionSchema.ID
    readonly at: Date
    readonly id: string
  }) {
    const at = input.at
    return yield* Effect.tryPromise({
      try: async () => {
        const saved = await OldContext.save({ scratchFolder: input.scratchFolder, at, text: input.text, id: input.id })
        // The JSON sibling rides the same fold; a failure to write it must not lose the `.txt` file,
        // so it is best-effort and separate.
        await OldContext.saveWorkLog({ scratchFolder: input.scratchFolder, at, text: input.text }).catch(
          () => undefined,
        )
        return saved
      },
      catch: (cause) => cause,
    }).pipe(
      Effect.tap((file) =>
        Log.event("session.compaction.folded.saved", {
          "session.id": String(input.sessionID),
          "compaction.folded.file": file,
          "compaction.folded.chars": input.text.length,
        }),
      ),
      Effect.catch((cause) =>
        Log.event("session.compaction.folded.unsaved", {
          "session.id": String(input.sessionID),
          "compaction.folded.chars": input.text.length,
          "compaction.folded.error": Log.fault(cause),
        }).pipe(Effect.as(undefined)),
      ),
    )
  })
  // Every committed overlay owns the entire covered prefix, including an older overlay.
  // Archive that exact evidence before replacing it; never summarize an already packed request.
  const compactAfterOverflow = Effect.fn("SessionCompaction.compactAfterOverflow")(function* (
    input: Input,
    reason: "auto" | "manual" = "auto",
  ) {
    const decline = (why: DeclineReason) => {
      input.onDecline?.(why)
      return false
    }
    const context = input.contextWindowTokens ?? input.model.route.defaults.limits?.context
    if (context === undefined || !Number.isFinite(context) || context <= 0) return decline("context-window-unknown")
    const output = ContextBudget.outputTokens(
      context,
      input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output,
    )
    const triggerEstimate = input.promptEstimate ?? PromptEstimate.unsupported(input.request, input.imagePatchPixels)
    const capacity = PromptEstimate.capacity({
      contextTokens: context,
      outputTokens: output,
      minimumResponseReserveTokens: config.buffer,
    })
    const threshold = triggerAt({
      context,
      promptCeilingTokens: capacity.promptCeilingTokens,
      thresholdPercent: config.threshold,
    })
    const previous = input.entries.findLast((entry) => entry.message.type === "compaction")?.message
    const checkpoint = previous?.type === "compaction" ? previous : undefined
    const priorFile = checkpoint?.metadata?.["compaction.folded.file"]
    const prior = [
      typeof priorFile === "string" ? OldContext.tombstone(priorFile) : "",
      checkpoint?.summary ? `<previous-summary>\n${checkpoint.summary}\n</previous-summary>` : "",
      checkpoint?.recent ?? "",
    ]
      .filter(Boolean)
      .join("\n\n")
    const render = (entries: readonly Entry[], complete = true) =>
      [prior, ...entries.map((entry) => serializeMessage(entry.message, complete))].filter(Boolean).join("\n\n")
    const original = render(input.entries)
    if (!original.trim()) return decline("nothing-to-fold")
    const entries = yield* pruneCheapTier(input.entries, input.imagePatchPixels)
    const transcript = entries === input.entries ? original : render(entries)
    const before = Token.estimate(original) + Math.max(0, input.replacedPrefixTokens ?? 0)
    const archiveAt = DateTime.toDate(yield* DateTime.now)
    const archiveID = OldContext.identity()
    const archiveFile =
      input.scratchFolder === undefined
        ? undefined
        : OldContext.file({ scratchFolder: input.scratchFolder, at: archiveAt, id: archiveID })
    const replacementTokens = (summary: string, recent: string) =>
      PromptEstimate.whole(
        {
          ...input.request,
          system: [],
          tools: [],
          messages: [Message.user(OldContext.checkpoint({ summary, recent, file: archiveFile }))],
        },
        input.imagePatchPixels,
      )
    // Leave room for checkpoint framing, its archive path, and epoch materialization. Keeping
    // only 65% of the available history prevents an immediate second fold after reconstruction.
    const fixed =
      input.fixedPromptTokens ?? PromptEstimate.whole({ ...input.request, messages: [] }, input.imagePatchPixels)
    const ceiling = Math.min(threshold, input.overflowTargetTokens ?? Infinity)
    const targetMargin = Math.min(triggerEstimate.marginTokens, Math.ceil(context * 0.05))
    const budget = Math.max(0, Math.min(before - 1, Math.floor((ceiling - fixed - targetMargin - 256) * 0.65)))
    if (budget <= 0) return decline("context-too-small")
    if (replacementTokens("", "") >= budget) return decline("nothing-to-fold")
    const summaryOutput = Math.max(
      0,
      Math.min(output || SUMMARY_OUTPUT_TOKENS, SUMMARY_OUTPUT_TOKENS, Math.floor(budget * 0.4)),
    )
    const recentBudget = Math.min(config.tokens, budget - summaryOutput)
    const recent = trimSummaryHead(transcript, recentBudget, false, (text) => replacementTokens("", text))
    const previousWindow = checkpoint?.metadata?.["compaction.window"]
    const downsized =
      (input.replacedPrefixTokens ?? 0) > 0 ||
      (typeof previousWindow === "number" && previousWindow > context) ||
      (["model-changed", "provider-changed", "route-changed"].includes(triggerEstimate.fallback) &&
        PromptEstimate.withMargin(triggerEstimate) > context)
    const canSummarize = config.summarize && input.summaryAllowed !== false && !downsized && summaryOutput > 0
    const messageID = SessionMessage.ID.create()
    const decision = {
      "compaction.cause":
        reason === "manual" ? "manual" : input.overflowPromptTokens === undefined ? "threshold" : "overflow",
      "compaction.window": context,
      "compaction.threshold": threshold,
      "compaction.response.reserve": capacity.responseReserveTokens,
      "compaction.buffer": config.buffer,
      "compaction.keep.tokens": config.tokens,
      "compaction.replacement.budget": budget,
      "compaction.estimate": triggerEstimate.estimatedTokens,
      "compaction.estimate.margin": triggerEstimate.marginTokens,
      "compaction.estimate.with-margin": PromptEstimate.withMargin(triggerEstimate),
      "compaction.estimate.mode": triggerEstimate.confidence === "whole" ? "full" : "anchored",
      "compaction.anchor.reported": triggerEstimate.anchorReportedTokens,
      "compaction.anchor.delta": triggerEstimate.deltaTokens,
      "compaction.anchor.growth": Math.round(triggerEstimate.growth * 10_000) / 10_000,
      "compaction.anchor.low-confidence": triggerEstimate.confidence === "low",
      "compaction.anchor.fallback": triggerEstimate.fallback,
      "compaction.before.tokens": input.overflowPromptTokens ?? PromptEstimate.withMargin(triggerEstimate),
      "compaction.entries": input.entries.length,
    }
    yield* dependencies.events.publish(
      SessionEvent.Compaction.Started,
      {
        sessionID: input.sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        reason,
      },
      { metadata: decision },
    )
    const prefixSeq = input.entries.reduce((highest, entry) => Math.max(highest, entry.seq), 0)
    const prefixHash = yield* dependencies.prefixHash(input.sessionID, prefixSeq)
    let why: DeclineReason = !config.summarize
      ? "prune-only"
      : input.summaryAllowed === false
        ? "summarizer-backoff"
        : "context-too-small"
    let summary = ""
    let retained = trimSummaryHead(transcript, budget, false, (text) => replacementTokens("", text))
    let mode: Outcome["mode"] = "deterministic"
    let generatedChars = 0
    const promptCeiling = summarizeInputCeiling(context, summaryOutput, config.summarizeInput)
    if (canSummarize) {
      // One bounded prefill and one answer at any context size. Evidence precedes the operation.
      // The complete evidence stays in the archive when a 1M transcript exceeds this prefill cap.
      const requestFor = (evidence: string) =>
        LLM.request({
          model: input.model,
          messages: [Message.user(buildPrompt({ previousSummary: checkpoint?.summary, context: [evidence] }))],
          tools: [],
          generation: { maxTokens: summaryOutput },
        })
      const evidence = trimSummaryHead(
        [checkpoint?.recent ?? "", ...entries.map((entry) => serializeMessage(entry.message))]
          .filter(Boolean)
          .join("\n\n"),
        promptCeiling,
        false,
        (text) => PromptEstimate.whole(requestFor(text), input.imagePatchPixels),
        HISTORY_HEAD_REMOVED,
      )
      const request = requestFor(evidence)
      if (!evidence || PromptEstimate.whole(request, input.imagePatchPixels) > promptCeiling) {
        why = "transcript-too-large"
      } else {
        const answer = yield* summarize({
          request,
          model: input.model,
          outputTokens: summaryOutput,
          sessionID: input.sessionID,
          messageID,
          maintenance: input.maintenance,
          guard: input.guard,
        })
        generatedChars = answer.generatedChars
        const candidateTokens = replacementTokens(answer.text, recent)
        if (answer.overBudget) why = "summary-unusable"
        else if (!answer.completed || answer.failed || !answer.text.trim()) why = "summarizer-unavailable"
        else if (
          answer.finish !== "stop" ||
          !summaryWithinBudget(answer.text, summaryOutput, answer.reportedTokens) ||
          candidateTokens >= before ||
          candidateTokens > budget
        )
          why = "summary-unusable"
        else {
          summary = answer.text
          retained = recent
          mode = "semantic"
        }
        if (mode === "deterministic" && why === "summary-unusable")
          yield* Log.event("session.compaction.summary.truncated", {
            "session.id": String(input.sessionID),
            "compaction.output.cap": summaryOutput,
            "compaction.summary.chars": answer.generatedChars,
          })
      }
    }
    const after = replacementTokens(summary, retained)
    if (after >= before || after > budget) {
      yield* dependencies.events.publish(SessionEvent.Compaction.Ended, {
        sessionID: input.sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        reason,
        text: "",
        recent: "",
        prefixSeq,
        prefixHash,
        failure: "nothing-to-fold",
        generatedChars,
      })
      return decline("nothing-to-fold")
    }
    const saved =
      input.scratchFolder === undefined
        ? undefined
        : yield* saveFoldedChat({
            scratchFolder: input.scratchFolder,
            text: original,
            sessionID: input.sessionID,
            at: archiveAt,
            id: archiveID,
          })
    yield* dependencies.events.publish(
      SessionEvent.Compaction.Ended,
      {
        sessionID: input.sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        reason,
        text: summary,
        recent: retained,
        prefixSeq,
        prefixHash,
        generatedChars,
      },
      {
        metadata: {
          ...decision,
          "compaction.mode": mode,
          ...(mode === "deterministic" ? { "compaction.deterministic.reason": why } : {}),
          "compaction.after.tokens": after,
          "compaction.folded.chars": original.length,
          "compaction.folded.file": saved ?? null,
          "compaction.summarize.input": promptCeiling,
          "compaction.summary.chars": summary.length,
          "compaction.recent.chars": retained.length,
        },
      },
    )
    input.onOutcome?.({ mode, ...(mode === "deterministic" ? { reason: why } : {}) })
    return true
  })
  const compactIfNeeded = Effect.fn("SessionCompaction.compactIfNeeded")(function* (input: Input) {
    // The trigger's own three exits report through the same channel as the nine below it, so a
    // caller that wants to explain a decline never has to know which of the two functions declined.
    const decline = (why: DeclineReason) => {
      input.onDecline?.(why)
      return false
    }
    if (!config.auto) return decline("auto-disabled")
    const context = input.contextWindowTokens ?? input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return decline("context-window-unknown")
    const output = ContextBudget.outputTokens(
      context,
      input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output,
    )

    const promptEstimate = input.promptEstimate ?? PromptEstimate.unsupported(input.request, input.imagePatchPixels)
    const estimated = promptEstimate.estimatedTokens
    const estimatedWithMargin = PromptEstimate.withMargin(promptEstimate)
    const promptCapacity = PromptEstimate.capacity({
      contextTokens: context,
      outputTokens: output,
      minimumResponseReserveTokens: config.buffer,
    })
    // Never zero on a working window — see `triggerAt`. A ceiling of zero would make
    // `estimatedWithMargin > 0` true on every turn: a trigger that fires forever and folds nothing,
    // which is what a compaction loop looks like from the inside. The configured percentage is the
    // other bound: a large one can only lower the trigger to the reserve ceiling, never raise it.
    const threshold = triggerAt({
      context,
      promptCeilingTokens: promptCapacity.promptCeilingTokens,
      thresholdPercent: config.threshold,
    })
    yield* Log.event("session.compaction.threshold", {
      "session.id": String(input.sessionID),
      "compaction.estimated": estimated,
      "compaction.estimation.margin": promptEstimate.marginTokens,
      "compaction.estimated-with-margin": estimatedWithMargin,
      "compaction.estimate.mode": promptEstimate.confidence === "whole" ? "full" : "anchored",
      "compaction.heuristic": promptEstimate.heuristicTokens,
      "compaction.anchor.reported": promptEstimate.anchorReportedTokens,
      "compaction.anchor.heuristic": promptEstimate.anchorHeuristicTokens,
      "compaction.anchor.delta": promptEstimate.deltaTokens,
      "compaction.anchor.growth": Math.round(promptEstimate.growth * 10_000) / 10_000,
      "compaction.anchor.low-confidence": promptEstimate.confidence === "low",
      "compaction.anchor.fallback": promptEstimate.fallback,
      "compaction.response.reserve": promptCapacity.responseReserveTokens,
      // Cache retention is a performance preference, never a semantic context ceiling. Keep it in
      // telemetry without feeding it into the trigger calculation.
      "compaction.prefix-cache.retention": input.prefixCacheRetentionTokens ?? 0,
      "compaction.threshold": threshold,
      "compaction.fires": estimatedWithMargin > threshold,
    })
    if (estimatedWithMargin <= threshold) return decline("under-threshold")
    // ⚠️ A backoff silences the SPEND, not the FOLD. It used to decline here entirely, which left an
    // over-threshold chat exactly as it was — the state the owner's never-fail rule forbids. The backoff
    // now rides through to `compactAfterOverflow`, which skips the summary and takes the deterministic
    // path: the chat shrinks, and no provider call is spent. See `Input.summaryAllowed`.
    // The cheap tier runs inside `compactAfterOverflow`, ahead of the summary prompt — the
    // threshold test above reads the ALREADY-ASSEMBLED request, which prune cannot shrink.
    return yield* compactAfterOverflow(input)
  })
  return {
    compactIfNeeded,
    compactAfterOverflow,

    settings: config,
  }
}
