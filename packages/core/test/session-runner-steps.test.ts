import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLMEvent } from "@novaclaw/llm"
import { AgentV2 } from "@novaclaw/core/agent"
import { SessionV2 } from "@novaclaw/core/session"
import { Prompt } from "@novaclaw/core/session/prompt"
import { HARNESS_SESSION, drive, makeRunnerHarness } from "./fixture/runner-harness"

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
})
