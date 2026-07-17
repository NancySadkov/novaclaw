import { describe, expect } from "bun:test"
import path from "path"
import { DateTime, Effect, Layer, Stream } from "effect"
import { AgentV2 } from "@novaclaw/core/agent"
import { asc, eq } from "drizzle-orm"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { EventTable } from "@novaclaw/core/event/sql"
import { Location } from "@novaclaw/core/location"
import { ModelV2 } from "@novaclaw/core/model"
import { ProjectV2 } from "@novaclaw/core/project"
import { ProviderV2 } from "@novaclaw/core/provider"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionV2 } from "@novaclaw/core/session"
import { CommandV2 } from "@novaclaw/core/command"
import { LocationServiceMap } from "@novaclaw/core/location-service-map"
import { buildLocationServiceMap } from "@novaclaw/core/location-services"
import { SessionRecordEvent } from "@novaclaw/schema/session-record-event"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { Prompt } from "@novaclaw/core/session/prompt"
import { SessionMessage } from "@novaclaw/core/session/message"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionExecution } from "@novaclaw/core/session/execution"
import { SessionInput } from "@novaclaw/core/session/input"
import { SessionEvent } from "@novaclaw/core/session/event"
import { SessionTable } from "@novaclaw/core/session/sql"
import { SessionStore } from "@novaclaw/core/session/store"
import { WorkspaceV2 } from "@novaclaw/core/workspace"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const id = SessionV2.ID.create()

// A command-injecting harness for SessionV2.command: the location graph's CommandV2 is
// otherwise config-populated (empty here), so replace its node with a fixed command via a
// buildLocationServiceMap replacement. The template exercises both an `$1` positional arg
// and a `` !`echo` `` shell substitution.
const commandTemplate = "Hi $1 from !`echo bot`"
const itCommand = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
      [
        LocationServiceMap.node,
        buildLocationServiceMap([
          [
            CommandV2.node,
            Layer.mock(CommandV2.Service, {
              get: (name: string) =>
                Effect.succeed(
                  name === "greet"
                    ? CommandV2.Info.make({ name: "greet", template: commandTemplate })
                    : name === "review"
                      ? CommandV2.Info.make({ name: "review", template: "Review the change", agent: "plan" })
                      : name === "spawn"
                        ? CommandV2.Info.make({ name: "spawn", template: "Do the subtask", subtask: true })
                        : undefined,
                ),
            }),
          ],
        ]),
      ],
    ],
  ),
)

describe("SessionV2.create", () => {
  it.effect("creates a fresh projected session when the ID is omitted", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service

      const first = yield* session.create({ location })
      const second = yield* session.create({ location })

      expect(second.id).not.toBe(first.id)
      expect(yield* session.list()).toHaveLength(2)
    }),
  )

  it.effect("returns the original session when the ID is retried", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const input = { id, location }

      const first = yield* session.create(input)
      const retried = yield* session.create(input)

      expect(retried).toEqual(first)
      expect(yield* session.list()).toEqual([first])
    }),
  )

  it.effect("stores supplied immutable create attributes", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const workspaceID = WorkspaceV2.ID.make("wrk_test")
      const model = ModelV2.Ref.make({
        id: ModelV2.ID.make("sonnet"),
        providerID: ProviderV2.ID.anthropic,
        variant: ModelV2.VariantID.make("fast"),
      })

      expect(
        yield* session.create({
          location: Location.Ref.make({ directory: location.directory, workspaceID }),
          agent: AgentV2.ID.make("build"),
          model,
        }),
      ).toMatchObject({ location: { directory: location.directory, workspaceID }, agent: "build", model })
    }),
  )

  it.effect("returns the existing Session when one ID is reused with different create arguments", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ id, location })
      const changed = [
        { id, location: Location.Ref.make({ directory: AbsolutePath.make("/other") }) },
        { id, location, agent: AgentV2.ID.make("build") },
        {
          id,
          location,
          model: ModelV2.Ref.make({ id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic }),
        },
      ]

      for (const input of changed) {
        expect(yield* session.create(input)).toEqual(created)
      }
      expect(yield* session.list()).toHaveLength(1)
    }),
  )

  it.effect("returns one recorded session to concurrent exact retries", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const input = { id, location }

      const created = yield* Effect.all([session.create(input), session.create(input)], { concurrency: "unbounded" })

      expect(created[1]).toEqual(created[0])
      expect(yield* session.list()).toEqual([created[0]])
    }),
  )

  it.effect("returns the current Session projection after updates", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const input = { id, location }
      const created = yield* session.create(input)

      yield* db.update(SessionTable).set({ agent: "build" }).where(eq(SessionTable.id, id)).run().pipe(Effect.orDie)

      expect(yield* session.create(input)).toMatchObject({ id: created.id, agent: "build" })
    }),
  )

  it.effect("returns the current Session projection after projected updates", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const input = { id, location }
      const created = yield* session.create(input)

      yield* events.publish(SessionRecordEvent.Updated, {
        sessionID: id,
        info: SessionSchema.Info.make({
          id,
          slug: "updated",
          version: "test",
          location: { directory: created.location.directory },
          title: "updated",
          agent: AgentV2.ID.make("build"),
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: DateTime.makeUnsafe(1), updated: DateTime.makeUnsafe(2) },
        }),
      })

      expect(yield* session.create(input)).toMatchObject({ id, agent: "build" })
    }),
  )

  it.effect("persists creation through the existing legacy created event", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })

      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all().pipe(Effect.orDie),
      ).toMatchObject([{ type: EventV2.versionedType(SessionRecordEvent.Created.type, 2) }])
    }),
  )

  it.effect("persists caller-ID creation through the existing created event", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ id, location })

      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).get().pipe(Effect.orDie),
      ).toMatchObject({
        data: { sessionID: id },
      })
    }),
  )

  it.effect("omits legacy creation rows from the V2 Session event stream", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })
      yield* session.prompt({ sessionID: created.id, prompt: Prompt.make({ text: "Hello" }), resume: false })
      yield* SessionInput.promoteSteers(db, events, created.id, Number.MAX_SAFE_INTEGER)

      expect(
        Array.from(yield* session.events({ sessionID: created.id }).pipe(Stream.take(2), Stream.runCollect)),
      ).toMatchObject([
        { durable: { seq: 1 }, type: "session.next.prompt.admitted", data: { prompt: { text: "Hello" } } },
        { durable: { seq: 2 }, type: "session.next.prompted" },
      ])
    }),
  )

  it.effect("replays one prompt lifecycle into a fresh target database", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const sourceEvents = yield* EventV2.Service
      const sourceDb = (yield* Database.Service).db
      const created = yield* session.create({ id: SessionV2.ID.make("ses_fresh_target_replay"), location })
      const admitted = yield* session.prompt({
        sessionID: created.id,
        prompt: Prompt.make({ text: "Replay lifecycle" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers(sourceDb, sourceEvents, created.id, Number.MAX_SAFE_INTEGER)
      const serialized = (yield* sourceDb
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, created.id))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)).map((event) => ({
        id: event.id,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
      }))

      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const targetDatabase = Database.layerFromPath(path.join(tmp.path, "target.sqlite"))
      const targetLayer = AppNodeBuilder.build(
        LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node]),
        [[Database.node, targetDatabase]],
      )

      yield* Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const events = yield* EventV2.Service
        const store = yield* SessionStore.Service

        expect(yield* store.get(created.id)).toBeUndefined()
        expect(yield* events.replayAll(serialized.slice(0, 2))).toBe(created.id)
        expect(yield* SessionInput.find(db, admitted.id)).toMatchObject({
          id: admitted.id,
          sessionID: created.id,
          prompt: { text: "Replay lifecycle" },
          delivery: "steer",
          admittedSeq: 1,
        })
        expect(yield* store.context(created.id)).toEqual([])

        expect(yield* events.replayAll(serialized.slice(2))).toBe(created.id)
        expect(yield* SessionInput.find(db, admitted.id)).toMatchObject({
          id: admitted.id,
          sessionID: created.id,
          prompt: { text: "Replay lifecycle" },
          delivery: "steer",
          admittedSeq: 1,
          promotedSeq: 2,
        })
        expect(yield* store.context(created.id)).toMatchObject([
          { id: admitted.id, type: "user", text: "Replay lifecycle" },
        ])
        expect(
          (yield* db
            .select()
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, created.id))
            .orderBy(asc(EventTable.seq))
            .all()
            .pipe(Effect.orDie)).map((event) => [event.seq, event.type]),
        ).toEqual([
          [0, EventV2.versionedType(SessionRecordEvent.Created.type, 2)],
          [1, EventV2.versionedType(SessionEvent.PromptAdmitted.type, 1)],
          [2, EventV2.versionedType(SessionEvent.Prompted.type, 1)],
        ])
      }).pipe(Effect.provide(Layer.fresh(targetLayer)))
    }),
  )

  it.effect("does not mask unrelated created projector defects", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const event = yield* EventV2.Service
      const defect = new Error("unrelated projector defect")
      yield* event.project(SessionRecordEvent.Created, () => Effect.die(defect))

      expect(yield* session.create({ id, location }).pipe(Effect.catchDefect(Effect.succeed))).toBe(defect)
    }),
  )

  it.effect("reports unfinished Session operations as unavailable", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      const unavailable = (
        effect: Effect.Effect<void, SessionV2.NotFoundError | SessionV2.OperationUnavailableError>,
      ) =>
        effect.pipe(
          Effect.flip,
          Effect.map((error) => (error instanceof SessionV2.OperationUnavailableError ? error.operation : "not-found")),
        )

      expect(yield* unavailable(session.skill({ sessionID: created.id, skill: "review" }))).toBe("skill")
    }),
  )

  it.live("runs a shell command and records it as a shell message", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const session = yield* SessionV2.Service
      const created = yield* session.create({
        location: Location.Ref.make({ directory: AbsolutePath.make(dir.path) }),
      })

      const messageID = yield* session.shell({ sessionID: created.id, command: "echo novaclaw-shell-smoke" })

      // Started opens the shell message (carrying the command + its messageID); Ended fills
      // the whole output — there is no streaming/Delta event, so both are already durable.
      const shellEvents = Array.from(
        yield* session.events({ sessionID: created.id }).pipe(
          Stream.filter(
            (event) =>
              event.type === SessionEvent.Shell.Started.type || event.type === SessionEvent.Shell.Ended.type,
          ),
          Stream.take(2),
          Stream.runCollect,
        ),
      )
      const started = shellEvents.find((event) => event.type === SessionEvent.Shell.Started.type)?.data as
        | { command: string; messageID: string }
        | undefined
      const ended = shellEvents.find((event) => event.type === SessionEvent.Shell.Ended.type)?.data as
        | { output: string }
        | undefined
      expect(started?.command).toBe("echo novaclaw-shell-smoke")
      expect(started?.messageID).toBe(messageID)
      expect(ended?.output).toContain("novaclaw-shell-smoke")
    }),
  )

  it.effect("switches the selected agent through the durable Session event", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })

      yield* session.switchAgent({ sessionID: created.id, agent: "plan" })

      expect(yield* session.get(created.id)).toMatchObject({ agent: "plan" })
      expect(
        Array.from(yield* session.events({ sessionID: created.id }).pipe(Stream.take(1), Stream.runCollect)),
      ).toMatchObject([{ type: "session.next.agent.switched", data: { agent: "plan" } }])
    }),
  )

  it.effect("rejects an agent switch for a missing Session", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const missing = SessionV2.ID.make("ses_missing_agent_switch")

      expect(
        yield* session.switchAgent({ sessionID: missing, agent: "plan" }).pipe(
          Effect.flip,
          Effect.map((error) => error._tag),
        ),
      ).toBe("Session.NotFoundError")
    }),
  )

  it.effect("switches the selected model through the durable Session event", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      const model = ModelV2.Ref.make({
        id: ModelV2.ID.make("sonnet"),
        providerID: ProviderV2.ID.anthropic,
        variant: ModelV2.VariantID.make("high"),
      })

      yield* session.switchModel({ sessionID: created.id, model })

      expect(yield* session.get(created.id)).toMatchObject({ model })
      expect(
        Array.from(yield* session.events({ sessionID: created.id }).pipe(Stream.take(1), Stream.runCollect)),
      ).toMatchObject([{ type: "session.next.model.switched", data: { model } }])
    }),
  )

  it.effect("ignores a model switch when the selected model is unchanged", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      const model = ModelV2.Ref.make({ id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic })

      yield* session.switchModel({ sessionID: created.id, model })
      yield* session.switchModel({ sessionID: created.id, model })

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all().pipe(Effect.orDie),
      ).toHaveLength(2)
      expect(yield* session.get(created.id)).toMatchObject({ model })
    }),
  )

  it.effect("treats an omitted variant as the default variant", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const model = ModelV2.Ref.make({ id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic })
      const created = yield* session.create({ location, model })

      yield* session.switchModel({
        sessionID: created.id,
        model: ModelV2.Ref.make({ ...model, variant: ModelV2.VariantID.make("default") }),
      })

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all().pipe(Effect.orDie),
      ).toHaveLength(1)
    }),
  )

  it.effect("rejects a model switch for a missing Session", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const missing = SessionV2.ID.make("ses_missing_model_switch")

      expect(
        yield* session
          .switchModel({
            sessionID: missing,
            model: ModelV2.Ref.make({ id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic }),
          })
          .pipe(
            Effect.flip,
            Effect.map((error) => error._tag),
          ),
      ).toBe("Session.NotFoundError")
    }),
  )
})

describe("SessionV2.setTitle", () => {
  it.effect("sets the title through the durable legacy Updated event", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })

      yield* session.setTitle({ sessionID: created.id, title: "Renamed session" })

      expect(yield* session.get(created.id)).toMatchObject({ title: "Renamed session" })
      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all().pipe(Effect.orDie),
      ).toMatchObject([
        { type: EventV2.versionedType(SessionRecordEvent.Created.type, 2) },
        {
          type: EventV2.versionedType(SessionRecordEvent.Updated.type, 2),
          data: { sessionID: created.id, info: { title: "Renamed session" } },
        },
      ])
    }),
  )

  it.effect("preserves every other session column through a title update", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({
        location,
        agent: AgentV2.ID.make("build"),
        model: ModelV2.Ref.make({ id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic }),
      })
      const before = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, created.id))
        .get()
        .pipe(Effect.orDie)

      yield* session.setTitle({ sessionID: created.id, title: "Renamed" })

      // The Updated projector rewrites the WHOLE row from the published info — a lossy
      // row -> SessionInfo mapping would surface here as any other column changing.
      const after = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, created.id))
        .get()
        .pipe(Effect.orDie)
      expect(after).toEqual({ ...before!, title: "Renamed", time_updated: after!.time_updated })
      expect(after!.time_updated).toBeGreaterThanOrEqual(before!.time_updated)
    }),
  )

  it.effect("ignores a title update when the title is unchanged", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })

      yield* session.setTitle({ sessionID: created.id, title: "Once" })
      yield* session.setTitle({ sessionID: created.id, title: "Once" })

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all().pipe(Effect.orDie),
      ).toHaveLength(2)
    }),
  )

  it.effect("rejects a title update for a missing Session", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const missing = SessionV2.ID.make("ses_missing_set_title")

      expect(
        yield* session.setTitle({ sessionID: missing, title: "Nope" }).pipe(
          Effect.flip,
          Effect.map((error) => error._tag),
        ),
      ).toBe("Session.NotFoundError")
    }),
  )
})

describe("SessionV2 setters", () => {
  it.effect("replaces metadata wholesale and bumps time.updated", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })

      yield* session.setMetadata({ sessionID: created.id, metadata: { source: "test", pinned: true } })
      yield* session.setMetadata({ sessionID: created.id, metadata: { source: "second" } })

      const row = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, created.id))
        .get()
        .pipe(Effect.orDie)
      expect(row!.metadata).toEqual({ source: "second" })
    }),
  )

  it.effect("archives the session without bumping time.updated", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })
      const before = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, created.id))
        .get()
        .pipe(Effect.orDie)

      yield* session.setArchived({ sessionID: created.id, time: 12345 })

      const row = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, created.id))
        .get()
        .pipe(Effect.orDie)
      expect(row!.time_archived).toBe(12345)
      expect(row!.time_updated).toBe(before!.time_updated)
    }),
  )

  it.effect("replaces the saved permission ruleset", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })
      const ruleset = [{ permission: "bash", pattern: "git *", action: "allow" as const }]

      yield* session.setPermission({ sessionID: created.id, permission: ruleset })

      const row = yield* db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.id, created.id))
        .get()
        .pipe(Effect.orDie)
      expect(row!.permission).toEqual(ruleset)
    }),
  )

  it.effect("rejects setter calls for a missing Session", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const missing = SessionV2.ID.make("ses_missing_setters")
      const tag = (effect: Effect.Effect<void, SessionV2.NotFoundError>) =>
        effect.pipe(
          Effect.flip,
          Effect.map((error) => error._tag),
        )

      expect(yield* tag(session.setMetadata({ sessionID: missing, metadata: {} }))).toBe("Session.NotFoundError")
      expect(yield* tag(session.setArchived({ sessionID: missing, time: 1 }))).toBe("Session.NotFoundError")
      expect(yield* tag(session.setPermission({ sessionID: missing, permission: [] }))).toBe("Session.NotFoundError")
    }),
  )
})

describe("SessionV2.children", () => {
  it.effect("lists the direct children of a parent session", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const parent = yield* session.create({ location })
      const first = yield* session.create({ location, parentID: parent.id })
      const second = yield* session.create({ location, parentID: parent.id })
      const grandchild = yield* session.create({ location, parentID: first.id })

      const children = yield* session.children(parent.id)

      expect(children.map((child) => child.id).sort()).toEqual([first.id, second.id].sort())
      expect(children.map((child) => child.id)).not.toContain(grandchild.id)
    }),
  )

  it.effect("rejects listing children of a missing session", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service

      expect(
        yield* session.children(SessionV2.ID.make("ses_missing_children")).pipe(
          Effect.flip,
          Effect.map((error) => error._tag),
        ),
      ).toBe("Session.NotFoundError")
    }),
  )
})

describe("SessionV2.fork", () => {
  const seedTurns = (sessionID: SessionV2.ID, texts: string[]) =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      for (const text of texts) {
        yield* session.prompt({ sessionID, prompt: Prompt.make({ text }), resume: false })
        yield* SessionInput.promoteSteers(db, events, sessionID, Number.MAX_SAFE_INTEGER)
      }
    })

  it.effect("copies the whole transcript into a fresh root session with fresh message IDs", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({
        location,
        agent: AgentV2.ID.make("build"),
        model: ModelV2.Ref.make({ id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic }),
      })
      yield* seedTurns(created.id, ["First", "Second"])

      const forked = yield* session.fork({ sessionID: created.id })

      expect(forked.id).not.toBe(created.id)
      expect(forked.parentID).toBeUndefined()
      expect(forked.title).toBe(`${created.title} (fork #1)`)
      // The fork keeps the source's agent/model (deliberate V1 delta — V1 dropped them).
      expect(forked).toMatchObject({ agent: created.agent, model: created.model })
      const sourceMessages = yield* session.messages({ sessionID: created.id })
      const forkMessages = yield* session.messages({ sessionID: forked.id })
      expect(forkMessages.map((message) => (message.type === "user" ? message.text : message.type))).toEqual(
        sourceMessages.map((message) => (message.type === "user" ? message.text : message.type)),
      )
      const sourceIDs = new Set(sourceMessages.map((message) => message.id))
      for (const message of forkMessages) expect(sourceIDs.has(message.id)).toBe(false)
    }),
  )

  it.effect("copies strictly before the anchor message (V1 parity)", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      yield* seedTurns(created.id, ["First", "Second"])
      const anchor = (yield* session.messages({ sessionID: created.id })).find(
        (message) => message.type === "user" && message.text === "Second",
      )

      const forked = yield* session.fork({ sessionID: created.id, messageID: anchor!.id })

      const forkMessages = yield* session.messages({ sessionID: forked.id })
      expect(forkMessages.map((message) => (message.type === "user" ? message.text : message.type))).toEqual([
        "First",
      ])
    }),
  )

  it.effect("records the copied transcript as durable events on the fork aggregate", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })
      yield* seedTurns(created.id, ["First"])

      const forked = yield* session.fork({ sessionID: created.id })

      expect(
        (yield* db
          .select()
          .from(EventTable)
          .where(eq(EventTable.aggregate_id, forked.id))
          .orderBy(asc(EventTable.seq))
          .all()
          .pipe(Effect.orDie)).map((event) => event.type),
      ).toEqual([
        EventV2.versionedType(SessionRecordEvent.Created.type, 2),
        EventV2.versionedType(SessionEvent.MessageRecorded.type, 1),
      ])
    }),
  )

  it.effect("rejects an unknown anchor message", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })

      expect(
        yield* session.fork({ sessionID: created.id, messageID: SessionMessage.ID.create() }).pipe(
          Effect.flip,
          Effect.map((error) => error._tag),
        ),
      ).toBe("Session.MessageNotFoundError")
    }),
  )

  it.effect("rejects forking a missing session", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service

      expect(
        yield* session.fork({ sessionID: SessionV2.ID.make("ses_missing_fork") }).pipe(
          Effect.flip,
          Effect.map((error) => error._tag),
        ),
      ).toBe("Session.NotFoundError")
    }),
  )
})

describe("SessionV2.remove", () => {
  it.effect("removes the session row and purges its aggregate event log", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })

      yield* session.remove(created.id)

      expect(yield* session.get(created.id).pipe(Effect.flip, Effect.map((error) => error._tag))).toBe(
        "Session.NotFoundError",
      )
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, created.id)).all().pipe(Effect.orDie),
      ).toHaveLength(0)
      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all().pipe(Effect.orDie),
      ).toHaveLength(0)
    }),
  )

  it.effect("removes children recursively with the parent", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const parent = yield* session.create({ location })
      const child = yield* session.create({ location, parentID: parent.id })
      const grandchild = yield* session.create({ location, parentID: child.id })

      yield* session.remove(parent.id)

      expect(yield* session.list()).toHaveLength(0)
      for (const id of [parent.id, child.id, grandchild.id]) {
        expect(
          yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, id)).all().pipe(Effect.orDie),
        ).toHaveLength(0)
      }
    }),
  )

  it.effect("allows re-creating a session under a removed ID", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ id, location })

      yield* session.remove(created.id)
      const recreated = yield* session.create({ id, location })

      expect(recreated.id).toBe(created.id)
      expect(yield* session.list()).toHaveLength(1)
    }),
  )

  it.effect("rejects removing a missing Session", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const missing = SessionV2.ID.make("ses_missing_remove")

      expect(
        yield* session.remove(missing).pipe(
          Effect.flip,
          Effect.map((error) => error._tag),
        ),
      ).toBe("Session.NotFoundError")
    }),
  )
})

describe("SessionV2.command", () => {
  itCommand.live("expands a command template (args + shell) and submits it as a prompt", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const session = yield* SessionV2.Service
      const created = yield* session.create({
        location: Location.Ref.make({ directory: AbsolutePath.make(dir.path) }),
      })

      // "Hi $1 from !`echo bot`" with args "world" -> "$1" resolves to "world" and the
      // `` !`echo bot` `` substitution runs to "bot"; the expanded text is submitted as the prompt.
      const result = yield* session.command({ sessionID: created.id, command: "greet", arguments: "world" })
      expect(result.type).toBe("prompt")
      if (result.type === "prompt") expect(result.admitted.prompt.text).toBe("Hi world from bot")
    }),
  )

  itCommand.live("applies the command's declared agent override before submitting", () =>
    Effect.gen(function* () {
      // A real dir so the Location graph (config discovery) boots when resolving the command.
      const dir = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const session = yield* SessionV2.Service
      const created = yield* session.create({
        location: Location.Ref.make({ directory: AbsolutePath.make(dir.path) }),
      })

      // The "review" command declares agent "plan"; running it switches the session's agent
      // (persisted, like promptAsync) in addition to submitting the expanded prompt.
      yield* session.command({ sessionID: created.id, command: "review", arguments: "" })
      expect(yield* session.get(created.id)).toMatchObject({ agent: "plan" })
    }),
  )

  itCommand.live("spawns a child session for a subtask command", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const session = yield* SessionV2.Service
      const created = yield* session.create({
        location: Location.Ref.make({ directory: AbsolutePath.make(dir.path) }),
      })

      // The "spawn" command sets subtask: true, so it spawns a CHILD session (not a prompt to
      // this one). The result is the discriminated "subtask" case carrying the child's id.
      const result = yield* session.command({ sessionID: created.id, command: "spawn", arguments: "" })
      expect(result.type).toBe("subtask")
      if (result.type === "subtask") {
        expect(result.childID.startsWith("ses_")).toBe(true)
        expect(result.childID).not.toBe(created.id)
      }
    }),
  )
})
