import { expect, test } from "bun:test"
import { Effect } from "effect"
import { LLMEvent } from "@novaclaw/llm"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionExecutionAttempt } from "@novaclaw/core/session/execution-attempt"
import { Prompt } from "@novaclaw/core/session/prompt"
import { SessionRunner } from "@novaclaw/core/session/runner"
import { HARNESS_SESSION, completeTurn, drive, makeRunnerHarness } from "./fixture/runner-harness"

test("a scheduling handoff finishes tools and resumes from their durable results", async () => {
  const harness = makeRunnerHarness({
    withExitTool: true,
    utilityTurns: [completeTurn("audit", "YES")],
    turns: [
      [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-cooperate", name: "echo", input: { text: "saved result" } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ],
      [
        LLMEvent.stepStart({ index: 0 }),
        LLMEvent.toolCall({ id: "call-exit", name: "exit", input: { result: "Finished with the saved result." } }),
        LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
        LLMEvent.finish({ reason: "tool-calls" }),
      ],
    ],
  })
  const boundaries: string[] = []
  const current: SessionExecutionAttempt.CurrentInterface = {
    fence: { attemptID: "cooperate", generation: 1 },
    advance: (phase, checkpoint) =>
      Effect.sync(() => {
        boundaries.push(`${phase}:${checkpoint}`)
      }),
    cooperate: () =>
      Effect.gen(function* () {
        expect(harness.requests).toHaveLength(1)
        expect(harness.executions).toEqual(["saved result"])
        expect(boundaries.at(-1)).toBe("drain:mark")
        yield* Effect.interrupt
      }),
    toolDispatched: () => Effect.void,
    toolSettled: () => Effect.void,
    providerStarted: () => Effect.void,
    providerToolProtocol: () => Effect.void,
    providerSettled: () => Effect.void,
    servedBy: () => Effect.void,
    providerRecovery: () => Effect.succeed(undefined),
  }
  await drive(
    harness,
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const runner = yield* SessionRunner.Service
      yield* session.prompt({
        sessionID: HARNESS_SESSION,
        prompt: Prompt.make({ text: "Echo once and finish." }),
        resume: false,
      })
      const first = yield* runner
        .run({ sessionID: HARNESS_SESSION, force: true })
        .pipe(Effect.provideService(SessionExecutionAttempt.Current, current), Effect.exit)
      expect(first._tag).toBe("Failure")
      yield* runner.run({ sessionID: HARNESS_SESSION, force: true })
      expect((yield* session.get(HARNESS_SESSION)).result).toBe("Finished with the saved result.")
    }),
    "cooperative turn boundary",
  )
  expect(harness.requests).toHaveLength(2)
  expect(harness.executions).toEqual(["saved result"])
})
