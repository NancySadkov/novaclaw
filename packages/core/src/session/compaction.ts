export * as SessionCompaction from "./compaction"

import { LLM, LLMError, LLMEvent, Message, type FinishReason, type LLMRequest, type Model } from "@novaclaw/llm"
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
import { Log } from "@novaclaw/schema/log"
import { ReasoningBudget } from "./runner/reasoning-budget"
import { FinishRecovery } from "./runner/finish-recovery"
import { PromptEstimate } from "./runner/prompt-estimate"
import { Flag } from "../flag/flag"
import { SessionScheduler } from "./scheduler"
import { PostfixPrompt } from "./runner/postfix-prompt"

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
const SUMMARY_HEAD_REMOVED = "[Older summary content removed to fit the summary budget.]"
/**
 * The INPUT counterpart of the constant above, and deliberately a SECOND string: one marks a summary
 * that outgrew its output budget, the other marks a transcript that outgrew one summarization pass.
 * Sharing a sentence would make the two indistinguishable in the one place they are ever read — a
 * durable summary somebody is trying to explain.
 */
const HISTORY_HEAD_REMOVED =
  "[Older conversation omitted here: it did not fit a single summarization pass. It stays searchable through this colleague's memory.]"

/**
 * THINKING CEILING FOR THE SUMMARY — owner ask 2026-08-29: *"generate it the same way we generate
 * task title ... otherwise we can't depend on it at all and it is like playing casino"*.
 *
 * 🔴 **This was the ONLY model call in the product with no thinking bound of either kind** — neither
 * the harness-side `ReasoningBudget` nor the provider-side `UtilityPass.NO_THINKING` that
 * `maintenance.ts` and `judgeCompletion` carry. Every other call had one; compaction ran open.
 *
 * ⭐ **`ReasoningBudget` and not `NO_THINKING`, deliberately.** A title is one line and a verdict is
 * yes/no, so those callers can have thinking switched off outright. A compaction summary has to
 * preserve architectural decisions and unresolved bugs across a whole transcript — that IS a
 * reasoning task, and disabling it is an unmeasured quality trade. The controller bounds the THINK
 * and leaves the answer alone: its budget is enforced at a mid-stream checkpoint, **never by
 * `max_tokens`**, so *"an answer that starts inside a phase always completes rather than being
 * guillotined"*, and its hard stop re-issues with thinking structurally disabled only as a last
 * resort. Its stated invariant is the point of this change: **every phase has a finite ceiling and
 * the chain is finite, so the call always terminates.**
 *
 * ⚠️ **128 is a FIRST value, not a measured optimum**, and it is a knob for exactly that reason — the
 * same treatment `ABSORB_REASONING_BUDGET` gives its own. The recorded sweep that motivates the size
 * (2026-08-12 chat-mode eval) is: **18/24 at a 300-token budget, 24/24 at 2,048**. Compaction is a
 * harder judgement than either the 128-token title or absorb's 512. The former 2,048 default was
 * impossible to spend inside the callout's hard bound at the 1–2 t/s observed during the live
 * Geryon fan-out; the controller timed out without an answer on every tool turn. **A budget reported
 * without being swept is a number about the harness, not the model.**
 */
export const COMPACTION_REASONING_BUDGET = ((): number => {
  const raw = Number(Flag.NOVACLAW_COMPACTION_BUDGET)
  return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : 128
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
  readonly scheduler?: SessionScheduler.Interface
}

type Input = {
  readonly sessionID: SessionSchema.ID
  readonly entries: readonly Entry[]
  readonly model: Model
  readonly request: LLMRequest
  readonly promptEstimate?: PromptEstimate.Result
  /** Resolved patch side for this exact model/server route; absent keeps the measured default. */
  readonly imagePatchPixels?: number
  /** Exact-route prompt prefix known to remain reusable; absent keeps the context-only guard. */
  readonly prefixCacheRetentionTokens?: number
  /** Empirically honoured window for this exact serving route; overrides an optimistic catalog. */
  readonly contextWindowTokens?: number
  /** Admission identity for this decode-shaped maintenance pass. */
  readonly maintenance?: SessionScheduler.MaintenanceInput
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
}

/**
 * 🔴 **WHY A DECLINE HAS A NAME.**
 *
 * `compactIfNeeded` was deliberately given the *"say what this guard measured, every turn"*
 * treatment, because a guard that returns `false` silently leaves no trace and cost a reverted
 * change plus three withdrawn mechanisms. `compactAfterOverflow` was not, and it declines through
 * nine separate branches. Eight of them emitted nothing at all.
 *
 * ⭐ **The sharp edge is not the silence, it is what the silence let the CALLER say.** The manual
 * `/compact` cycle reads a bare `false` and tells the user *"the conversation is still small enough
 * that there is nothing to fold up, or the summary model was unavailable"* — a specific cause the
 * caller never established, and the exact inverse of some of these branches. **A message may not
 * assert a cause the code that emits it did not learn** (ruling 2: a fault is never described
 * falsely). This union is that learning, and `declineNotice` is the only sentence allowed to be
 * built from it.
 */
export type DeclineReason =
  /** The route declares no usable context window, so there is no budget to compact against. */
  | "context-window-unknown"
  /** `compaction.auto` is off: the automatic trigger is not allowed to fire at all. */
  | "auto-disabled"
  /** `compaction.summarize` is off: the cheap prune ran and stopping there is the setting working. */
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
      return "⚠️ Compaction didn't summarise — this chat is set to prune stale tool output only. Stale output was reclaimed; no summary was written."
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
  }
}

/**
 * Token estimate for an assembled request.
 *
 * ⚠️ Exported as a SEAM, the same reason `serializeMessage` below is: the media rule is the whole
 * point and cannot be asserted through `compactIfNeeded` without building a model route, a request
 * and a config just to read one number back out of a boolean.
 *
 * 🔴 The media-aware logic lives in `util/token.ts` because THREE call sites needed it and each had
 * written `estimate(JSON.stringify(value))` independently — see `Token.estimateStructured`.
 */
export const estimate = (value: unknown, imagePatchPixels?: number) => Token.estimateStructured(value, imagePatchPixels)

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
 * Translate the recovery policy's whole-request cut into the compactor's verbatim-tail budget.
 * Static system/tool framing and the replacement summary are measured again by the runner before
 * any resend, so this is intentionally one-sided: reclaim at least the requested delta from the
 * configurable recent tail, then let the exact assembled-request guard decide whether it is enough.
 */
export const overflowRecentBudget = (input: {
  readonly configuredRecentTokens: number
  readonly originalPromptTokens?: number
  readonly targetPromptTokens?: number
}): number => {
  if (
    !Number.isSafeInteger(input.configuredRecentTokens) ||
    input.configuredRecentTokens < 0 ||
    !Number.isSafeInteger(input.originalPromptTokens) ||
    input.originalPromptTokens! <= 0 ||
    !Number.isSafeInteger(input.targetPromptTokens) ||
    input.targetPromptTokens! <= 0 ||
    input.targetPromptTokens! >= input.originalPromptTokens!
  )
    return Math.max(0, input.configuredRecentTokens)
  const requiredReclaim = input.originalPromptTokens! - input.targetPromptTokens!
  return Math.max(0, input.configuredRecentTokens - requiredReclaim)
}

/** The operation appended AFTER its evidence. Never put this in `system`: a derived pass must retain
 * the working request as its exact provider prefix, and a sequential model should encounter the
 * current instruction after the events it is asked to interpret. */
export const buildInstruction = (previousSummary?: string, evidence: "history" | "prefix" = "history") => {
  const source = evidence === "prefix" ? "the conversation above" : "the conversation history in <history>"
  return [
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

/** Standalone fallback for callers that do not carry an assembled provider request. Evidence still
 * precedes the operation, so even the cache-miss path keeps the sequential reading invariant. */
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

/**
 * Last-resort deterministic fallback after the model has already had one semantic summary pass.
 * Keep the newest/Tail facts and remove the oldest/Head facts. The omission marker is model-visible;
 * when even that marker cannot fit, the suffix alone is preferable to lying about a complete summary.
 *
 * The cut is tested through `Token.estimate` itself, not a `chars * 4` surrogate. That distinction
 * matters for dense structure, paths, digits, high-entropy strings, and non-ASCII text.
 */
export const trimSummaryHead = (text: string, budgetTokens: number, markLoss = false) => {
  const value = text.trimEnd()
  if (!value || !Number.isFinite(budgetTokens) || budgetTokens <= 0) return ""
  const fits = (candidate: string) => Token.estimate(candidate) <= budgetTokens
  if (!markLoss && fits(value)) return value

  // Search by Unicode scalar rather than UTF-16 code unit so the kept tail never begins with half
  // a surrogate pair. Mechanical recovery is allowed to lose the oldest prose, not corrupt the
  // newest identifier or emoji into an invalid string.
  const scalars = Array.from(value)

  const withMarker = (length: number) =>
    length <= 0 ? SUMMARY_HEAD_REMOVED : `${SUMMARY_HEAD_REMOVED}\n${scalars.slice(scalars.length - length).join("")}`
  const markerFits = fits(SUMMARY_HEAD_REMOVED)
  let low = 0
  let high = scalars.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const candidate = markerFits ? withMarker(middle) : scalars.slice(scalars.length - middle).join("")
    if (fits(candidate)) low = middle
    else high = middle - 1
  }
  if (low === 0) return markerFits ? SUMMARY_HEAD_REMOVED : ""
  return markerFits ? withMarker(low) : scalars.slice(scalars.length - low).join("")
}

export const make = (dependencies: Dependencies) => {
  const config = settings(dependencies.config)
  const summarize = Effect.fn("SessionCompaction.summarize")(function* (input: {
    readonly request: LLMRequest
    readonly preservesWorkingPrefix?: boolean
    readonly model: Model
    readonly outputTokens: number
    readonly sessionID: SessionSchema.ID
    readonly messageID: SessionMessage.ID
    readonly maintenance?: SessionScheduler.MaintenanceInput
  }) {
    const chunks: string[] = []
    let generatedChars = 0
    let checkpointChars = 0
    let checkpointAt = Date.now()
    let failed = false
    let finish: FinishReason | undefined
    let reportedTokens: number | undefined
    const deltaTimestamp = yield* DateTime.now
    const generation = ReasoningBudget.stream({
      request: input.request,
      // The request already contains the working turn's reasoning envelope. Appending another
      // system part here would move the divergence point to token zero and defeat postfix framing.
      ...(input.preservesWorkingPrefix ? { preparedOpening: input.request } : {}),
      stream: (request) => dependencies.llm.stream(request),
      budget: COMPACTION_REASONING_BUDGET,
    }).pipe(
      Stream.runForEach((event) => {
        if (LLMEvent.is.providerError(event)) failed = true
        if (LLMEvent.is.textDelta(event)) {
          chunks.push(event.text)
          generatedChars += event.text.length
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
      Effect.catchTag("LLM.Error", () => Effect.succeed(false)),
    )
    const completed = yield* dependencies.scheduler !== undefined && input.maintenance !== undefined
      ? SessionScheduler.runMaintenance(dependencies.scheduler, input.maintenance, generation, Effect.succeed(false))
      : generation
    return { text: chunks.join(""), completed, failed, finish, reportedTokens, generatedChars } as const
  })
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
  // `reason` threads into the Compaction.Started/Ended events: "auto" for the runner's overflow /
  // threshold paths (the default keeps every existing caller unchanged), "manual" for the
  // user-requested compact cycle (SessionV2.compact → the runner's SessionCompactionRequest marker).
  const compactAfterOverflow = Effect.fn("SessionCompaction.compactAfterOverflow")(function* (
    input: Input,
    reason: "auto" | "manual" = "auto",
  ) {
    // ⚠️ EVERY exit from this function goes through here. A bare `return false` is the defect this
    // block exists to close: it is shorter to type than the honest one, which is exactly why it won
    // eight times, and it hands the caller a value that cannot distinguish a healthy decline from a
    // wedged chat. See `DeclineReason`.
    const decline = (why: DeclineReason) => {
      input.onDecline?.(why)
      return false
    }
    const context = input.contextWindowTokens ?? input.model.route.defaults.limits?.context
    if (context === undefined || context <= 0) return decline("context-window-unknown")
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    const entries = yield* pruneCheapTier(input.entries, input.imagePatchPixels)
    // PRUNE ONLY (`compaction.summarize: false`). The cheap tier has already run and its reclaim is
    // durable for this cycle; stopping here is the whole point of the setting. Returning `false`
    // means "no compaction message was written", which is exactly true — and the caller's contract
    // is already that a declined cycle leaves the transcript alone.
    //
    // ⚠️ Deliberately AFTER the prune, not instead of it: the reclaim is the part worth having, and
    // gating the tier itself is what `prune: false` already does.
    if (!config.summarize) {
      yield* Log.event("session.compaction.prune.only", { "session.id": input.sessionID })
      return decline("prune-only")
    }
    const selected = selectContext(
      entries,
      overflowRecentBudget({
        configuredRecentTokens: config.tokens,
        originalPromptTokens: input.overflowPromptTokens,
        targetPromptTokens: input.overflowTargetTokens,
      }),
    )
    const previousSummary = entries.find((entry) => entry.message.type === "compaction")?.message
    if (!selected || (selected.head.length === 0 && previousSummary?.type !== "compaction"))
      return decline("nothing-to-fold")
    const carriedSummary = previousSummary?.type === "compaction" ? previousSummary.summary : undefined
    const carriedRecent = previousSummary?.type === "compaction" ? previousSummary.recent : ""
    const promptFor = (head: string) =>
      buildPrompt({ previousSummary: carriedSummary, context: [carriedRecent, head].filter(Boolean) })
    const requestedSummaryOutput = Math.min(output || SUMMARY_OUTPUT_TOKENS, SUMMARY_OUTPUT_TOKENS)
    // One semantic pass gets the declared output budget. If a server ignores that budget, recovery
    // is deterministic: trim the oldest generated summary text. A second model pass used to double
    // the decode work and could itself inflate the context it was meant to rescue.
    if (requestedSummaryOutput >= context) return decline("context-too-small")
    const summaryOutput = requestedSummaryOutput
    if (summaryOutput <= 0) return decline("context-too-small")
    /**
     * 🔴 **A TRANSCRIPT TOO LARGE TO SUMMARIZE USED TO BE A DEAD END.**
     *
     * This guard was `if (estimate(prompt) > context - summaryOutput) return false`, and it fires
     * exactly when the head is bigger than one summarization pass — which is reachable on the
     * overflow-recovery path, where `overflowRecentBudget` shrinks the verbatim TAIL while the head
     * is whatever is left. The session is then over its ceiling with compaction refusing to run, so
     * every subsequent turn overflows: the one state a compactor exists to prevent, entered by the
     * compactor declining.
     *
     * ⭐ **Dropping the OLDEST head is the same trade the rest of this file already makes** —
     * `trimSummaryHead` cuts an oversized summary from the front under `SUMMARY_HEAD_REMOVED`, and
     * `overflowRecentBudget` cuts the tail. Oldest-first, halving, bounded, and the dropped span is
     * not lost: `archiveCompactedChat` writes the compacted entries into this colleague's memory as
     * passages before the overlay commits, so `kb search` still reaches them.
     *
     * The loop is finite by construction (each pass halves, and zero terminates it), so this cannot
     * become an unbounded self-edit — the same property the summarize/trim chain below is built on.
     */
    const promptCeiling = context - summaryOutput
    let keptHeadChars = selected.head.length
    let head = selected.head
    let summaryPrompt = promptFor(head)
    while (keptHeadChars > 0 && Token.estimate(summaryPrompt) > promptCeiling) {
      keptHeadChars = Math.floor(keptHeadChars / 2)
      head = keptHeadChars === 0 ? "" : `${HISTORY_HEAD_REMOVED}\n\n${selected.head.slice(-keptHeadChars)}`
      summaryPrompt = promptFor(head)
    }
    // Still over with nothing left to give: the window cannot hold the template plus the carried
    // summary, so no amount of trimming this chat helps and the user must be told THAT.
    if (Token.estimate(summaryPrompt) > promptCeiling) return decline("transcript-too-large")
    if (head.length === 0 && carriedSummary === undefined) return decline("transcript-too-large")
    // ⚠️ NOT logged through `session.compaction.summary.truncated` — that key names the SUMMARY
    // overrunning its output budget, and borrowing it for a trimmed INPUT would make the one number
    // it reports mean two things. The trim announces itself where it matters instead: the marker
    // rides the prompt the model is sent, so it is visible in the request the tests pin.
    const messageID = SessionMessage.ID.create()
    const startedAt = yield* DateTime.now
    yield* dependencies.events.publish(SessionEvent.Compaction.Started, {
      sessionID: input.sessionID,
      messageID,
      timestamp: startedAt,
      reason,
    })

    const fail = Effect.fnUntraced(function* (why: DeclineReason, generatedChars: number) {
      yield* dependencies.events.publish(SessionEvent.Compaction.Ended, {
        sessionID: input.sessionID,
        messageID,
        timestamp: yield* DateTime.now,
        reason,
        text: "",
        recent: "",
        prefixSeq: 0,
        prefixHash: "",
        failure: why,
        generatedChars,
      })
      return decline(why)
    })

    // The chain is deliberately finite: one semantic summary followed, only if its token budget is
    // violated, by a deterministic oldest-first cut. There is no wall-clock deadline: observable
    // token progress is useful work, and interrupting it merely discards that work.
    // When the runner supplied its assembled request, preserve that exact request at the front and
    // append only the summarization operation. Direct compactor callers without provider history use
    // the serialized history as their evidence prefix; the instruction is still last.
    const cachedPrefixRequest =
      input.request.messages.length > 0
        ? PostfixPrompt.append(input.request, buildInstruction(carriedSummary, "prefix"), {
            maxTokens: summaryOutput,
            disableTools: true,
          })
        : undefined
    const summaryRequest =
      cachedPrefixRequest !== undefined &&
      Token.estimateStructured(LLM.requestInput(cachedPrefixRequest)) <= promptCeiling
        ? cachedPrefixRequest
        : LLM.request({
            model: input.model,
            messages: [Message.user(summaryPrompt)],
            tools: [],
            generation: { maxTokens: summaryOutput },
          })
    const first = yield* summarize({
      request: summaryRequest,
      preservesWorkingPrefix: summaryRequest === cachedPrefixRequest,
      model: input.model,
      outputTokens: summaryOutput,
      sessionID: input.sessionID,
      messageID,
      maintenance: input.maintenance,
    })
    if (!first.completed || first.failed || !first.text.trim())
      return yield* fail("summarizer-unavailable", first.generatedChars)
    const firstFits = summaryWithinBudget(first.text, summaryOutput, first.reportedTokens)
    const firstClean = first.finish === "stop" && firstFits
    let summary = first.text
    if (!firstClean) {
      const budgetCut = FinishRecovery.isTruncated(first.finish) || (first.finish === "stop" && !firstFits)
      if (!budgetCut) return yield* fail("summary-unusable", first.generatedChars)
      yield* Log.event("session.compaction.summary.truncated", {
        "session.id": String(input.sessionID),
        "compaction.output.cap": summaryOutput,
        "compaction.summary.chars": first.text.length,
      })
      // A provider-reported length cut can fit the estimate while still ending mid-summary. Mark
      // that loss inside the summary itself, then keep as much of the newest generated tail as the
      // declared budget allows. An over-budget stop follows the same deterministic path.
      summary = trimSummaryHead(first.text, summaryOutput, true)
    }
    if (!summary.trim()) return yield* fail("summarizer-unavailable", first.generatedChars)
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
      generatedChars: first.generatedChars,
    })
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
    const output = input.request.generation?.maxTokens ?? input.model.route.defaults.limits?.output ?? 0
    /**
     * 🔴 **SAY WHAT THIS GUARD MEASURED, EVERY TURN, WHETHER OR NOT IT FIRES.**
     *
     * Across five recorded sweeps — 3,055 messages, 33 sessions — the session stores hold **ZERO**
     * rows of type `compaction`. Nothing has ever compacted, and until this line there was no way to
     * see why: a guard that returns `false` silently leaves no trace, so the only evidence anybody
     * had was a rig counter that fired on a `limit=200` message window sliding and reported
     * compactions that never happened.
     *
     * ⚠️ **That counter is why a summary-template reorder was reverted on 2026-08-26** (*"0
     * compactions against 8 in the run before it"*) and why three separate mechanisms were proposed
     * and withdrawn for a slowdown it appeared to explain. **One number, at the point the guard
     * computes it, settles all of that** — and it costs a `debug` line per turn.
     *
     * ⚠️ Logged BEFORE the early return, deliberately: the interesting case is the one that declines.
     */
    const promptEstimate = input.promptEstimate ?? PromptEstimate.unsupported(input.request, input.imagePatchPixels)
    const estimated = promptEstimate.estimatedTokens
    const estimatedWithMargin = PromptEstimate.withMargin(promptEstimate)
    const promptCapacity = PromptEstimate.capacity({
      contextTokens: context,
      outputTokens: output,
      minimumResponseReserveTokens: config.buffer,
    })
    const threshold = promptCapacity.promptCeilingTokens
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
    // The cheap tier runs inside `compactAfterOverflow`, ahead of the summary prompt — the
    // threshold test above reads the ALREADY-ASSEMBLED request, which prune cannot shrink.
    return yield* compactAfterOverflow(input)
  })
  return {
    compactIfNeeded,
    compactAfterOverflow,
  }
}
