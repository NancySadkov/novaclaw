import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import { eq } from "drizzle-orm"
import { LLMEvent } from "@novaclaw/llm"
import { EventV2 } from "@novaclaw/core/event"
import { EventTable } from "@novaclaw/core/event/sql"
import { FinishAudit } from "@novaclaw/core/session/runner/finish-audit"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionEvent } from "@novaclaw/core/session/event"
import { SessionMessage } from "@novaclaw/core/session/message"
import { Prompt } from "@novaclaw/core/session/prompt"
import { Database } from "@novaclaw/core/database/database"
import { SessionTable } from "@novaclaw/core/session/sql"
import { BashJobTable } from "@novaclaw/core/tool/bash-jobs.sql"
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
      if (answer === "YES") yield* session.resume(HARNESS_SESSION)
      else {
        const events = yield* EventV2.Service
        const continued = yield* events.subscribe(SessionEvent.Text.Ended).pipe(
          Stream.filter((event) => event.data.sessionID === HARNESS_SESSION && event.data.text.includes("Continued after rejection")),
          Stream.take(1), Stream.runHead, Effect.forkScoped,
        )
        yield* Effect.yieldNow
        const running = yield* session.resume(HARNESS_SESSION).pipe(Effect.forkChild)
        yield* Fiber.join(continued)
        yield* session.interrupt(HARNESS_SESSION)
        yield* Fiber.await(running)
      }
      transcript = (yield* session.context(HARNESS_SESSION)) as typeof transcript
      result = (yield* session.get(HARNESS_SESSION)).result
    }),
    `exit completion audit ${answer}`,
  )
  return { harness, transcript, result }
}

describe("exit requests are reviewed before completion", () => {
  test("YES publishes the durable result without another interactive turn", async () => {
    const { harness, transcript, result } = await runAudit("YES")
    expect(harness.utilityRequests).toHaveLength(1)
    expect(JSON.stringify(harness.utilityRequests[0]?.messages)).toContain("actually complete")
    expect(harness.requests).toHaveLength(1)
    expect(result).toBe("implemented and verified")
    expect(
      transcript.some(
        (message) =>
          message.type === "assistant" &&
          JSON.stringify(message).includes('"acceptedExit":{"result":"implemented and verified"'),
      ),
    ).toBe(true)
  })

  test("a goal-oriented officer records the accepted boundary, sleeps, and remains alive until Stop", async () => {
    const harness = makeRunnerHarness({
      withExitTool: true,
      turns: [exitTurn("goal checkpoint complete")],
      utilityTurns: [completeTurn("audit", "YES")],
    })
    const observed = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        const { db } = yield* Database.Service
        const events = yield* EventV2.Service
        yield* db.update(SessionTable).set({ type: "goal-oriented" }).where(eq(SessionTable.id, HARNESS_SESSION)).run()
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Keep checking this goal until I press Stop." }),
          resume: false,
        })

        const accepted = yield* events.subscribe(SessionEvent.ExitAccepted).pipe(
          Stream.filter((event) => event.data.sessionID === HARNESS_SESSION),
          Stream.take(1),
          Stream.runHead,
          Effect.forkScoped,
        )
        yield* Effect.yieldNow
        const run = yield* session.resume(HARNESS_SESSION).pipe(Effect.forkChild)
        const boundary = yield* Fiber.join(accepted)
        const steeringID = SessionMessage.ID.make("msg_wake_sleeping_goal")
        const promoted = yield* events.subscribe(SessionEvent.Prompted).pipe(
          Stream.filter((event) => event.data.messageID === steeringID),
          Stream.take(1),
          Stream.runHead,
          Effect.forkScoped,
        )
        yield* Effect.yieldNow
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          id: steeringID,
          prompt: Prompt.make({ text: "Wake now: here is a new hint." }),
        })
        const wake = yield* Fiber.join(promoted)
        const beforeStop = yield* session.get(HARNESS_SESSION)
        const transcript = yield* session.context(HARNESS_SESSION)
        yield* session.interrupt(HARNESS_SESSION)
        const stopped = yield* Fiber.await(run)
        const terminalEvents = yield* db
          .select({ type: EventTable.type })
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, HARNESS_SESSION))
          .all()
        return { boundary, wake, beforeStop, transcript, stopped, terminalEvents }
      }),
      "goal exit sleeps until stop",
    )

    expect(observed.boundary._tag).toBe("Some")
    expect(observed.wake._tag).toBe("Some")
    expect(observed.beforeStop.result).toBeUndefined()
    expect(
      observed.transcript.some((message) => message.type === "assistant" && message.acceptedExit !== undefined),
    ).toBe(true)
    expect(observed.stopped._tag).toBe("Failure")
    expect(observed.terminalEvents.map((event) => event.type)).not.toContain(
      EventV2.versionedType(SessionEvent.Completed.type, 1),
    )
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

  test("a running background shell refuses exit before the completion auditor", async () => {
    const harness = makeRunnerHarness({
      withExitTool: true,
      turns: [exitTurn("done"), completeTurn("continued", "I will settle the background job first.")],
      utilityTurns: [completeTurn("audit", "YES")],
    })
    let transcript: { type: string; text?: string }[] = []
    let result: unknown
    await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Run the build in the background, then finish." }),
          resume: false,
        })
        const { db } = yield* Database.Service
        yield* db
          .insert(BashJobTable)
          .values({
            id: "job_build",
            owner: HARNESS_SESSION,
            command: "bun run build",
            status: "running",
            time_started: Date.now(),
          })
          .run()
          .pipe(Effect.orDie)
        const events = yield* EventV2.Service
        const continued = yield* events.subscribe(SessionEvent.Text.Ended).pipe(
          Stream.filter((event) => event.data.sessionID === HARNESS_SESSION && event.data.text.includes("I will settle the background job first.")),
          Stream.take(1), Stream.runHead, Effect.forkScoped,
        )
        yield* Effect.yieldNow
        const running = yield* session.resume(HARNESS_SESSION).pipe(Effect.forkChild)
        yield* Fiber.join(continued)
        yield* session.interrupt(HARNESS_SESSION)
        yield* Fiber.await(running)
        transcript = (yield* session.context(HARNESS_SESSION)) as typeof transcript
        result = (yield* session.get(HARNESS_SESSION)).result
      }),
      "running shell blocks exit",
    )

    expect(harness.utilityRequests).toHaveLength(0)
    expect(result).toBeUndefined()
    expect(
      transcript.some(
        (message) =>
          message.type === "user" &&
          message.text?.includes("background shell command is still running") &&
          message.text.includes('"job":"job_build"'),
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
        const events = yield* EventV2.Service
        const continued = yield* events.subscribe(SessionEvent.Text.Ended).pipe(
          Stream.filter((event) => event.data.sessionID === HARNESS_SESSION && event.data.text.includes("Work is still in progress")),
          Stream.take(1), Stream.runHead, Effect.forkScoped,
        )
        yield* Effect.yieldNow
        const running = yield* session.resume(HARNESS_SESSION).pipe(Effect.forkChild)
        yield* Fiber.join(continued)
        yield* session.interrupt(HARNESS_SESSION)
        yield* Fiber.await(running)
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
