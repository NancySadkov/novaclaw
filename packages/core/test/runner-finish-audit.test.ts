import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLMEvent } from "@novaclaw/llm"
import { FinishAudit } from "@novaclaw/core/session/runner/finish-audit"
import { SessionV2 } from "@novaclaw/core/session"
import { Prompt } from "@novaclaw/core/session/prompt"
import { HARNESS_SESSION, completeTurn, drive, makeRunnerHarness } from "./fixture/runner-harness"

const exitTurn = (result: string): LLMEvent[] => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolCall({ id: "exit-call", name: "exit", input: { result } }),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
  LLMEvent.finish({ reason: "tool-calls" }),
]

const runAudit = async (answer: "YES" | "NO") => {
  const harness = makeRunnerHarness({
    withExitTool: true,
    turns: [exitTurn("implemented and verified"), completeTurn("continued", "Continued after rejection")],
    utilityTurns: [completeTurn("audit", answer)],
  })
  let transcript: { type: string; text?: string }[] = []
  let result: unknown
  await drive(
    harness,
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID: HARNESS_SESSION,
        prompt: Prompt.make({ text: "Do the work, then exit." }),
        resume: false,
      })
      yield* session.resume(HARNESS_SESSION)
      transcript = (yield* session.context(HARNESS_SESSION)) as typeof transcript
      result = (yield* session.get(HARNESS_SESSION)).result
    }),
    `exit completion audit ${answer}`,
  )
  return { harness, transcript, result }
}

describe("exit requests are reviewed before completion", () => {
  test("YES publishes the durable result without another interactive turn", async () => {
    const { harness, result } = await runAudit("YES")
    expect(harness.utilityRequests).toHaveLength(1)
    expect(JSON.stringify(harness.utilityRequests[0]?.messages)).toContain("actually complete")
    expect(harness.requests).toHaveLength(1)
    expect(result).toBe("implemented and verified")
  })

  test("NO is the completion path's sole automatic continuation steer", async () => {
    const { harness, transcript, result } = await runAudit("NO")
    expect(harness.utilityRequests).toHaveLength(1)
    expect(result).toBeUndefined()
    expect(
      transcript.some((message) => message.type === "user" && message.text?.includes(FinishAudit.CONTINUE_NUDGE)),
    ).toBe(true)
    expect(
      transcript.some(
        (message) => message.type === "assistant" && JSON.stringify(message).includes("Continued after rejection"),
      ),
    ).toBe(true)
  })

  test("a healthy turn without exit is neither reviewed nor steered", async () => {
    const harness = makeRunnerHarness({
      turns: [completeTurn("ordinary", "Work is still in progress; I have not requested completion.")],
    })
    let transcript: { type: string; text?: string }[] = []
    await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Begin the work." }),
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
        transcript = (yield* session.context(HARNESS_SESSION)) as typeof transcript
      }),
      "healthy turn without completion audit",
    )

    expect(harness.requests).toHaveLength(1)
    expect(harness.utilityRequests).toHaveLength(0)
    expect(transcript.some((message) => message.type === "user" && message.text?.includes("Automated steer"))).toBe(
      false,
    )
  })
})
