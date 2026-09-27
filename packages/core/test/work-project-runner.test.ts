import { expect, test } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Fiber } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { EventV2 } from "@novaclaw/core/event"
import { SessionV2 } from "@novaclaw/core/session"
import { Prompt } from "@novaclaw/core/session/prompt"
import { SessionInputTable, SessionTable } from "@novaclaw/core/session/sql"
import { WorkProjects } from "@novaclaw/core/work-project/store"
import { ProjectOfficerTable, WorkProjectTable } from "@novaclaw/core/work-project/sql"
import { completeTurn, drive, HARNESS_SESSION, makeLatch, makeRunnerHarness, userTexts } from "./fixture/runner-harness"

const assign = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* db
    .update(SessionTable)
    .set({ agent: "nova" })
    .where(eq(SessionTable.id, HARNESS_SESSION))
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(WorkProjectTable)
    .values({ id: "prj_test", name: "Observatory", objective: "Map the night sky", phases: [] })
    .run()
    .pipe(Effect.orDie)
  yield* db.insert(ProjectOfficerTable).values({ agent: "nova", project_id: "prj_test" }).run().pipe(Effect.orDie)
  return db
})

test("project pause lets an active step settle and holds pending input until resume", async () => {
  const started = makeLatch()
  const gate = makeLatch()
  const harness = makeRunnerHarness({
    turns: [completeTurn("first", "First step settled"), completeTurn("second", "Work resumed")],
  })
  harness.controls.streamStarted = started
  harness.controls.streamGate = gate
  await drive(
    harness,
    Effect.gen(function* () {
      const db = yield* assign
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID: HARNESS_SESSION,
        prompt: Prompt.make({ text: "Start the survey" }),
        resume: false,
      })
      const running = yield* session.resume(HARNESS_SESSION).pipe(Effect.forkChild)
      yield* Effect.promise(() => started.promise)
      yield* db
        .update(WorkProjectTable)
        .set({ paused: true })
        .where(eq(WorkProjectTable.id, "prj_test"))
        .run()
        .pipe(Effect.orDie)
      yield* session.prompt({
        sessionID: HARNESS_SESSION,
        prompt: Prompt.make({ text: "Then publish the map" }),
        delivery: "steer",
        resume: false,
      })
      gate.open()
      yield* Fiber.join(running)
      expect(harness.requests).toHaveLength(1)
      expect(
        (yield* session.context(HARNESS_SESSION)).some(
          (message) => message.type === "assistant" && message.finish === "stop",
        ),
      ).toBe(true)
      yield* session.resume(HARNESS_SESSION)
      expect(harness.requests).toHaveLength(1)
      const resumed = makeLatch()
      const settle = makeLatch()
      harness.controls.streamStarted = resumed
      harness.controls.streamGate = settle
      yield* db
        .update(WorkProjectTable)
        .set({ paused: false })
        .where(eq(WorkProjectTable.id, "prj_test"))
        .run()
        .pipe(Effect.orDie)
      const continuing = yield* session.resume(HARNESS_SESSION).pipe(Effect.forkChild)
      yield* Effect.promise(() => resumed.promise)
      yield* db
        .update(WorkProjectTable)
        .set({ paused: true })
        .where(eq(WorkProjectTable.id, "prj_test"))
        .run()
        .pipe(Effect.orDie)
      settle.open()
      yield* Fiber.join(continuing)
      expect(harness.requests.length).toBeGreaterThan(1)
      expect(
        harness.requests
          .slice(1)
          .some((request) => userTexts(request).some((text) => text.includes("Then publish the map"))),
      ).toBe(true)
    }),
    "project pause and resume at a settled step",
  )
}, 70_000)

test("a fresh project chat receives one provenance-marked brief, even if admission is retried", async () => {
  const harness = makeRunnerHarness()
  await drive(
    harness,
    Effect.gen(function* () {
      const db = yield* assign
      const events = yield* EventV2.Service
      yield* WorkProjects.primeContext(db, events, HARNESS_SESSION)
      yield* WorkProjects.primeContext(db, events, HARNESS_SESSION)
      const rows = yield* db
        .select()
        .from(SessionInputTable)
        .where(eq(SessionInputTable.session_id, HARNESS_SESSION))
        .all()
        .pipe(Effect.orDie)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.prompt.text).toContain("Map the night sky")
      expect(rows[0]!.delivery).toBe("steer")
      yield* db
        .update(SessionInputTable)
        .set({ promoted_seq: 1 })
        .where(eq(SessionInputTable.id, rows[0]!.id))
        .run()
        .pipe(Effect.orDie)
      yield* WorkProjects.primeContext(db, events, HARNESS_SESSION)
      expect(
        yield* db
          .select()
          .from(SessionInputTable)
          .where(eq(SessionInputTable.session_id, HARNESS_SESSION))
          .all()
          .pipe(Effect.orDie),
      ).toHaveLength(1)
    }),
    "project context retry",
  )
}, 70_000)
