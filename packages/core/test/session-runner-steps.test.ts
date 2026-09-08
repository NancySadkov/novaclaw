import { describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { LLMEvent } from "@novaclaw/llm"
import { AgentV2 } from "@novaclaw/core/agent"
import { SessionV2 } from "@novaclaw/core/session"
import { Prompt } from "@novaclaw/core/session/prompt"
import { HARNESS_SESSION, drive, makeLatch, makeRunnerHarness } from "./fixture/runner-harness"

/**
 * PORTED CLAIMS — the agent's configured step allowance.
 *
 * Rewritten against the current runner on a harness that runs on **win32** (S3; ledger in
 * `session-runner-claims.test.ts`).
 *
 * ⭐ **A step limit that merely STOPPED would be a worse product than no limit at all.** The session
 * would end mid-task with the last thing in the transcript being a tool call nobody answered, and the
 * user would have no idea whether the work was done. So the limit does not halt the agent — it forces
 * the final turn to be a TEXT response, with the tools withdrawn so the model cannot call one, and
 * tells it in-band that it has reached the end.
 */

const toolCallTurn = (id: string, text: string) => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolCall({ id, name: "echo", input: { text } }),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
  LLMEvent.finish({ reason: "tool-calls" }),
]

describe("SessionRunnerLLM — step allowance", () => {
  test("forces a text response on an agent's configured final step", async () => {
    const harness = makeRunnerHarness({
      turns: [toolCallTurn("call-terminal", "done"), toolCallTurn("call-forbidden", "forbidden")],
    })

    await drive(
      harness,
      Effect.gen(function* () {
        const agents = yield* AgentV2.Service
        yield* agents.transform((editor) =>
          editor.update(AgentV2.ID.make("build"), (agent) => {
            agent.steps = 2
          }),
        )
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Finish at the limit" }),
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
      }),
      "claim — the final step forces a text response",
    )

    expect(harness.requests).toHaveLength(2)
    // The first turn is unconstrained…
    expect(harness.requests[0]?.toolChoice).toBeUndefined()
    // …and the last one cannot call a tool even if it wants to. Both halves matter: telling the model
    // to stop while leaving the tools attached would make compliance optional.
    expect(harness.requests[1]?.toolChoice).toMatchObject({ type: "none" })
    expect(harness.requests[1]?.tools).toEqual([])
    expect(harness.requests[1]?.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: expect.stringContaining("MAXIMUM STEPS REACHED") }],
    })
    // The forbidden call in the scripted second turn never ran.
    expect(harness.executions).toEqual(["done"])
  })

  test("resets the configured step allowance when steering input promotes", async () => {
    // A steer RESETS the budget. The agent is allowed two steps; it uses one, the user steers, and it
    // gets a fresh two — so turn 2 is unconstrained and only turn 3 is forced to text.
    //
    // ⭐ Why the reset is right rather than lenient: the allowance exists to stop an agent looping on
    // its OWN plan. A steer is new instruction from the user, so the work after it is not the work the
    // budget was counting. Without the reset, steering a long task would hand the model one step and
    // then gag it — the limit would punish the user for participating.
    const streamStarted = makeLatch()
    const streamGate = makeLatch()
    const harness = makeRunnerHarness({
      turns: [
        toolCallTurn("call-before-steer", "before"),
        toolCallTurn("call-after-steer", "after"),
        // ⚠️ A REAL reply, not a bare stepStart/stepFinish. A turn that produces no text and calls no
        // tool makes the runner append its no-reply nudge and a further turn — the request count goes
        // to four and the claim looks broken. (Documented in session-runner-fragments.test.ts.)
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.textStart({ id: "text-final" }),
          LLMEvent.textDelta({ id: "text-final", text: "Finished" }),
          LLMEvent.textEnd({ id: "text-final" }),
          LLMEvent.stepFinish({ index: 0, reason: "stop" }),
          LLMEvent.finish({ reason: "stop" }),
        ],
      ],
    })
    harness.controls.streamStarted = streamStarted
    harness.controls.streamGate = streamGate

    await drive(
      harness,
      Effect.gen(function* () {
        const agents = yield* AgentV2.Service
        yield* agents.transform((editor) =>
          editor.update(AgentV2.ID.make("build"), (agent) => {
            agent.steps = 2
          }),
        )
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Start work" }),
          resume: false,
        })

        const run = yield* session.resume(HARNESS_SESSION).pipe(Effect.forkChild)
        yield* Effect.promise(() => streamStarted.promise)
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Change direction" }) })
        streamGate.open()
        yield* Fiber.join(run)
      }),
      "claim — a steer resets the step allowance",
    )

    expect(harness.requests).toHaveLength(3)
    // Turn 2 comes AFTER the steer and is unconstrained — this is the reset.
    expect(harness.requests[1]?.toolChoice, "the steer bought a fresh allowance").toBeUndefined()
    expect(harness.requests[1]?.tools).not.toEqual([])
    // Turn 3 is the new final step.
    expect(harness.requests[2]?.toolChoice).toMatchObject({ type: "none" })
    expect(harness.executions).toEqual(["before", "after"])
  })
})
