import { expect, test } from "bun:test"
import { DateTime, Effect } from "effect"
import { eq } from "drizzle-orm"
import { AgentV2 } from "../src/agent"
import { AgentConfigStore } from "../src/agent-config-store"
import { Database } from "../src/database/database"
import { EventV2 } from "../src/event"
import { ModelV2 } from "../src/model"
import { ProviderV2 } from "../src/provider"
import { SessionV2 } from "../src/session"
import { SessionEvent } from "../src/session/event"
import { SessionInput } from "../src/session/input"
import { SessionMessage } from "../src/session/message"
import { SessionRunner } from "../src/session/runner"
import { SessionTable } from "../src/session/sql"
import { HARNESS_SESSION, completeTurn, drive, makeRunnerHarness } from "./fixture/runner-harness"

const chatMode = Effect.gen(function* () {
  const agents = yield* AgentV2.Service
  yield* agents.transform((draft) =>
    draft.update(AgentV2.ID.make("chat_test"), (agent) => {
      agent.kind = "chat"
      agent.system = "The user's personality instructions."
      agent.mode = "primary"
    }),
  )
  yield* (yield* AgentConfigStore.Service).setLayers("chat_test", [{ kind: "chat" }])
  const { db } = yield* Database.Service
  yield* db
    .update(SessionTable)
    .set({ agent: "chat_test", short_chat: false })
    .where(eq(SessionTable.id, HARNESS_SESSION))
    .run()
    .pipe(Effect.orDie)
})

test("Chat recovers an interrupted reply without restart messages, nudges, or a harness system prompt", async () => {
  const harness = makeRunnerHarness({ turns: [completeTurn("chat-recovered", "Here is your answer.")] })
  const context = await drive(
    harness,
    Effect.gen(function* () {
      yield* chatMode
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      yield* session.prompt({
        sessionID: HARNESS_SESSION,
        prompt: { text: "Please continue our conversation." },
        resume: false,
      })
      yield* SessionInput.promoteNextQueued(db, events, HARNESS_SESSION)
      yield* events.publish(SessionEvent.Synthetic, {
        sessionID: HARNESS_SESSION,
        messageID: SessionMessage.ID.create(),
        timestamp: yield* DateTime.now,
        text: "Old automated diagnostic.",
      })
      const timestamp = yield* DateTime.now
      yield* events.publish(SessionEvent.ProviderAttempt.Started, {
        sessionID: HARNESS_SESSION,
        timestamp,
        recovery: {
          attemptID: EventV2.ID.create(),
          assistantMessageID: SessionMessage.ID.create(),
          model: { id: ModelV2.ID.make(harness.model.id), providerID: ProviderV2.ID.make(harness.model.provider) },
          startedAt: timestamp,
          toolProtocol: false,
        },
      })
      yield* SessionRunner.Service.use((runner) => runner.run({ sessionID: HARNESS_SESSION, force: false }))
      return yield* session.context(HARNESS_SESSION)
    }),
    "Chat-mode automatic recovery",
  )
  expect(harness.requests).toHaveLength(1)
  const request = harness.requests[0]!
  expect(request.system.map((part) => part.text)).toEqual(["The user's personality instructions."])
  expect(request.tools).toHaveLength(0)
  expect(JSON.stringify(request.messages)).not.toContain("Old automated diagnostic")
  expect(JSON.stringify(request.messages)).not.toContain("Session restarted")
  expect(JSON.stringify(context)).not.toContain("Session restarted")
  expect(context.at(-1)).toMatchObject({ type: "assistant", finish: "stop" })
})

test("an empty Chat reply retries without inserting a nudge", async () => {
  const harness = makeRunnerHarness({ turns: [completeTurn("empty", ""), completeTurn("answer", "A visible answer.")] })
  const context = await drive(
    harness,
    Effect.gen(function* () {
      yield* chatMode
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: { text: "Hello" }, resume: false })
      yield* session.resume(HARNESS_SESSION)
      return yield* session.context(HARNESS_SESSION)
    }),
    "Chat-mode empty reply recovery",
  )
  expect(harness.requests).toHaveLength(2)
  expect(context.filter((message) => message.type === "user")).toHaveLength(1)
  expect(JSON.stringify(harness.requests)).not.toContain("Automated NovaClaw")
})

test("a queued nudge from Agent mode cannot wake a Chat after switching modes", async () => {
  const harness = makeRunnerHarness({ turns: [completeTurn("must-not-run", "Wrong")] })
  await drive(
    harness,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* SessionInput.steer(db, events, HARNESS_SESSION, "Continue working")
      yield* chatMode
      yield* SessionRunner.Service.use((runner) => runner.run({ sessionID: HARNESS_SESSION, force: false }))
      expect(yield* SessionInput.listPending(db, HARNESS_SESSION)).toEqual([])
    }),
    "discard an old nudge after switching modes",
  )
  expect(harness.requests).toHaveLength(0)
})

test("the owner records saved messages and a forced resume never runs a model", async () => {
  const harness = makeRunnerHarness({ turns: [completeTurn("must-not-run", "Wrong")] })
  const context = await drive(
    harness,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .update(SessionTable)
        .set({ agent: "owner" })
        .where(eq(SessionTable.id, HARNESS_SESSION))
        .run()
        .pipe(Effect.orDie)
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: { text: "Saved for later." }, resume: false })
      yield* (yield* EventV2.Service).publish(SessionEvent.PromptAdmitted, {
        sessionID: HARNESS_SESSION,
        messageID: SessionMessage.ID.create(),
        timestamp: yield* DateTime.now,
        prompt: { text: "Recovered after a restart.", files: [], agents: [] },
        delivery: "queue",
      })
      yield* session.resume(HARNESS_SESSION)
      return yield* session.context(HARNESS_SESSION)
    }),
    "Human-mode forced resume",
  )
  expect(context).toHaveLength(2)
  expect(context[0]).toMatchObject({ type: "user", text: "Saved for later." })
  expect(context[1]).toMatchObject({ type: "user", text: "Recovered after a restart." })
  expect(harness.requests).toHaveLength(0)
  expect(harness.utilityRequests).toHaveLength(0)
})
