import { describe, expect, test } from "bun:test"
import { DateTime, Effect } from "effect"
import { ModelV2 } from "@novaclaw/core/model"
import { ProviderV2 } from "@novaclaw/core/provider"
import { Database } from "@novaclaw/core/database/database"
import { EventV2 } from "@novaclaw/core/event"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionEvent } from "@novaclaw/core/session/event"
import { SessionInput } from "@novaclaw/core/session/input"
import { SessionMessage } from "@novaclaw/core/session/message"
import { Prompt } from "@novaclaw/core/session/prompt"
import { SessionRunner } from "@novaclaw/core/session/runner"
import { HARNESS_SESSION, completeTurn, drive, makeRunnerHarness, messageRoles } from "./fixture/runner-harness"

/**
 * PORTED CLAIMS — state left behind by a process that died mid-tool.
 *
 * Rewritten against the current runner on a harness that runs on **win32** (S3; ledger in
 * `session-runner-claims.test.ts`).
 *
 * ⭐ **These are the claims that make process isolation survivable, and they cannot be written any
 * other way.** A crash cannot be simulated by interrupting a fiber — that runs finalizers, which is the
 * opposite of what a crash does. So the setup PUBLISHES the events a dead process would have left
 * behind and starts a fresh drain over them. The claim is that the new process closes the orphan
 * durably instead of waiting on a tool nobody is running, or worse, re-sending it to the model as
 * though it were still in flight.
 */

/** Replay the events a process would have left behind after dying mid-tool-call. */
const orphanToolCall = (input: {
  callID: string
  assistantMessageID: SessionMessage.ID
  providerExecuted: boolean
  /** Stop after `Input.Started` — the process died before the input was even complete. */
  stopAfterInputStart?: boolean
  metadata?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
}) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    yield* events.publish(SessionEvent.Step.Started, {
      sessionID: HARNESS_SESSION,
      assistantMessageID: input.assistantMessageID,
      timestamp: yield* DateTime.now,
      agent: "build",
      model: { id: ModelV2.ID.make("harness-model"), providerID: ProviderV2.ID.make("harness") },
    })
    yield* events.publish(SessionEvent.Tool.Input.Started, {
      sessionID: HARNESS_SESSION,
      timestamp: yield* DateTime.now,
      assistantMessageID: input.assistantMessageID,
      callID: input.callID,
      name: "echo",
    })
    if (input.stopAfterInputStart) return
    yield* events.publish(SessionEvent.Tool.Input.Ended, {
      sessionID: HARNESS_SESSION,
      timestamp: yield* DateTime.now,
      assistantMessageID: input.assistantMessageID,
      callID: input.callID,
      text: '{"text":"stale"}',
    })
    yield* events.publish(SessionEvent.Tool.Called, {
      sessionID: HARNESS_SESSION,
      timestamp: yield* DateTime.now,
      assistantMessageID: input.assistantMessageID,
      callID: input.callID,
      tool: "echo",
      sideEffect: "external-unknown",
      input: { text: "stale" },
      provider: input.metadata
        ? { executed: input.providerExecuted, metadata: input.metadata }
        : { executed: input.providerExecuted },
    })
  })

describe("SessionRunnerLLM — recovery from a prior process", () => {
  test("an automatic wake with no pending input durably steers an interrupted provider turn back into the task", async () => {
    const harness = makeRunnerHarness({ turns: [completeTurn("t1", "Recovered and continued")] })
    const recovery = {
      attemptID: EventV2.ID.create(),
      assistantMessageID: SessionMessage.ID.create(),
      model: { id: ModelV2.ID.make("harness-model"), providerID: ProviderV2.ID.make("harness") },
      startedAt: DateTime.makeUnsafe(1234),
      toolProtocol: true,
    }

    await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        const events = yield* EventV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Finish the interrupted task" }),
          resume: false,
        })
        yield* SessionInput.promoteSteers(
          (yield* Database.Service).db,
          events,
          HARNESS_SESSION,
          Number.MAX_SAFE_INTEGER,
        )
        yield* SessionInput.promoteNextQueued((yield* Database.Service).db, events, HARNESS_SESSION)
        yield* events.publish(SessionEvent.ProviderAttempt.Started, {
          sessionID: HARNESS_SESSION,
          timestamp: recovery.startedAt,
          recovery,
        })

        // This is the production recovery path: the stale-lease sweep calls `wake`, whose drain has
        // `force=false`. Manual `session.resume` forces a run and therefore hid the no-input early
        // return that abandoned the live Geryon chat.
        expect(yield* SessionInput.hasPending((yield* Database.Service).db, HARNESS_SESSION, "steer")).toBe(false)
        expect(yield* SessionInput.hasPending((yield* Database.Service).db, HARNESS_SESSION, "queue")).toBe(false)
        yield* SessionRunner.Service.use((runner) => runner.run({ sessionID: HARNESS_SESSION, force: false }))
      }),
      "claim — provider process loss resumes the task",
    )

    // The harness may issue its normal empty-response correction after the recovery turn; the
    // invariant here is that at least one actual provider request carries the durable continuation.
    const continued = harness.requests.find((request) =>
      JSON.stringify(request.messages).includes("Continue the user's task now"),
    )
    expect(continued, "the recovery steer never reached the model").toBeDefined()
    expect(continued?.messages.some((message) => message.role === "user")).toBe(true)
  })

  test("durably fails local tools left running by a prior process before continuing", async () => {
    const harness = makeRunnerHarness({ turns: [completeTurn("t1", "One")] })
    const assistantMessageID = SessionMessage.ID.create()

    const context = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        const events = yield* EventV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Recover interrupted tool" }),
          resume: false,
        })
        // Promote the prompt as the dead process would have, so the orphan sits after a real user turn.
        yield* SessionInput.promoteSteers(
          (yield* Database.Service).db,
          events,
          HARNESS_SESSION,
          Number.MAX_SAFE_INTEGER,
        )
        yield* orphanToolCall({ callID: "call-interrupted", assistantMessageID, providerExecuted: false })

        harness.requests.length = 0
        yield* session.resume(HARNESS_SESSION)
        return yield* session.context(HARNESS_SESSION)
      }),
      "claim — orphaned local tool closed before continuing",
    )

    expect(harness.requests).toHaveLength(1)
    // The continuation carries the orphan as a settled TOOL result — not as a call still awaiting one.
    expect(messageRoles(harness.requests[0]!)).toEqual(["user", "assistant", "tool"])
    expect(context).toMatchObject([
      { type: "user", text: "Recover interrupted tool" },
      {
        type: "assistant",
        content: [
          {
            type: "tool",
            id: "call-interrupted",
            state: { status: "error", error: { type: "unknown", message: "Tool execution interrupted" } },
          },
        ],
      },
      // The continuation turn's own reply. It exists because the recovery turn is scripted — an
      // unscripted one would now be a named provider fault, not silence.
      { type: "assistant", finish: "stop" },
    ])
  })

  test("durably fails hosted tools left running by a prior process before continuing inline", async () => {
    // Same orphan, but PROVIDER-executed — and the recovery is different in a way that matters. A local
    // orphan becomes a separate `tool` message; a hosted one must be closed INLINE, as a tool-result
    // beside its own tool-call inside the assistant message. Providers reject a hosted call that is not
    // answered in place, so a runner that recovered both the same way would produce a request the
    // provider refuses — the roles here are ["user","assistant"], with no third `tool` message.
    const harness = makeRunnerHarness({ turns: [completeTurn("t1", "One")] })
    const assistantMessageID = SessionMessage.ID.create()

    await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        const events = yield* EventV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Recover interrupted hosted tool" }),
          resume: false,
        })
        yield* SessionInput.promoteSteers(
          (yield* Database.Service).db,
          events,
          HARNESS_SESSION,
          Number.MAX_SAFE_INTEGER,
        )
        yield* orphanToolCall({
          callID: "call-hosted-interrupted",
          assistantMessageID,
          providerExecuted: true,
          metadata: { openai: { itemId: "call-hosted-interrupted" } },
        })

        harness.requests.length = 0
        yield* session.resume(HARNESS_SESSION)
      }),
      "claim — orphaned hosted tool closed inline",
    )

    expect(harness.requests).toHaveLength(1)
    expect(
      messageRoles(harness.requests[0]!),
      "a hosted orphan is answered INSIDE the assistant message, not as a separate tool message",
    ).toEqual(["user", "assistant"])
    expect(harness.requests[0]?.messages[1]?.content).toMatchObject([
      {
        type: "tool-call",
        id: "call-hosted-interrupted",
        providerExecuted: true,
        providerMetadata: { openai: { itemId: "call-hosted-interrupted" } },
      },
      { type: "tool-result", id: "call-hosted-interrupted", providerExecuted: true, result: { type: "error" } },
    ])
  })

  test("durably fails pending tool input left by a prior process before continuing", async () => {
    // The earliest possible orphan: the process died before the tool input was even complete, so there
    // is no `Called` event at all — only a started input. It must still be closed rather than left as a
    // half-written call that no later turn can interpret.
    const harness = makeRunnerHarness({ turns: [completeTurn("t1", "One")] })
    const assistantMessageID = SessionMessage.ID.create()

    const context = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        const events = yield* EventV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Recover pending tool input" }),
          resume: false,
        })
        yield* SessionInput.promoteSteers(
          (yield* Database.Service).db,
          events,
          HARNESS_SESSION,
          Number.MAX_SAFE_INTEGER,
        )
        yield* orphanToolCall({
          callID: "call-pending-interrupted",
          assistantMessageID,
          providerExecuted: false,
          stopAfterInputStart: true,
        })

        harness.requests.length = 0
        yield* session.resume(HARNESS_SESSION)
        return yield* session.context(HARNESS_SESSION)
      }),
      "claim — orphaned pending tool input closed",
    )

    expect(harness.requests).toHaveLength(1)
    expect(messageRoles(harness.requests[0]!)).toEqual(["user", "assistant", "tool"])
    expect(context).toMatchObject([
      { type: "user", text: "Recover pending tool input" },
      {
        type: "assistant",
        content: [{ type: "tool", id: "call-pending-interrupted", state: { status: "error" } }],
      },
      { type: "assistant", finish: "stop" },
    ])
  })
})
