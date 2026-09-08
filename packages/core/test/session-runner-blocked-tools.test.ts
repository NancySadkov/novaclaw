import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Fiber, Schema, Stream } from "effect"
import { LLMError, LLMEvent, TransportReason } from "@novaclaw/llm"
import { SessionV2 } from "@novaclaw/core/session"
import { Prompt } from "@novaclaw/core/session/prompt"
import { SessionRunner } from "@novaclaw/core/session/runner"
import { Tool } from "@novaclaw/core/tool/tool"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { HARNESS_SESSION, completeTurn, drive, makeLatch, makeRunnerHarness } from "./fixture/runner-harness"

/**
 * PORTED CLAIMS — a local tool still RUNNING when the turn around it ends.
 *
 * Rewritten against the current runner on a harness that runs on **win32** (S3; ledger in
 * `session-runner-claims.test.ts`).
 *
 * ⭐ **The two claims here pull in opposite directions, which is the point.** When the provider stream
 * FAILS, a tool already executing must be allowed to finish and settle as `completed` — its work really
 * happened, and recording it as an error would be ruling 2's *a fault is never described falsely*, in
 * the direction that loses real work. When the turn is INTERRUPTED, the same tool must be closed as an
 * error, because nobody is going to collect its result. Same state, opposite correct answers, decided
 * by what ended the turn.
 *
 * Both provider failure and explicit interruption are exercised below.
 */

const providerUnavailable = () =>
  new LLMError({ module: "test", method: "stream", reason: new TransportReason({ message: "Provider unavailable" }) })

/** Wait until at least one tool execution has begun. Bounded by `runBounded` like everything else. */
const waitForExecution = (harness: ReturnType<typeof makeRunnerHarness>) =>
  Effect.gen(function* () {
    while (harness.executions.length === 0) yield* Effect.yieldNow
  })

describe("SessionRunnerLLM — tools blocked when the turn ends", () => {
  test("awaits started local tools before surfacing provider stream failure", async () => {
    // The stream dies while the tool is mid-flight. The failure must still reach the caller — but only
    // AFTER the tool settles, and the tool settles as COMPLETED. A runner that surfaced the failure
    // immediately would abandon work that actually ran, and the transcript would deny it happened.
    const failure = providerUnavailable()
    const toolGate = makeLatch()
    const harness = makeRunnerHarness({
      turns: [
        Stream.concat(
          Stream.fromIterable([
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.toolCall({ id: "call-before-failure", name: "echo", input: { text: "settle" } }),
          ]),
          Stream.fail(failure),
        ),
      ],
    })
    harness.controls.toolGate = toolGate

    const context = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Settle before failing" }),
          resume: false,
        })
        const run = yield* session.resume(HARNESS_SESSION).pipe(Effect.forkChild)
        yield* waitForExecution(harness)
        yield* Effect.yieldNow
        toolGate.open()
        expect(yield* Fiber.join(run).pipe(Effect.flip), "the failure still reaches the caller").toBe(failure)
        return yield* session.context(HARNESS_SESSION)
      }),
      "claim — started tools settle before the failure surfaces",
    )

    expect(context).toMatchObject([
      { type: "user", text: "Settle before failing" },
      {
        type: "assistant",
        content: [
          { type: "tool", id: "call-before-failure", state: { status: "completed", structured: { text: "settle" } } },
        ],
      },
    ])
  })

  test("durably fails blocked local tools when a provider turn is interrupted", async () => {
    // Same shape, opposite ending. Interrupted means nobody will collect the result, so the tool is
    // closed as an error — durably, surviving a replay, and visible as a settled `tool` message in the
    // NEXT turn's reloaded history rather than as a call still awaiting an answer.
    const toolGate = makeLatch()
    const harness = makeRunnerHarness({
      turns: [
        Stream.concat(
          Stream.fromIterable([
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.toolCall({ id: "call-before-interrupt", name: "echo", input: { text: "blocked" } }),
          ]),
          Stream.never,
        ),
        [],
      ],
    })
    harness.controls.toolGate = toolGate

    const { afterInterrupt, afterReplay } = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Interrupt blocked tool" }),
          resume: false,
        })
        const run = yield* session.resume(HARNESS_SESSION).pipe(Effect.forkChild)
        yield* waitForExecution(harness)
        yield* session.interrupt(HARNESS_SESSION)
        // Release the gate so the abandoned execution cannot hold the scope open.
        toolGate.open()

        expect(yield* Fiber.await(run), "an interrupted run fails").toMatchObject({ _tag: "Failure" })
        yield* session.interrupt(HARNESS_SESSION)
        const afterInterrupt = yield* session.context(HARNESS_SESSION)

        yield* harness.replayProjection(HARNESS_SESSION)
        const afterReplay = yield* session.context(HARNESS_SESSION)

        harness.requests.length = 0
        yield* session.resume(HARNESS_SESSION)
        return { afterInterrupt, afterReplay }
      }),
      "claim — blocked tools fail durably on interruption",
    )

    const expected = [
      { type: "user", text: "Interrupt blocked tool" },
      {
        type: "assistant",
        content: [
          {
            type: "tool",
            id: "call-before-interrupt",
            state: { status: "error", error: { type: "unknown", message: "Tool execution interrupted" } },
          },
        ],
      },
    ]
    expect(afterInterrupt).toMatchObject(expected)
    expect(afterReplay, "the failure is durable, not just live").toMatchObject(expected)
    // And the next turn sees it as a settled tool result, not an open call.
    expect(harness.requests[0]?.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
  })

  test("does not continue automatically after a provider error follows a local tool call", async () => {
    // A tool ran, then the provider failed. The tool's result exists and is durable — but the runner
    // must NOT auto-continue into a second turn to deliver it.
    //
    // ⭐ Why that restraint is the claim: continuing would re-enter the provider that just failed,
    // usually failing again, and on a local model each attempt is expensive. The work is preserved;
    // the decision to retry belongs to whoever resumes the session, not to the failure path.
    const harness = makeRunnerHarness({
      turns: [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-before-provider-error", name: "echo", input: { text: "settled" } }),
          LLMEvent.providerError({ message: "Provider unavailable" }),
        ],
      ],
    })

    await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Do not continue failed provider" }),
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
      }),
      "claim — no auto-continue after a provider error",
    )

    expect(harness.requests, "exactly one turn — the failure must not trigger a continuation").toHaveLength(1)
    // …and the tool still ran, so the restraint is about CONTINUING, not about abandoning work.
    expect(harness.executions).toEqual(["settled"])
  })

  test("interrupts a blocked provider turn without local tool execution", async () => {
    // The turn is interrupted while the provider is still holding the stream open — before any tool
    // exists. The claim is that interruption is CLEAN in that state: the run fails with interrupts
    // only, not with a manufactured error, and the request that was already sent is not re-sent.
    //
    // ⭐ `hasInterruptsOnly` is the load-bearing part. A run that failed with a wrapped error would
    // look identical to a caller checking only "did it fail", while telling the recovery UI that
    // something went wrong rather than that the user stopped it — ruling 2's "a fault is never
    // described falsely" applied to a non-fault.
    const streamStarted = makeLatch()
    const streamGate = makeLatch()
    const harness = makeRunnerHarness({ turns: [completeTurn("t1", "One")] })
    harness.controls.streamStarted = streamStarted
    harness.controls.streamGate = streamGate

    const exit = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Interrupt provider" }),
          resume: false,
        })
        const run = yield* session.resume(HARNESS_SESSION).pipe(Effect.forkChild)
        yield* Effect.promise(() => streamStarted.promise)
        yield* session.interrupt(HARNESS_SESSION)
        const exit = yield* Fiber.await(run)
        // Release so the abandoned stream cannot hold the scope open.
        streamGate.open()
        yield* session.interrupt(HARNESS_SESSION)
        return exit
      }),
      "claim — a blocked provider turn interrupts cleanly",
    )

    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause), "interrupted, not errored").toBeTrue()
    expect(harness.requests).toHaveLength(1)
  })

  test("durably fails blocked local tools when interrupted while awaiting settlement", async () => {
    // The third interruption variant, and the narrowest: the turn has FINISHED arriving
    // (stepFinish + finish) and the runner is awaiting the tool's settlement when it is interrupted.
    // The tool must still be closed durably — a turn that completed its stream is not a turn whose
    // tools may be left open.
    const toolGate = makeLatch()
    const harness = makeRunnerHarness({
      turns: [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-await-interrupt", name: "echo", input: { text: "blocked" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
      ],
    })
    harness.controls.toolGate = toolGate

    const context = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Interrupt tool settlement" }),
          resume: false,
        })
        const runner = yield* SessionRunner.Service
        const run = yield* runner.run({ sessionID: HARNESS_SESSION, force: true }).pipe(Effect.forkChild)
        yield* waitForExecution(harness)
        yield* Fiber.interrupt(run)
        toolGate.open()

        expect(yield* Fiber.await(run)).toMatchObject({ _tag: "Failure" })
        return yield* session.context(HARNESS_SESSION)
      }),
      "claim — tools awaiting settlement fail durably on interrupt",
    )

    expect(context).toMatchObject([
      { type: "user", text: "Interrupt tool settlement" },
      {
        type: "assistant",
        content: [
          {
            type: "tool",
            id: "call-await-interrupt",
            state: { status: "error", error: { type: "unknown", message: "Tool execution interrupted" } },
          },
        ],
      },
    ])
  })
})
