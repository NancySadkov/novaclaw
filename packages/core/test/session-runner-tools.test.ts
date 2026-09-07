import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Schema, Stream } from "effect"
import { LLMEvent } from "@novaclaw/llm"
import { AgentV2 } from "@novaclaw/core/agent"
import { SessionV2 } from "@novaclaw/core/session"
import { Prompt } from "@novaclaw/core/session/prompt"
import { ApplicationTools } from "@novaclaw/core/tool/application-tools"
import { Tool } from "@novaclaw/core/tool/tool"
import { HARNESS_SESSION, completeTurn, drive, makeLatch, makeRunnerHarness } from "./fixture/runner-harness"

/**
 * PORTED CLAIMS — tools the runner did not register itself.
 *
 * Rewritten against the current runner on a harness that runs on **win32** (S3; ledger in
 * `session-runner-claims.test.ts`).
 */

describe("SessionRunnerLLM — application tools", () => {
  test("advertises and executes a globally attached application tool", async () => {
    // An APPLICATION tool is attached outside the session's own registry — the seam an app on the OS
    // uses. The claim has three parts and they are separable: it must be ADVERTISED in the request, it
    // must EXECUTE, and the execution must arrive with a full attribution context. That third part is
    // the one worth guarding: a tool that runs without knowing which session, agent and assistant
    // message invoked it cannot be permission-gated or audited afterwards.
    const contexts: Tool.Context[] = []
    const harness = makeRunnerHarness({
      turns: [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-application", name: "application_context", input: { query: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        // The continuation turn. Scripted with a real reply — it used to be empty "on purpose, this
        // claim is about the tool round trip", and that only worked while an empty provider stream was
        // silently swallowed. It is now a named fault (`session-runner-errors.test.ts`), so a claim
        // that is not about failure must script a response.
        completeTurn("t2", "Done"),
      ],
    })

    const context = await drive(
      harness,
      Effect.gen(function* () {
        const applicationTools = yield* ApplicationTools.Service
        yield* applicationTools.register({
          application_context: Tool.make({
            description: "Read application context",
            input: Schema.Struct({ query: Schema.String }),
            output: Schema.Struct({ answer: Schema.String }),
            execute: ({ query }, toolContext) =>
              Effect.sync(() => {
                contexts.push(toolContext)
                return { answer: query.toUpperCase() }
              }),
          }),
        })
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Use application context" }),
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
        return yield* session.context(HARNESS_SESSION)
      }),
      "claim — globally attached application tool",
    )

    // ① advertised
    expect(harness.requests[0]?.tools.map((tool) => tool.name)).toContain("application_context")
    // ② executed exactly once, with full attribution. This is the claim, so it is asserted on the
    // four fields that ARE the attribution rather than on the whole object — the context has since
    // grown an unrelated `attachmentPaths`, and a claim about who invoked a tool should not break when
    // something else is added beside it.
    expect(contexts).toHaveLength(1)
    expect(contexts[0]).toMatchObject({
      sessionID: HARNESS_SESSION,
      // The harness session names no colleague, so it runs as the DEFAULT OFFICER. That was the
      // `build` posture until 2026-08-24 — see `AgentV2.DEFAULT_COLLEAGUE_ID`.
      agent: AgentV2.DEFAULT_COLLEAGUE_ID,
      assistantMessageID: expect.stringMatching(/^msg_/),
      toolCallID: "call-application",
      model: {
        providerID: "harness",
        id: "harness-model",
      },
    })
    // …and a separate RATCHET on the shape, kept because a silently-added context field is how an
    // execution stops being fully attributable without anything going red. A new key here is fine —
    // it just has to argue for itself in this list first.
    expect(Object.keys(contexts[0] ?? {}).sort(), "the tool context gained or lost a field").toEqual([
      "agent",
      "assistantMessageID",
      "attachmentPaths",
      // The assistant turn's remaining image allowance (`tool/tool.ts` → `imageBudget`), which
      // `read` consults before handing over pixels the turn cannot describe. It argues for itself
      // twice over: it carries no attribution, and it is here at all only because this ratchet's
      // sibling problem had already happened — the runner sent this field through a conditional
      // SPREAD, `ToolRegistry.ExecuteInput` never declared it, spreads are exempt from
      // excess-property checking, and so the gate read `undefined` for the life of the feature.
      "imageBudget",
      // Exact model identity for introspection and diagnostics. This is the model that survived
      // runtime routing/fallback, not a second catalog lookup made after the request began.
      "model",
      "sessionID",
      // The Working receipt's span handle (`Tool.Context.timing`): a tool opens a `capability-*`
      // phase so a long service call shows up in the turn receipt instead of reading as a stall.
      // It carries no attribution — `begin` returns its own close handle precisely so parallel
      // spans cannot close one another — so it neither adds to nor weakens what ② asserts.
      "timing",
      "toolCallID",
    ])
    // ③ and its result is projected as a completed tool call, carrying the structured output
    expect(context).toMatchObject([
      { type: "user", text: "Use application context" },
      {
        type: "assistant",
        content: [
          { type: "tool", id: "call-application", state: { status: "completed", structured: { answer: "HELLO" } } },
        ],
      },
      { type: "assistant", finish: "stop" },
    ])
  })
})

describe("SessionRunnerLLM — local tool execution", () => {
  test("starts recorded local tools eagerly and awaits settlement before continuing", async () => {
    // FIVE tool calls arrive, then the provider PAUSES before finishing the turn. The claim is that the
    // runner starts each tool as soon as its call is seen rather than waiting for the turn to complete.
    //
    // ⭐ `maxActive` is what makes this provable, and nothing about the results could. Five tools that
    // ran one after another produce exactly the same five outputs as five that ran at once — only the
    // high-water mark of concurrent executions tells them apart. That is why the harness accounts for
    // it rather than just collecting results.
    //
    // The provider stream is a Stream rather than an array for the same reason: a static array always
    // arrives complete, so a runner that waited for the whole turn would pass a test about not waiting.
    const toolsStarted = makeLatch()
    const toolGate = makeLatch()
    const providerGate = makeLatch()

    const harness = makeRunnerHarness({
      turns: [
        Stream.concat(
          Stream.fromIterable([
            LLMEvent.stepStart({ index: 0 }),
            ...Array.from({ length: 5 }, (_, index) =>
              LLMEvent.toolCall({ id: `call-echo-${index}`, name: "echo", input: { text: `${index}` } }),
            ),
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
        [],
      ],
    })
    harness.controls.toolsReady = 5
    harness.controls.toolsStarted = toolsStarted
    harness.controls.toolGate = toolGate

    const context = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Echo five times" }),
          resume: false,
        })
        const run = yield* session.resume(HARNESS_SESSION).pipe(Effect.forkChild)

        // All five are in flight — the turn has NOT finished arriving yet.
        yield* Effect.promise(() => toolsStarted.promise)
        const observed = yield* session.context(HARNESS_SESSION)

        // Let the tools settle, then let the provider finish the turn.
        toolGate.open()
        providerGate.open()
        yield* Fiber.join(run)
        return observed
      }),
      "claim — local tools start eagerly",
    )

    expect(harness.executions, "all five started before the turn finished arriving").toHaveLength(5)
    expect(harness.toolState.maxActive, "they ran CONCURRENTLY, not one after another").toBe(5)
    expect(context).toMatchObject([
      { type: "user", text: "Echo five times" },
      {
        type: "assistant",
        content: Array.from({ length: 5 }, (_, index) => ({
          type: "tool",
          id: `call-echo-${index}`,
          state: { status: "running", input: { text: `${index}` } },
        })),
      },
    ])
  })

  test("continues with reloaded history after durably settling one local tool call", async () => {
    // The full local-tool round trip: call, execute, SETTLE DURABLY, then continue with the settled
    // result visible in history.
    //
    // ⭐ The load-bearing assertion is the second request's message ROLES — `["user","assistant","tool"]`.
    // The continuation must be built from RELOADED history containing the tool result, not from the
    // in-memory turn that issued the call. A runner that continued from what it happened to be holding
    // would produce the same final text while being unable to survive a restart between the call and
    // the continuation, which is the whole point of settling durably.
    const harness = makeRunnerHarness({
      turns: [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-echo", name: "echo", input: { text: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-final" }),
          LLMEvent.textDelta({ id: "text-final", text: "Done" }),
          LLMEvent.textEnd({ id: "text-final" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ],
    })

    const context = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Echo this" }), resume: false })
        yield* session.resume(HARNESS_SESSION)
        return yield* session.context(HARNESS_SESSION)
      }),
      "claim — continuation reloads settled tool history",
    )

    expect(harness.requests).toHaveLength(2)
    expect(
      harness.requests[1]?.messages.map((message) => message.role),
      "the continuation is built from reloaded history carrying the tool result",
    ).toEqual(["user", "assistant", "tool"])
    expect(harness.authorizations).toMatchObject([{ sessionID: HARNESS_SESSION, toolCallID: "call-echo" }])
    expect(harness.executions).toEqual(["hello"])
    expect(context).toMatchObject([
      { type: "user", text: "Echo this" },
      {
        type: "assistant",
        finish: "tool-calls",
        content: [
          {
            type: "tool",
            id: "call-echo",
            name: "echo",
            state: {
              status: "completed",
              input: { text: "hello" },
              structured: { text: "hello" },
              content: [{ type: "text", text: "hello" }],
            },
          },
        ],
      },
      { type: "assistant", finish: "stop", content: [{ type: "text", id: "text-final", text: "Done" }] },
    ])
  })

  // Two ways a local tool can fail, and the runner must treat both as DATA for the model rather than as
  // a reason to stop: an unknown tool name, and a tool whose execution defects. In each case the error
  // is settled durably as the tool's result and the turn continues. A runner that aborted instead would
  // strand the session on any bad tool call, which for a small model is a routine occurrence rather
  // than an exceptional one.
  const failingToolTurns = (callID: string, name: string, finalID: string) => [
    [
      LLMEvent.stepStart({ index: 0 }),
      LLMEvent.toolCall({ id: callID, name, input: {} }),
      LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
      LLMEvent.finish({ reason: "tool-calls" }),
    ],
    [
      LLMEvent.stepStart({ index: 0 }),
      LLMEvent.textStart({ id: finalID }),
      LLMEvent.textDelta({ id: finalID, text: "Recovered" }),
      LLMEvent.textEnd({ id: finalID }),
      LLMEvent.stepFinish({ index: 0, reason: "stop" }),
      LLMEvent.finish({ reason: "stop" }),
    ],
  ]

  test("durably settles local tool failures before continuing", async () => {
    const harness = makeRunnerHarness({ turns: failingToolTurns("call-missing", "missing", "text-after-error") })

    const context = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Call missing" }),
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
        return yield* session.context(HARNESS_SESSION)
      }),
      "claim — an unknown tool settles as an error and the turn continues",
    )

    expect(harness.requests).toHaveLength(2)
    expect(context).toMatchObject([
      { type: "user", text: "Call missing" },
      {
        type: "assistant",
        content: [
          {
            type: "tool",
            id: "call-missing",
            // Identifying clause only — the message also names the advertised tools, and pinning that
            // list would make every tool registration break this claim.
            state: { status: "error", error: { message: expect.stringContaining("Unknown tool: missing.") } },
          },
        ],
      },
      { type: "assistant", finish: "stop", content: [{ type: "text", id: "text-after-error", text: "Recovered" }] },
    ])
  })

  test("returns unexpected local tool defects to the model and continues", async () => {
    // A DEFECT, not a typed failure — the tool dies. It must still come back as a tool result the model
    // can read, rather than taking the drain down with it.
    const harness = makeRunnerHarness({ turns: failingToolTurns("call-defect", "defect", "text-after-defect") })

    const context = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Call defect" }),
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
        return yield* session.context(HARNESS_SESSION)
      }),
      "claim — a tool defect is returned to the model",
    )

    expect(harness.requests).toHaveLength(2)
    expect(
      harness.requests[1]?.messages.map((message) => message.role),
      "the defect is carried as a tool result in reloaded history",
    ).toEqual(["user", "assistant", "tool"])
    expect(context).toMatchObject([
      { type: "user", text: "Call defect" },
      {
        type: "assistant",
        content: [
          {
            type: "tool",
            id: "call-defect",
            state: {
              status: "error",
              error: { type: "unknown", message: "Tool execution failed: unexpected tool defect" },
            },
          },
        ],
      },
      { type: "assistant", finish: "stop", content: [{ type: "text", text: "Recovered" }] },
    ])
  })

  test("settles repeated provider-local tool call IDs against their owning assistant messages", async () => {
    // Two different turns each issue a call with the SAME id `tool_0`. Small models reuse call ids
    // constantly — some providers number them per-turn — so this is routine, not adversarial.
    //
    // ⭐ The id is only unique WITHIN its assistant message, so settlement must be keyed by (message,
    // call), not by call alone. A runner keyed on the id would settle the second result against the
    // first message: the first tool would appear to change its answer after the fact, and the second
    // would sit unsettled forever. Both turns must keep their own result.
    const harness = makeRunnerHarness({
      turns: [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "tool_0", name: "echo", input: { text: "first" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "tool_0", name: "echo", input: { text: "second" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        completeTurn("t3", "Done"),
      ],
    })

    const context = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Echo twice" }),
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
        return yield* session.context(HARNESS_SESSION)
      }),
      "claim — repeated call ids settle per assistant message",
    )

    expect(harness.executions).toEqual(["first", "second"])
    expect(harness.requests).toHaveLength(3)
    expect(context).toMatchObject([
      { type: "user", text: "Echo twice" },
      {
        type: "assistant",
        content: [
          {
            type: "tool",
            id: "tool_0",
            state: { status: "completed", structured: { text: "first" }, content: [{ type: "text", text: "first" }] },
          },
        ],
      },
      {
        type: "assistant",
        content: [
          {
            type: "tool",
            id: "tool_0",
            state: { status: "completed", structured: { text: "second" }, content: [{ type: "text", text: "second" }] },
          },
        ],
      },
      { type: "assistant", finish: "stop" },
    ])
  })
})
