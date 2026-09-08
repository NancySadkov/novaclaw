import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Schema, Stream } from "effect"
import { LLMEvent } from "@novaclaw/llm"
import { SessionV2 } from "@novaclaw/core/session"
import { Prompt } from "@novaclaw/core/session/prompt"
import { SessionScheduler } from "@novaclaw/core/session/scheduler"
import { ApplicationTools } from "@novaclaw/core/tool/application-tools"
import { Tool } from "@novaclaw/core/tool/tool"
import { HARNESS_SESSION, completeTurn, drive, makeLatch, makeRunnerHarness } from "./fixture/runner-harness"
import { tmpdir } from "./fixture/tmpdir"

/**
 * What ONE assistant turn spends, and who is told about it before the next one is admitted.
 *
 * Three accounts are settled inside a single turn — the per-turn image budget, the device's fairness
 * ledger, and the summarizer's token budget — and all three were being read or written at the wrong
 * MOMENT rather than with the wrong number. That is why none of them was visible to a test that only
 * checked a final value: a race and an ordering both produce the right total.
 */

const toolCall = (id: string, name: string, input: Record<string, unknown>) => LLMEvent.toolCall({ id, name, input })

describe("the per-turn image budget under PARALLEL tool calls", () => {
  test("two calls dispatched in one turn are charged against the same budget, not one each", async () => {
    // 🔴 The budget is per ASSISTANT TURN and its default cap is ONE image
    // (`ModelV2.DEFAULT_IMAGE_LIMIT`). Tool calls in one turn run concurrently, so a `held` count read
    // inside the forked settlement fiber — and incremented only after that fiber resolved — was read
    // as 0 by every call in the turn. The cap was therefore multiplied by the parallelism, both sets
    // of pixels arrived, `budgetImages` elided one at lowering, and the model described a picture it
    // no longer held.
    //
    // ⭐ **A sequential test cannot see this and would pass on the broken code**, because with one
    // call in flight at a time the stale read and the fresh read are the same number. So the two
    // calls are held OPEN together — `maxActive` is the proof the interleaving actually happened —
    // and the claim is over what each call was HANDED, not over any final count.
    const toolsStarted = makeLatch()
    const toolGate = makeLatch()
    const providerGate = makeLatch()

    const harness = makeRunnerHarness({
      turns: [
        Stream.concat(
          Stream.fromIterable([
            LLMEvent.stepStart({ index: 0 }),
            toolCall("call-look-a", "echo", { text: "a" }),
            toolCall("call-look-b", "echo", { text: "b" }),
          ]),
          Stream.fromEffect(Effect.promise(() => providerGate.promise)).pipe(
            Stream.flatMap(() =>
              Stream.fromIterable([
                LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
                LLMEvent.finish({ reason: "tool-calls" }),
              ]),
            ),
          ),
        ),
        completeTurn("t2", "Done"),
      ],
    })
    harness.controls.toolsReady = 2
    harness.controls.toolsStarted = toolsStarted
    harness.controls.toolGate = toolGate

    await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Look at both" }),
          resume: false,
        })
        const run = yield* session.resume(HARNESS_SESSION).pipe(Effect.forkChild)
        // Both are executing. Neither has settled, so neither has counted anything.
        yield* Effect.promise(() => toolsStarted.promise)
        toolGate.open()
        providerGate.open()
        yield* Fiber.join(run)
      }),
      "claim — one turn, one image budget",
    )

    expect(harness.toolState.maxActive, "the two calls really did overlap — without that there is no race").toBe(2)
    // The whole claim, in one line: the SECOND call was told the budget was already spoken for.
    // `[{held:0},{held:0}]` is the defect; `[{held:0},{held:1}]` is a budget.
    expect(harness.authorizations.map((context) => context.imageBudget)).toEqual([
      { limit: 1, held: 0 },
      { limit: 1, held: 1 },
    ])
  })

  test("a settled call that handed over no pixels returns its reservation to the turn", async () => {
    // The reservation is conservative on purpose — a dispatched call must be assumed to hand over
    // pixels, because the runner cannot know which tools will. But it is a RESERVATION, not a spend:
    // once a call settles with no image in its result, the budget is whole again for the next call.
    // ⚠️ Sequential on purpose. This is the arm the previous test cannot show, and the two together
    // are what say the counter tracks the turn rather than merely counting calls.
    const harness = makeRunnerHarness({
      turns: [
        [
          LLMEvent.stepStart({ index: 0 }),
          toolCall("call-first", "echo", { text: "one" }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          toolCall("call-second", "echo", { text: "two" }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        completeTurn("t3", "Done"),
      ],
    })

    await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Echo twice" }),
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
      }),
      "claim — a text result costs the image budget nothing",
    )

    expect(harness.authorizations.map((context) => context.imageBudget?.held)).toEqual([0, 0])
  })
})

describe("the device's fairness ledger, and the moment the next waiter is let in", () => {
  test("a tool-calling turn charges the ledger BEFORE it releases the device slot", async () => {
    // `provider-dispatch.ts` states the rule and honours it for the release IT owns: charge, then
    // release, because both address the same slot and releasing first drains a waiter that then races
    // the charge for this turn's cost. But the runner releases in-band on the FIRST `tool-call` event,
    // strictly earlier — so on every tool-calling turn, which is every agent turn, the dispatch's own
    // release was already a no-op and the documented ordering never held.
    //
    // ⭐ **Observable only as an ORDER.** The turn's total charge is identical either way, so a test
    // that asserted the total would pass on the defect. What is recorded here is the sequence of
    // slot operations, and the claim is about which one comes first.
    const harness = makeRunnerHarness({
      turns: [
        [
          LLMEvent.stepStart({ index: 0 }),
          toolCall("call-echo", "echo", { text: "hi" }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls", usage: { inputTokens: 400, outputTokens: 20 } }),
          LLMEvent.finish({ reason: "tool-calls", usage: { inputTokens: 400, outputTokens: 20 } }),
        ],
        completeTurn("t2", "Done"),
      ],
    })
    const slotOps: string[] = []

    await drive(
      harness,
      Effect.gen(function* () {
        // The runner captured this exact object at layer construction and calls through it by
        // property, so wrapping the two methods here observes the real call order rather than a
        // reconstruction of it.
        const scheduler = yield* SessionScheduler.Service
        const release = scheduler.release
        const report = scheduler.report
        Object.assign(scheduler, {
          // ⚠️ The push is INSIDE an `Effect.sync`, not in the wrapper body. `provider-dispatch.ts`
          // builds its safety-net release as `Effect.ensuring(scheduler.release(slot))`, which CALLS
          // the method once at construction to make the Effect value and runs it much later — a
          // wrapper that recorded on call would report that net first and every ordering claim over
          // it would be a claim about when the pipeline was assembled.
          release: (input: Parameters<typeof release>[0]) =>
            Effect.sync(() => void slotOps.push("release")).pipe(Effect.andThen(release(input))),
          report: (input: Parameters<typeof report>[0]) =>
            Effect.sync(() => void slotOps.push("report")).pipe(Effect.andThen(report(input))),
        })
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Use a tool" }),
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
      }),
      "claim — charge, then release",
    )

    expect(slotOps.length, "the turn touched the slot at all").toBeGreaterThan(1)
    // The defect is `slotOps[0] === "release"`: a waiter drained against a ledger that has not yet
    // been told what this turn cost.
    expect(slotOps[0]).toBe("report")
    expect(slotOps.indexOf("report")).toBeLessThan(slotOps.indexOf("release"))
  })
})

describe("the tool-output summarizer against a model that ignores `enable_thinking:false`", () => {
  test("recovers a real summary from a first attempt that returned nothing in either channel", async () => {
    // 🔴 The failure this proves, verbatim from the standing rule: a thinking model given a tight
    // `max_tokens` is truncated inside its `<think>` block and returns NOTHING — in both channels,
    // because the reasoning parser only emits on the closing tag. `ToolOutputSummary.summarize` fails
    // OPEN on an empty completion, so the whole semantic map/reduce went permanently inert on such a
    // model while every test stayed green: the deterministic preview is still there, and it looks
    // like "there was nothing to summarize".
    //
    // ⭐ So the scripted model does exactly that — the first attempt is reasoning and no answer at
    // all. A bare capped request has nowhere to go from there. `ReasoningBudget`, which is what
    // `ShortAnswer.generate` brings, cuts at its checkpoint and CONTINUES, and the summary arrives.
    // The claim is the summary's own text, not the wiring that produced it.
    await using root = await tmpdir()
    const source = Array.from({ length: 2_400 }, (_, index) => `line-${index}\n`).join("")
    const harness = makeRunnerHarness({
      dataRoot: root.path,
      turns: [
        [
          LLMEvent.stepStart({ index: 0 }),
          toolCall("call-large", "large_result", {}),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        completeTurn("final", "Done"),
      ],
      toolSummaryTurns: [
        // Attempt one: the model spends its whole turn thinking and answers nothing.
        [LLMEvent.reasoningDelta({ id: "summary-reasoning", text: "r".repeat(1_000) })],
        // Attempt two — the continuation the controller issues.
        [
          LLMEvent.textDelta({ id: "summary", text: "Numbered placeholder rows, nothing anomalous." }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
        ],
      ],
    })
    // A window wide enough that the source is ONE chunk: the claim is about a single completion's
    // recovery, and a map/reduce over many chunks would make the request count a property of the
    // splitter rather than of the controller.
    harness.controls.currentModel = harness.makeModel("wide-window", { context: 131_072, output: 4_096 })

    const context = await drive(
      harness,
      Effect.gen(function* () {
        yield* (yield* ApplicationTools.Service).register({
          large_result: Tool.make({
            description: "Return a large report",
            input: Schema.Struct({}),
            output: Schema.Struct({ text: Schema.String }),
            execute: () => Effect.succeed({ text: source }),
            toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
          }),
        })
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Inspect the report" }),
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
        return yield* session.context(HARNESS_SESSION)
      }),
      "claim — a thinking summarizer still summarizes",
    )

    // The summary reached the transcript. Under a bare capped call the first attempt is the only
    // attempt, its text is "", and this line finds the deterministic preview instead.
    const part = context
      .flatMap((message) => (message.type === "assistant" ? message.content : []))
      .find((entry) => entry.type === "tool" && entry.id === "call-large")
    if (part?.type !== "tool" || part.state.status !== "completed") throw new Error("expected a completed tool call")
    const content = part.state.content[0]
    if (content?.type !== "text") throw new Error("expected retained summarized output")
    expect(content.text).toContain("nothing anomalous")

    // …and it arrived through the controller, not through a second bare attempt: exactly two requests,
    // the second CONTINUING the first rather than restarting it.
    expect(harness.toolSummaryRequests).toHaveLength(2)
    expect(JSON.stringify(harness.toolSummaryRequests[0]?.system)).toContain("reasoning budget of about 128 tokens")
    expect(
      harness.toolSummaryRequests[1]?.http?.body?.["continue_final_message"],
      "a continuation, not a retry — otherwise the budget is a retry loop wearing a budget's name",
    ).toBe(true)
    // ⚠️ The half of the rule that is easiest to re-derive: the first attempt does NOT ask the model
    // not to think and does NOT squeeze the answer to the byte budget. `enable_thinking:false` is a
    // request a growing class of models ignores, and a cap at the hard stop's landing point is the
    // empty-completion trap wearing a smaller number.
    expect(harness.toolSummaryRequests[0]?.http?.body?.["chat_template_kwargs"]).toBeUndefined()
    expect(harness.toolSummaryRequests[0]?.generation?.maxTokens).toBeGreaterThanOrEqual(512)
  })
})
