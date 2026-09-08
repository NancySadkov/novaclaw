import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLMEvent } from "@novaclaw/llm"
import { FinishAudit } from "@novaclaw/core/session/runner/finish-audit"
import { SessionV2 } from "@novaclaw/core/session"
import { Prompt } from "@novaclaw/core/session/prompt"
import { HARNESS_SESSION, completeTurn, drive, makeRunnerHarness } from "./fixture/runner-harness"

const toolTurn = (): LLMEvent[] => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolCall({ id: "call-1", name: "echo", input: { text: "worked" } }),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
  LLMEvent.finish({ reason: "tool-calls" }),
]

const silentTurn = (): LLMEvent[] => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.stepFinish({ index: 0, reason: "stop" }),
  LLMEvent.finish({ reason: "stop" }),
]

const runAudit = async (answer: "YES" | "NO") => {
  const harness = makeRunnerHarness({
    turns: [toolTurn(), silentTurn(), completeTurn("recovered", "Recovered response")],
    utilityTurns: [completeTurn("audit", answer)],
  })
  let transcript: { type: string; text?: string }[] = []
  await drive(
    harness,
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID: HARNESS_SESSION,
        prompt: Prompt.make({ text: "Do the work and report back." }),
        resume: false,
      })
      yield* session.resume(HARNESS_SESSION)
      transcript = (yield* session.context(HARNESS_SESSION)) as typeof transcript
    }),
    `silent finish audit ${answer}`,
  )
  return { harness, transcript }
}

describe("silent tool-bearing finishes are audited before the run settles", () => {
  test("NO resumes concrete work", async () => {
    const { harness, transcript } = await runAudit("NO")
    expect(harness.utilityRequests).toHaveLength(1)
    expect(JSON.stringify(harness.utilityRequests[0]?.messages)).toContain("actually complete")
    expect(transcript.some((message) => message.type === "user" && message.text?.includes(FinishAudit.CONTINUE_NUDGE)))
      .toBe(true)
    expect(transcript.some((message) => message.type === "assistant" && JSON.stringify(message).includes("Recovered response")))
      .toBe(true)
  })

  test("YES forces the missing user-facing reply", async () => {
    const { transcript } = await runAudit("YES")
    expect(transcript.some((message) => message.type === "user" && message.text?.includes(FinishAudit.REPLY_NUDGE)))
      .toBe(true)
    expect(transcript.some((message) => message.type === "assistant" && JSON.stringify(message).includes("Recovered response")))
      .toBe(true)
  })
})
