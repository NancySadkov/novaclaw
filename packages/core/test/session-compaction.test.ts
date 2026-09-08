import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { ColleagueNote } from "@novaclaw/core/session/colleague-note"
import { SessionCompaction } from "@novaclaw/core/session/compaction"
import type { Config } from "@novaclaw/core/config"
import type { EventV2 } from "@novaclaw/core/event"
import { SessionEvent } from "@novaclaw/core/session/event"
import { applySteerProvenance, STEER_PROVENANCE_PREFIX } from "@novaclaw/core/session/steer-provenance"
import type { SessionMessage } from "@novaclaw/core/session/message"
import type { SessionSchema } from "@novaclaw/core/session/schema"
import { LLM, LLMEvent, Message, Model, SystemPart, type LLMRequest } from "@novaclaw/llm"
import * as OpenAIChat from "@novaclaw/llm/protocols/openai-compatible-chat"
import { Effect, Stream } from "effect"

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      uri: `data:image/png;base64,${base64}`,
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
})

// ── B2 follow-up: compaction was the SEVENTH unfiltered user-role read ──────────────────────────
//
// A harness steer (doom-loop redirect, quality nudge, introspection prompt) is authored by the
// harness but rides the `user` role into the transcript; the 1N provenance prefix is the only thing
// that marks it. `serializeMessage` used to render every user-role message as `[User]: …`, so the
// harness's own instruction text was handed to the summarizer as something the USER said — and the
// summary is DURABLE, so the misattribution outlived the turn that produced it (the template even
// has a "Constraints & Preferences — user constraints" section for it to land in).
//
// The fix RELABELS rather than drops, matching the renderer (`session-ui`'s `SteerMessage`): the
// redirect is real history that explains why the assistant changed course, so the summarizer keeps
// it — under a speaker label that is unmistakably not the user.

const user = (text: string): SessionMessage.Message => ({ type: "user", text }) as unknown as SessionMessage.Message

test("overflow recovery translates the fixed whole-request cut into a smaller recent tail", () => {
  expect(
    SessionCompaction.overflowRecentBudget({
      configuredRecentTokens: 8_000,
      originalPromptTokens: 32_000,
      targetPromptTokens: 24_000,
    }),
  ).toBe(0)
  expect(
    SessionCompaction.overflowRecentBudget({
      configuredRecentTokens: 8_000,
      originalPromptTokens: 20_000,
      targetPromptTokens: 15_000,
    }),
  ).toBe(3_000)
})
const steer = (text: string): SessionMessage.Message => user(applySteerProvenance(text))
const assistant = (text: string): SessionMessage.Message =>
  ({ type: "assistant", content: [{ type: "text", text }] }) as unknown as SessionMessage.Message
const entries = (...messages: SessionMessage.Message[]): SessionCompaction.Entry[] =>
  messages.map((message, seq) => ({ seq, message }))

/** The wording of a real doom-loop nudge, so the fixture cannot drift from the thing detected. */
const NUDGE = "You have called `bash` with identical arguments 3 times in a row. Stop repeating it."

describe("a steer is never attributed to the user in the compaction summary", () => {
  test("serializeMessage labels a steer as an automated check, not as [User]", () => {
    const line = SessionCompaction.serializeMessage(steer(NUDGE))
    expect(line).not.toContain("[User]:")
    expect(line).toContain("Automated")
    // The label carries the provenance, so the prefix is not repeated inside the body.
    expect(line).not.toContain(STEER_PROVENANCE_PREFIX)
    // Relabelled, NOT dropped — the redirect itself survives into the summary.
    expect(line).toContain("Stop repeating it")
  })

  test("a real user turn is still [User], and its files still ride along", () => {
    expect(SessionCompaction.serializeMessage(user("count the digits of pi"))).toBe("[User]: count the digits of pi")
    const withFile = {
      type: "user",
      text: "look at this",
      files: [{ mime: "image/png", name: "pixel.png", uri: "data:image/png;base64,AAAA" }],
    } as unknown as SessionMessage.Message
    expect(SessionCompaction.serializeMessage(withFile)).toBe("[User]: look at this\n[Attached image/png: pixel.png]")
  })

  test("the steer label is distinct from every other speaker label", () => {
    const labels = [
      SessionCompaction.serializeMessage(steer(NUDGE)),
      SessionCompaction.serializeMessage(user("hi")),
      SessionCompaction.serializeMessage(assistant("hello")),
      SessionCompaction.serializeMessage({ type: "system", text: "note" } as unknown as SessionMessage.Message),
      SessionCompaction.serializeMessage({ type: "synthetic", text: "note" } as unknown as SessionMessage.Message),
    ].map((line) => line.slice(0, line.indexOf("]:") + 2))
    expect(new Set(labels).size).toBe(labels.length)
    expect(labels).toContain("[User]:")
    expect(labels).toContain("[System update]:")
  })

  test("neither durable half of the split — the summarized head nor the retained recent — says [User] about a steer", () => {
    // `head` feeds the summary prompt; `recent` is stored verbatim on the compaction message and is
    // re-fed as context on the NEXT compaction, so a misattribution there compounds.
    const transcript = entries(
      user("count the digits of pi"),
      assistant("Earlier answer"),
      steer(NUDGE),
      assistant("Continuing with a different approach"),
    )
    const wide = SessionCompaction.selectContext(transcript, 100_000)
    const narrow = SessionCompaction.selectContext(transcript, 1)
    for (const selected of [wide, narrow]) {
      expect(selected).toBeDefined()
      const both = `${selected!.head}\n${selected!.recent}`
      expect(both).not.toContain(`[User]: ${STEER_PROVENANCE_PREFIX}`)
      expect(both).not.toContain(STEER_PROVENANCE_PREFIX)
      expect(both).toContain("[User]: count the digits of pi")
    }
    // The whole transcript fits in the wide budget, so nothing is split off: the steer is present
    // (relabelled) and the assistant text that FOLLOWED it is still attached to this exchange.
    expect(wide!.recent).toContain("Stop repeating it")
    expect(wide!.recent).toContain("Continuing with a different approach")
    expect(wide!.head).toBe("")
  })

  test("the cut point stays on a completed assistant-turn boundary", () => {
    const transcript = entries(
      user("old question"),
      assistant("old answer"),
      user(`new question ${"detail ".repeat(200)}`),
      assistant("new answer"),
    )
    const selected = SessionCompaction.selectContext(transcript, 20)
    expect(selected).toBeDefined()
    expect(selected!.head).toContain("old question")
    expect(selected!.head).toContain("old answer")
    expect(selected!.recent).toContain("new question")
    expect(selected!.recent).toContain("new answer")
    // No message is token-sliced: both durable halves contain whole model-visible messages.
    expect(`${selected!.head}\n${selected!.recent}`.split("new question").length - 1).toBe(1)
  })

  test("a steer-only transcript contributes no user-attributed text at all", () => {
    const selected = SessionCompaction.selectContext(entries(steer(NUDGE)), 100_000)
    expect(selected).toBeDefined()
    expect(`${selected!.head}\n${selected!.recent}`).not.toContain("[User]:")
  })
})

describe("a colleague is never attributed to the user either", () => {
  const peer = (text: string, over: Record<string, unknown> = {}): SessionMessage.Message =>
    ({
      type: "user",
      text,
      origin: { via: "agent", relation: "peer", label: "theron", sessionID: "ses_theron", ...over },
    }) as unknown as SessionMessage.Message

  test("🔴 a delivered peer message is labelled by WHO SAID IT, not [User]", () => {
    // A peer message IS a user-role message, so it took the `[User]` label — and after one
    // compaction a colleague's question reads as something the owner asked. Durable: nothing
    // downstream can recover who spoke. Same class as the steer label one describe block up.
    const line = SessionCompaction.serializeMessage(peer("did the quarter close?"))
    expect(line).not.toContain("[User]:")
    expect(line).toContain("[Colleague theron]:")
    expect(line).toContain("did the quarter close?")
  })

  test("a GROUP message says it was to the room — who spoke and who heard are different facts", () => {
    const line = SessionCompaction.serializeMessage(
      peer("did the quarter close?", { conversation: "cnv_1", participants: ["aris", "theron", "kallias"] }),
    )
    expect(line).toContain("[Colleague theron, to the room]:")
  })

  test("the reply note is STRIPPED — a route back is spent once the exchange is over", () => {
    // Otherwise the summary of a finished conversation carries a live tool instruction, and a group
    // note drags the whole roster in with it.
    const delivered = ColleagueNote.compose({ message: "the ledger balances", from: "theron", turn: "ask" })
    const line = SessionCompaction.serializeMessage(peer(delivered))
    expect(line).toContain("the ledger balances")
    expect(line).not.toContain("`colleague`")
    expect(line).not.toContain('op "ask"')
  })

  test("a colleague's own trailing bracket is NOT mistaken for a note", () => {
    // The strip matches the backticked tool name, not "ends with a bracket" — a colleague may
    // legitimately end on one, and eating its last line would be a silent edit of what it said.
    const line = SessionCompaction.serializeMessage(peer("see the table\n\n[row 3 is the one]"))
    expect(line).toContain("[row 3 is the one]")
  })

  test("the colleague label is distinct from the user and steer labels", () => {
    const labels = [
      SessionCompaction.serializeMessage(peer("x")),
      SessionCompaction.serializeMessage(user("x")),
      SessionCompaction.serializeMessage(steer(NUDGE)),
    ]
    expect(new Set(labels.map((line) => line.slice(0, line.indexOf("]") + 1))).size).toBe(3)
  })
})

// ── The auto-trigger has to SAY what it measured, and say it when it DECLINES ────────────────────
//
// 🔴 Across five recorded sweeps — 3,055 messages, 33 sessions — the stores hold ZERO rows of type
// `compaction`. Nothing has ever compacted. A guard that returns `false` silently leaves no trace, so
// the only evidence anybody had was a rig counter that fired on a 200-message poll window sliding.
// That counter is why a summary-template reorder was reverted on 2026-08-26 and why three mechanisms
// were proposed and withdrawn for a slowdown it seemed to explain.
//
// ⚠️ **The ordering is the whole point.** Move the log below the early return and it only ever fires
// on the case that has never happened — which is indistinguishable from deleting it. A behavioural
// test cannot see this: there is no log-capture seam in these fixtures, and the numbers are
// identical either way.
test("the compaction trigger logs what it measured BEFORE it declines", () => {
  const source = readFileSync(path.join(import.meta.dir, "..", "src", "session", "compaction.ts"), "utf8")
    .split("\n")
    .filter((line) => {
      const t = line.trimStart()
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*")
    })
    .join("\n")

  const logAt = source.indexOf('Log.event("session.compaction.threshold"')
  // Re-pointed, per this test's own instruction: the early return still exists, but it now names the
  // branch it took (`DeclineReason`) instead of returning a bare `false` the caller has to guess at.
  const returnAt = source.indexOf('if (estimatedWithMargin <= threshold) return decline("under-threshold")')
  expect(logAt, "the threshold log moved — re-point this test, do not delete it").toBeGreaterThan(-1)
  expect(returnAt, "the early return moved — re-point this test, do not delete it").toBeGreaterThan(-1)
  expect(logAt).toBeLessThan(returnAt)
  // And it must report BOTH sides plus the verdict: an estimate with no threshold beside it is a
  // number nobody can act on, which is the state this line exists to end.
  expect(source).toContain('"compaction.estimated": estimated')
  expect(source).toContain('"compaction.estimation.margin": promptEstimate.marginTokens')
  expect(source).toContain('"compaction.estimated-with-margin": estimatedWithMargin')
  expect(source).toContain('"compaction.estimate.mode":')
  expect(source).toContain('"compaction.anchor.delta": promptEstimate.deltaTokens')
  expect(source).toContain('"compaction.anchor.low-confidence": promptEstimate.confidence === "low"')
  expect(source).toContain('"compaction.response.reserve": promptCapacity.responseReserveTokens')
  expect(source).toContain('"compaction.prefix-cache.retention": input.prefixCacheRetentionTokens ?? 0')
  expect(source).toContain('"compaction.threshold": threshold')
  expect(source).toContain('"compaction.fires": estimatedWithMargin > threshold')
})

// ── The summary call goes through the thinking budget ────────────────────────────────────────────
//
// Owner, 2026-08-29: *"please ensure that we generate it the same way we generate task title …
// otherwise we can't depend on it at all and it is like playing casino or making sports bets"*.
//
// 🔴 Compaction was the ONLY model call in the product with no thinking bound of either kind — not
// the harness-side `ReasoningBudget`, not the provider-side `UtilityPass.NO_THINKING`. The inherited
// summariser did nothing about thinking AND called `Effect.die` on the empty completion a reasoning
// model returns when it burns its cap, so this was the one call that could neither bound the think
// nor survive it.
//
// ⚠️ A behavioural test cannot see this. Every compaction claim in this suite passes with the wrapper
// removed — the fixtures return canned events either way, and the budget only bites on a real long
// think. So the wiring is asserted at the call site.
test("the summary is generated through ReasoningBudget, with a declared budget", () => {
  const source = readFileSync(path.join(import.meta.dir, "..", "src", "session", "compaction.ts"), "utf8")
    .split("\n")
    .filter((line) => {
      const t = line.trimStart()
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*")
    })
    .join("\n")

  expect(source, "the summary call moved — re-point this test, do not delete it").toContain("summaryPrompt")
  expect(source).toContain("ReasoningBudget.stream({")
  expect(source).toContain("budget: COMPACTION_REASONING_BUDGET")
  // 🔴 And NOT a bare provider call for the summary: that is the state this replaced.
  expect(source).not.toContain("dependencies.llm\n      .stream(")
})

// ── "A token" is not one thing, and the only honest number is the provider's own ─────────────────
//
// Owner, 2026-08-29: *"different models, providers and model servers [have] different definitions of
// `token` … do we leave a bit of margin for the case when token is larger than our heuristics
// predicts, while the provider's api offers no good feedback?"*
//
// Estimation uncertainty now has its own adaptive margin, independent of the response reserve, but
// it can adapt only from exact-route provider feedback. The pair that feeds that calibration arrives
// on every response; it used to be discarded below the 95 % pressure tripwire, once safety had
// already failed.
//
// The provider-dispatch suite drives the callback with and without usage. This wiring ratchet keeps
// the runner on the exact request seen by that callback: using `packed.estimatedTokens` here compares
// message history alone with provider usage for system + messages + tool schemas.
test("the estimate-vs-provider ratio compares one exact provider request with its response", () => {
  const runner = readFileSync(path.join(import.meta.dir, "..", "src", "session", "runner", "llm.ts"), "utf8")
  const dispatch = readFileSync(
    path.join(import.meta.dir, "..", "src", "session", "runner", "provider-dispatch.ts"),
    "utf8",
  )

  expect(dispatch).toContain("LLMEvent.is.stepFinish(event)")
  expect(dispatch).toContain("providerMetadata: event.providerMetadata")
  const callback = "onProviderStep: ({ request: providerRequest, usage, providerMetadata, anchorable })"
  expect(runner).toContain(callback)
  expect(runner).toContain("PromptEstimate.whole(providerRequest, routeProfile.imagePatchPixels)")
  expect(runner).toContain("anchoredResidualRatios: routeProfile.promptResidualRatios")
  expect(runner).toContain("ProviderCapability.servingIdentityOf(providerMetadata)")
  expect(runner).toContain('"session.prompt.reported": reportedPrompt !== undefined')
  expect(runner).toContain('Log.event("session.context.estimate.drift"')
  const callbackAt = runner.indexOf(callback)
  const callbackEnd = runner.indexOf("// STEER INTERRUPT", callbackAt)
  expect(callbackAt).toBeGreaterThan(-1)
  expect(callbackEnd).toBeGreaterThan(callbackAt)
  const observation = runner.slice(callbackAt, callbackEnd)
  const routeObservationAt = observation.indexOf("const remember = comparable")
  expect(routeObservationAt).toBeGreaterThan(-1)
  expect(observation.slice(routeObservationAt)).toContain("routeProfileScope")
  expect(observation.slice(routeObservationAt)).toContain("estimatedTokens: estimatedPrompt")
  expect(observation).toContain('anchorable && providerEstimate.confidence !== "whole"')
  expect(observation).toContain("anchoredEstimatedTokens: anchoredEstimatedPrompt")
  // A successful response's prompt count is calibration evidence, not context-window evidence.
  // In particular, an ordinary request at half of the advertised window must not halve a shared
  // route profile and recursively poison every session using it.
  expect(observation).not.toContain("contextWindowTokens")
  expect(observation).not.toContain("TruncationDetection")
  expect(observation).not.toContain(".put(routeProfileScope")
  expect(observation).not.toContain('"session.estimated.tokens": packed.estimatedTokens')
})

test("overflow recovery measures the exact packed requests and resends at most once after a fixed cut", () => {
  const runner = readFileSync(path.join(import.meta.dir, "..", "src", "session", "runner", "llm.ts"), "utf8")
  const openingAt = runner.indexOf("const openingRequest = ProviderDispatch.openingRequest({")
  const estimateAt = runner.indexOf("const promptEstimate = PromptEstimate.resolve({", openingAt)
  const prepareAt = runner.indexOf("ProviderDispatch.prepare({", estimateAt)
  const compactionAt = runner.indexOf("compactIfNeeded({", prepareAt)
  const packedAt = runner.indexOf("const request = preparedDispatch.request")
  const measuredAt = runner.indexOf("const outboundPromptTokens = Math.ceil(", packedAt)
  const authorizeAt = runner.indexOf("OverflowRecoveryPolicy.authorizeRetry({", measuredAt)
  const providerAt = runner.indexOf("ProviderDispatch.stream({", authorizeAt)
  expect(openingAt).toBeGreaterThan(-1)
  expect(estimateAt).toBeGreaterThan(openingAt)
  expect(prepareAt).toBeGreaterThan(estimateAt)
  expect(compactionAt).toBeGreaterThan(prepareAt)
  expect(packedAt).toBeGreaterThan(compactionAt)
  expect(measuredAt).toBeGreaterThan(packedAt)
  expect(authorizeAt).toBeGreaterThan(measuredAt)
  expect(providerAt).toBeGreaterThan(authorizeAt)
  expect(runner.match(/ProviderDispatch\.openingRequest\(\{/g)).toHaveLength(1)
  expect(runner.slice(openingAt, estimateAt)).toContain("request: baseRequest")
  expect(runner.slice(estimateAt, prepareAt)).toContain("request: openingRequest")
  expect(runner.slice(prepareAt, packedAt)).toContain("request: openingRequest")
  expect(runner.slice(compactionAt, packedAt)).toContain("request: preparedDispatch.request")
  expect(runner.slice(measuredAt, authorizeAt)).toContain("PromptEstimate.whole(request")
  expect(runner.slice(providerAt)).toContain("preparedOpening: request")
  expect(runner.slice(authorizeAt, providerAt)).toContain("compressedPromptTokens: outboundPromptTokens")
  expect(runner.slice(authorizeAt, providerAt)).toContain("Stream.succeed(overflowRecovery!.failure)")

  const planAt = runner.indexOf("OverflowRecoveryPolicy.plan({")
  const compactAt = runner.indexOf("recoverOverflow({", planAt)
  const transitionAt = runner.indexOf("continueAfterOverflowCompaction(", compactAt)
  expect(planAt).toBeGreaterThan(providerAt)
  expect(compactAt).toBeGreaterThan(planAt)
  expect(transitionAt).toBeGreaterThan(compactAt)
  const recovery = runner.slice(planAt, transitionAt)
  expect(recovery).toContain("originalPromptTokens: outboundPromptTokens")
  expect(recovery).toContain("overflowPromptTokens: recoveryPlan.originalPromptTokens")
  expect(recovery).toContain("overflowTargetTokens: recoveryPlan.targetPromptTokens")
  expect(runner).toContain("runTurnAttempt(sessionID, harness, promotion, step, undefined, recovery, timing)")
})

// ── A summary has a finite, hard output chain ─────────────────────────────────────────────────────────────────────

test("one resolved route profile reaches every compaction and packing consumer", () => {
  const runner = readFileSync(path.join(import.meta.dir, "..", "src", "session", "runner", "llm.ts"), "utf8")
  const strictDrain = readFileSync(
    path.join(import.meta.dir, "..", "src", "session", "runner", "strict-drain.ts"),
    "utf8",
  )
  const expectProfileNear = (source: string, marker: string, width: number, includesRetention = true) => {
    const at = source.indexOf(marker)
    expect(at, `missing call-site marker: ${marker}`).toBeGreaterThan(-1)
    expect(source.slice(at, at + width), `${marker} lost the resolved route image grid`).toContain(
      "imagePatchPixels: routeProfile.imagePatchPixels",
    )
    if (includesRetention)
      expect(source.slice(at, at + width), `${marker} lost the resolved prefix-retention ceiling`).toContain(
        "prefixCacheRetentionTokens: routeProfile.prefixCacheRetentionTokens",
      )
  }

  expectProfileNear(runner, "const promptEstimate = PromptEstimate.resolve({", 500, false)
  expectProfileNear(runner, "harness.compaction.compactIfNeeded({", 500)
  expectProfileNear(runner, "const preparedDispatch = ProviderDispatch.prepare({", 800)

  // Strict mode builds two independently dispatched requests: each engine call, and the final
  // user-facing run summary. Both must use the same route fact resolved once above them.
  expect(strictDrain.match(/ProviderDispatch\.prepare\(\{/g)).toHaveLength(2)
  expect(strictDrain.match(/imagePatchPixels: routeProfile\.imagePatchPixels/g)).toHaveLength(2)
  expect(strictDrain.match(/prefixCacheRetentionTokens: routeProfile\.prefixCacheRetentionTokens/g)).toHaveLength(2)
})

type SummaryAttempt = {
  readonly text: string
  readonly reason: "stop" | "length"
  readonly outputTokens?: number
  readonly fail?: boolean
}

const summaryModel = Model.make({
  id: "summary-budget-test",
  provider: "test",
  route: OpenAIChat.route.with({ limits: { context: 100_000, output: 32 } }),
})

const driveSummary = (attempts: readonly SummaryAttempt[], prefix?: LLMRequest) => {
  const requests: LLMRequest[] = []
  const published: { readonly type: string; readonly data: Record<string, unknown> }[] = []
  let index = 0
  const compactor = SessionCompaction.make({
    events: {
      publish: (definition: { type: string }, data: Record<string, unknown>) =>
        Effect.sync(() => {
          published.push({ type: definition.type, data })
        }),
    } as unknown as EventV2.Interface,
    llm: {
      stream: (request: LLMRequest) => {
        requests.push(request)
        const attempt = attempts[index++]!
        if (attempt.fail) return Stream.fromIterable([LLMEvent.providerError({ message: "trim failed" })])
        return Stream.fromIterable([
          LLMEvent.textDelta({ id: `summary-${index}`, text: attempt.text }),
          LLMEvent.stepFinish({
            index: 0,
            reason: attempt.reason,
            usage: attempt.outputTokens === undefined ? undefined : { outputTokens: attempt.outputTokens },
          }),
        ])
      },
    },
    config: [
      {
        type: "document",
        info: { compaction: { keep: { tokens: 8 } } },
      } as unknown as Config.Entry,
    ],
    prefixHash: () => Effect.succeed("0".repeat(64)),
  })
  const compacted = Effect.runSync(
    compactor.compactAfterOverflow(
      {
        sessionID: "ses_summary_budget" as unknown as SessionSchema.ID,
        entries: entries(
          user(`old question ${"detail ".repeat(80)}`),
          assistant(`old answer ${"fact ".repeat(80)}`),
          user(`new question ${"exact ".repeat(80)}`),
          assistant("new answer"),
        ),
        model: summaryModel,
        request: prefix ?? LLM.request({ model: summaryModel, messages: [], tools: [] }),
      },
      "manual",
    ),
  )
  const ended = published.find((event) => event.type === SessionEvent.Compaction.Ended.type)?.data as
    | { readonly text?: string }
    | undefined
  const userPrompt = (request: LLMRequest) =>
    request.messages.flatMap((message) => message.content.map((part) => ("text" in part ? part.text : ""))).join("\n")
  return { compacted, requests, ended, published, userPrompt }
}

describe("postfix compaction prompt", () => {
  test("puts evidence before the current instruction and output contract", () => {
    const context = ["[User]: alpha", "[Assistant]: beta"]
    const fresh = SessionCompaction.buildPrompt({ context })
    const updated = SessionCompaction.buildPrompt({ previousSummary: "## Goal\n- existing", context })
    const freshInstruction = "Create a new anchored summary"
    const updateInstruction = "Update the anchored summary"

    expect(fresh).toStartWith(`<history>\n${context.join("\n\n")}\n</history>`)
    expect(updated).toStartWith(`<history>\n${context.join("\n\n")}\n</history>`)
    expect(fresh.indexOf("</history>")).toBeLessThan(fresh.indexOf(freshInstruction))
    expect(fresh.indexOf(freshInstruction)).toBeLessThan(fresh.indexOf("<template>"))
    expect(fresh).toContain(
      "Preserve complete condition → action/result chains and all exact numbers, thresholds, exceptions, and later-checked facts.",
    )
    expect(fresh).toContain(
      "Put the actual later-checked fact and its values in Critical Context. Saying a fact was stored, exists, or should be preserved is not the fact and is invalid.",
    )
    expect(updated.indexOf("</history>")).toBeLessThan(updated.indexOf(updateInstruction))
    expect(updated.indexOf("<previous-summary>")).toBeLessThan(updated.indexOf("<template>"))
    expect(fresh).toEndWith("- Do not mention the summary process or that context was compacted.")
  })

  test("a committing compaction sends a history-first, instruction-last prompt", () => {
    const summary = "## Goal\n- done"
    const run = driveSummary([{ text: summary, reason: "stop", outputTokens: 8 }])

    expect(run.compacted).toBe(true)
    expect(run.requests).toHaveLength(1)
    expect(run.ended?.text).toBe(summary)
    const prompt = run.userPrompt(run.requests[0]!)
    expect(prompt).toStartWith("<history>")
    expect(prompt.indexOf("</history>")).toBeLessThan(prompt.indexOf("Create a new anchored summary"))
    expect(prompt.indexOf("Create a new anchored summary")).toBeLessThan(prompt.indexOf("<template>"))
    expect(prompt).toContain("[User]: old question")
    expect(prompt).toEndWith("- Do not mention the summary process or that context was compacted.")
  })

  test("a committing compaction reuses the assembled working request and only appends its operation", () => {
    const prefix = LLM.request({
      model: summaryModel,
      system: [SystemPart.make("officer identity")],
      messages: [Message.user("first request"), Message.assistant("first answer")],
      tools: [{ name: "read", description: "read", inputSchema: { type: "object" } }] as never,
    })
    const run = driveSummary([{ text: "## Goal\n- done", reason: "stop", outputTokens: 8 }], prefix)
    const request = run.requests[0]!

    expect(request.system).toEqual(prefix.system)
    expect(request.tools).toEqual(prefix.tools)
    expect(request.messages.slice(0, -1)).toEqual([...prefix.messages])
    expect(run.userPrompt(request).split("\n").at(-1)).toBe(
      "- Do not mention the summary process or that context was compacted.",
    )
    expect(run.userPrompt(request)).toContain("Create a new anchored summary")
  })
})

describe("bounded compaction summaries", () => {
  test("forced loss marking owns one marker even when the generated fragment already fits", () => {
    const trimmed = SessionCompaction.trimSummaryHead("newest fact", 50, true)
    expect(trimmed).toContain("Older summary content removed")
    expect(trimmed).toContain("newest fact")
    expect(trimmed.match(/Older summary content removed/g)).toHaveLength(1)
  })

  test("mechanical head removal preserves complete Unicode scalars in the newest tail", () => {
    const rocket = String.fromCodePoint(0x1f680)
    const trimmed = SessionCompaction.trimSummaryHead(`${"old ".repeat(80)}${rocket.repeat(12)}`, 20)
    expect(trimmed).toEndWith(rocket)
    expect(() => encodeURI(trimmed)).not.toThrow()
    expect(SessionCompaction.summaryWithinBudget(trimmed, 20)).toBe(true)
  })

  test("a Token.estimate over-budget summary is deterministically trimmed even when provider usage under-reports it", () => {
    // Digit-dense output defeats chars/4 dramatically: this is over 32 estimated tokens despite
    // the canned provider claiming only 12.
    const first = `## Goal\n- ${"1234567890".repeat(5)}`
    const run = driveSummary([{ text: first, reason: "stop", outputTokens: 12 }])

    expect(run.compacted).toBe(true)
    expect(run.requests).toHaveLength(1)
    expect(run.requests[0]!.generation?.maxTokens).toBe(32)
    expect(run.ended?.text).toContain("Older summary content removed")
    expect(SessionCompaction.summaryWithinBudget(run.ended!.text!, 32)).toBe(true)
    expect(run.published.map((event) => event.type)).toEqual([
      SessionEvent.Compaction.Started.type,
      SessionEvent.Compaction.Delta.type,
      SessionEvent.Compaction.Ended.type,
    ])
  })

  test("finish=length cuts the oldest head without spending a second model pass", () => {
    const newest = "## Relevant Files\n- src/new.ts: newest fact"
    const first = `## Goal\n- ${"old ".repeat(80)}\n\n${newest}`
    const run = driveSummary([{ text: first, reason: "length", outputTokens: 96 }])

    expect(run.compacted).toBe(true)
    expect(run.requests).toHaveLength(1)
    expect(run.ended?.text).toContain("Older summary content removed")
    expect(run.ended?.text).toContain(newest)
    expect(run.ended?.text).not.toContain("## Goal")
    expect(SessionCompaction.summaryWithinBudget(run.ended!.text!, 32)).toBe(true)
  })

  test("an over-budget answer preserves its newest tail in one model call", () => {
    const newest = "## Relevant Files\n- src/final.ts: keep this"
    const first = `## Goal\n- ${"still too long ".repeat(80)}\n\n${newest}`
    const run = driveSummary([{ text: first, reason: "stop", outputTokens: 100 }])

    expect(run.compacted).toBe(true)
    expect(run.requests).toHaveLength(1)
    expect(run.ended?.text).toContain(newest)
    expect(run.ended?.text).not.toContain("## Goal")
    expect(SessionCompaction.summaryWithinBudget(run.ended!.text!, 32)).toBe(true)
  })
})
