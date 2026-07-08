import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Flag } from "@novaclaw/core/flag/flag"
import { Deferred, Effect, Latch, Option, Schema, Stream } from "effect"
import type { NovaClawEvent } from "../src"

// SKIPPED: @novaclaw/sdk-next has no consumers yet (an unwired island), and the embedded runner these
// tests boot can't resolve its `test/embedded` model (no catalog seed) — they aren't testing anything
// wired into the product. Un-skip when sdk-next is adopted AND the embedded runner seeds a model.
// See todo.md → "Test-suite hygiene".

test.skip("embedded client uses the real router and handlers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "novaclaw-embedded-"))
  const database = Flag.NOVACLAW_DB
  Flag.NOVACLAW_DB = join(directory, "novaclaw.sqlite")
  const { AbsolutePath, Agent, Location, Model, NovaClaw, Prompt, Provider, Session, Tool } = await import("../src")
  const sessionID = Session.ID.make(`ses_embedded_${crypto.randomUUID()}`)
  const model = Model.Ref.make({ id: Model.ID.make("embedded"), providerID: Provider.ID.make("test") })

  try {
    const program = Effect.gen(function* () {
      const novaclaw = yield* NovaClaw.create()
      yield* novaclaw.tools.register({
        embedded_tool: Tool.make({
          description: "Embedded test tool",
          input: Schema.Struct({}),
          output: Schema.Struct({ ok: Schema.Boolean }),
          execute: () => Effect.succeed({ ok: true }),
        }),
      })

      const created = yield* novaclaw.sessions.create({
        id: sessionID,
        agent: Agent.ID.make("build"),
        location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      })
      yield* novaclaw.sessions.switchModel({ sessionID, model })
      const selected = yield* novaclaw.sessions.get({ sessionID })
      const page = yield* novaclaw.sessions.list({ directory: AbsolutePath.make(directory) })
      const active = yield* novaclaw.sessions.active()
      const admitted = yield* novaclaw.sessions.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Do not run" }),
        resume: false,
      })
      const context = yield* novaclaw.sessions.context({ sessionID })
      const wake = yield* novaclaw.sessions.prompt({
        sessionID,
        prompt: Prompt.make({ text: "Promote this input" }),
      })
      const prompted = yield* novaclaw.sessions.events({ sessionID }).pipe(
        Stream.filter((event) => event.type === "session.next.prompted" && event.data.messageID === wake.id),
        Stream.runHead,
        Effect.timeout("10 seconds"),
        Effect.map(Option.getOrThrow),
      )
      const wakeContext = yield* novaclaw.sessions.context({ sessionID })
      const event = yield* novaclaw.sessions
        .events({ sessionID })
        .pipe(Stream.take(1), Stream.runHead, Effect.map(Option.getOrUndefined))
      const modelMessage = Option.fromNullishOr(context.find((message) => message.type === "model-switched")).pipe(
        Option.getOrThrow,
      )
      const message = yield* novaclaw.sessions.message({ sessionID, messageID: modelMessage.id })
      yield* novaclaw.sessions.interrupt({ sessionID })
      const other = yield* novaclaw.sessions.create({
        location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      })
      const missingSessionID = Session.ID.make(`ses_missing_${crypto.randomUUID()}`)
      const missing = yield* Effect.all(
        [
          novaclaw.sessions.events({ sessionID: missingSessionID }).pipe(Stream.runHead, Effect.flip),
          novaclaw.sessions.interrupt({ sessionID: missingSessionID }).pipe(Effect.flip),
          novaclaw.sessions.message({ sessionID: missingSessionID, messageID: modelMessage.id }).pipe(Effect.flip),
        ],
        { concurrency: "unbounded" },
      )
      const missingMessage = yield* Effect.flip(
        novaclaw.sessions.message({
          sessionID: other.id,
          messageID: modelMessage.id,
        }),
      )

      expect(created.id).toBe(sessionID)
      expect(selected.model?.id).toBe(model.id)
      expect(selected.model?.providerID).toBe(model.providerID)
      expect(page.data.some((session) => session.id === sessionID)).toBe(true)
      expect(active).toEqual({})
      expect(admitted.sessionID).toBe(sessionID)
      expect(prompted.type).toBe("session.next.prompted")
      expect(wakeContext).toContainEqual(expect.objectContaining({ id: wake.id, type: "user" }))
      expect(context.some((message) => message.type === "model-switched")).toBe(true)
      expect(event).toMatchObject({ type: "session.next.model.switched", durable: { seq: 1 } })
      expect(message).toEqual(modelMessage)
      expect(missing.map((error) => error._tag)).toEqual([
        "SessionNotFoundError",
        "SessionNotFoundError",
        "SessionNotFoundError",
      ])
      expect(missingMessage._tag).toBe("MessageNotFoundError")
    })
    await Effect.runPromise(Effect.scoped(program))
  } finally {
    Flag.NOVACLAW_DB = database
    await rm(directory, { recursive: true, force: true })
  }
})

test.skip("Location-owned runner events reach the ready global client", async () => {
  const directory = await mkdtemp(join(tmpdir(), "novaclaw-embedded-events-"))
  const database = Flag.NOVACLAW_DB
  Flag.NOVACLAW_DB = join(directory, "novaclaw.sqlite")
  const { AbsolutePath, Location, NovaClaw, Prompt, Session } = await import("../src")
  const sessionID = Session.ID.make(`ses_embedded_${crypto.randomUUID()}`)

  try {
    const program = Effect.gen(function* () {
      const novaclaw = yield* NovaClaw.create()
      const connected = yield* Latch.make(false)
      const prompted = yield* Deferred.make<NovaClawEvent>()
      yield* novaclaw.events.subscribe().pipe(
        Stream.runForEach((event) =>
          event.type === "server.connected"
            ? connected.open
            : event.type === "session.next.prompted" && event.data.sessionID === sessionID
              ? Deferred.succeed(prompted, event).pipe(Effect.asVoid)
              : Effect.void,
        ),
        Effect.forkScoped,
      )
      yield* connected.await
      yield* novaclaw.sessions.create({
        id: sessionID,
        location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      })
      yield* novaclaw.sessions.prompt({ sessionID, prompt: Prompt.make({ text: "Observe this input" }) })

      const event = yield* Deferred.await(prompted).pipe(Effect.timeout("4 seconds"))
      expect(event.durable).toEqual(expect.objectContaining({ aggregateID: sessionID, seq: expect.any(Number) }))
    })
    await Effect.runPromise(Effect.scoped(program))
  } finally {
    Flag.NOVACLAW_DB = database
    await rm(directory, { recursive: true, force: true })
  }
}, 10_000)

test.skip("independent embedded hosts do not share live notifications", async () => {
  const directory = await mkdtemp(join(tmpdir(), "novaclaw-embedded-hosts-"))
  const database = Flag.NOVACLAW_DB
  Flag.NOVACLAW_DB = join(directory, "novaclaw.sqlite")
  const { AbsolutePath, Agent, Location, NovaClaw, Session } = await import("../src")
  const sessionID = Session.ID.make(`ses_embedded_${crypto.randomUUID()}`)

  try {
    const program = Effect.gen(function* () {
      const first = yield* NovaClaw.create()
      const second = yield* NovaClaw.create()
      const firstReady = yield* Latch.make(false)
      const secondReady = yield* Latch.make(false)
      const firstEvent = yield* Latch.make(false)
      const secondEvent = yield* Latch.make(false)
      const observe = (ready: Latch.Latch, event: Latch.Latch) =>
        Stream.runForEach((notification: NovaClawEvent) =>
          notification.type === "server.connected"
            ? ready.open
            : notification.type === "session.next.agent.switched" && notification.data.sessionID === sessionID
              ? event.open
              : Effect.void,
        )

      yield* first.events.subscribe().pipe(observe(firstReady, firstEvent), Effect.forkScoped)
      yield* second.events.subscribe().pipe(observe(secondReady, secondEvent), Effect.forkScoped)
      yield* Effect.all([firstReady.await, secondReady.await], { discard: true })
      yield* first.sessions.create({
        id: sessionID,
        location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
      })
      yield* first.sessions.switchAgent({ sessionID, agent: Agent.ID.make("plan") })

      yield* firstEvent.await.pipe(Effect.timeout("2 seconds"))
      expect(Option.isNone(yield* secondEvent.await.pipe(Effect.timeoutOption("100 millis")))).toBe(true)
    })
    await Effect.runPromise(Effect.scoped(program))
  } finally {
    Flag.NOVACLAW_DB = database
    await rm(directory, { recursive: true, force: true })
  }
}, 10_000)

test.skip("embedded client is available as a Layer service", async () => {
  const directory = await mkdtemp(join(tmpdir(), "novaclaw-embedded-layer-"))
  const database = Flag.NOVACLAW_DB
  Flag.NOVACLAW_DB = join(directory, "novaclaw.sqlite")
  const { AbsolutePath, Location, NovaClaw, Session } = await import("../src")
  const sessionID = Session.ID.make(`ses_embedded_${crypto.randomUUID()}`)

  try {
    const created = await Effect.runPromise(
      Effect.gen(function* () {
        const novaclaw = yield* NovaClaw.Service
        return yield* novaclaw.sessions.create({
          id: sessionID,
          location: Location.Ref.make({ directory: AbsolutePath.make(directory) }),
        })
      }).pipe(Effect.provide(NovaClaw.layer), Effect.scoped),
    )

    expect(created.id).toBe(sessionID)
  } finally {
    Flag.NOVACLAW_DB = database
    await rm(directory, { recursive: true, force: true })
  }
})
