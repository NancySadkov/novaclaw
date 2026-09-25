import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { ConfigAgent } from "@novaclaw/core/config/agent"
import { OwnedRuntimeContext } from "@novaclaw/core/session/owned-runtime-context"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionExecutionTable, SessionTable } from "@novaclaw/core/session/sql"
import { WorkerPurpose } from "@novaclaw/core/session/worker-purpose"
import { Workers } from "@novaclaw/core/session/workers"
import { SystemContext } from "@novaclaw/core/system-context"
import { it, testEffect } from "./lib/effect"

const MINUTE = 60_000
const itDatabase = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node])))
const observation = (
  observedAt: number,
  purpose = "Build the four character assets",
): OwnedRuntimeContext.Observation => ({
  observedAt,
  heartbeatMinutes: 60,
  workers: [
    {
      id: "ses_worker",
      purpose,
      state: "busy",
      startedAt: 5 * MINUTE,
    },
  ],
  shells: [
    {
      id: "job_render",
      sessionID: "ses_worker",
      command: "blender --background scene.blend --render-anim",
      startedAt: 10 * MINUTE,
    },
  ],
})

describe("OwnedRuntimeContext", () => {
  itDatabase.effect("reconstructs living workers from durable rows without a browser cache", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const root = SessionSchema.ID.make("ses_officer")
      const living = SessionSchema.ID.make("ses_living")
      const stopped = SessionSchema.ID.make("ses_stopped")
      const finished = SessionSchema.ID.make("ses_finished")
      yield* db
        .insert(SessionTable)
        .values([
          { id: root, slug: root, directory: "/project", title: "Officer", version: "test", type: "goal-oriented" },
          {
            id: living,
            parent_id: root,
            slug: living,
            directory: "/project",
            title: "Build characters",
            version: "test",
            type: "sub-agent",
          },
          {
            id: stopped,
            parent_id: root,
            slug: stopped,
            directory: "/project",
            title: "Old worker",
            version: "test",
            type: "sub-agent",
          },
          {
            id: finished,
            parent_id: root,
            slug: finished,
            directory: "/project",
            title: "Finished worker",
            version: "test",
            type: "sub-agent",
            result: "Done",
          },
        ])
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionExecutionTable)
        .values([
          {
            session_id: living,
            attempt_id: "exe_living",
            generation: 1,
            owner_id: "host",
            state: "busy",
            phase: "drain",
            heartbeat_at: 20 * MINUTE,
            started_at: 10 * MINUTE,
            time_updated: 20 * MINUTE,
          },
          {
            session_id: stopped,
            attempt_id: "exe_stopped",
            generation: 1,
            owner_id: "host",
            state: "interrupted",
            phase: "drain",
            heartbeat_at: 12 * MINUTE,
            started_at: 10 * MINUTE,
            time_updated: 12 * MINUTE,
          },
          {
            session_id: finished,
            attempt_id: "exe_finished",
            generation: 1,
            owner_id: "host",
            state: "settled",
            phase: "drain",
            heartbeat_at: 12 * MINUTE,
            started_at: 10 * MINUTE,
            time_updated: 12 * MINUTE,
          },
        ])
        .run()
        .pipe(Effect.orDie)

      const observed = yield* OwnedRuntimeContext.observe({
        db,
        sessionID: root,
        heartbeatMinutes: 60,
        now: 20 * MINUTE,
      })
      expect(observed.workers).toEqual([
        { id: living, purpose: "Build characters", state: "busy", startedAt: expect.any(Number) },
      ])
      expect(yield* Workers.list({ db, sessionID: root })).toEqual(observed.workers)
    }),
  )

  it.effect("renders durable worker identity, purpose, shell ownership, and exact stop controls", () =>
    Effect.gen(function* () {
      const generated = yield* SystemContext.initialize(OwnedRuntimeContext.make(observation(65 * MINUTE)))

      expect(generated.baseline).toContain("ses_worker · busy · 1h · Build the four character assets")
      expect(generated.baseline).toContain('`kill` with `{"sessionID":"<worker id>"}`')
      expect(generated.baseline).toContain("job_render · owner ses_worker")
      expect(generated.baseline).toContain('`{"job":"<job id>","action":"stop"}`')
      expect(generated.baseline).toContain("compaction and restarts do not erase it")
    }),
  )

  it.effect("keeps an unchanged ledger quiet until its rolling heartbeat is due", () =>
    Effect.gen(function* () {
      const initial = yield* SystemContext.initialize(OwnedRuntimeContext.make(observation(65 * MINUTE)))

      expect(
        yield* SystemContext.reconcile(OwnedRuntimeContext.make(observation(124 * MINUTE)), initial.snapshot),
      ).toEqual({ _tag: "Unchanged" })

      const due = yield* SystemContext.reconcile(OwnedRuntimeContext.make(observation(125 * MINUTE)), initial.snapshot)
      expect(due._tag).toBe("Updated")
      if (due._tag === "Updated") expect(due.text).toContain("persistent heartbeat")
    }),
  )

  it.effect("reports worker changes immediately and removal when the last owned entity stops", () =>
    Effect.gen(function* () {
      const initial = yield* SystemContext.initialize(OwnedRuntimeContext.make(observation(65 * MINUTE)))
      const changed = yield* SystemContext.reconcile(
        OwnedRuntimeContext.make(observation(66 * MINUTE, "Build the environment assets")),
        initial.snapshot,
      )
      expect(changed._tag).toBe("Updated")

      const removed = yield* SystemContext.reconcile(SystemContext.empty, initial.snapshot)
      expect(removed).toMatchObject({
        _tag: "Updated",
        text: expect.stringContaining("have stopped"),
        snapshot: {},
      })
    }),
  )

  it.effect("stores a compact one-line purpose at spawn time", () =>
    Effect.sync(() => {
      const compact = WorkerPurpose.fromPrompt(`Build the character\n\n  with   four variants ${"x".repeat(500)}`)
      expect(compact).not.toContain("\n")
      expect(compact.length).toBe(400)
      expect(compact.endsWith("…")).toBe(true)
      expect(WorkerPurpose.fromMetadata({ [WorkerPurpose.KEY]: compact })).toBe(compact)
    }),
  )

  it.effect("accepts a human minute cadence and refuses zero", () =>
    Effect.sync(() => {
      expect(Schema.decodeUnknownSync(ConfigAgent.Info)({ runtimeHeartbeatMinutes: 5 }).runtimeHeartbeatMinutes).toBe(5)
      expect(() => Schema.decodeUnknownSync(ConfigAgent.Info)({ runtimeHeartbeatMinutes: 0 })).toThrow()
    }),
  )

  it.effect("lets live ownership tighten an officer sleep to the configured heartbeat", () =>
    Effect.sync(() => {
      const current = observation(65 * MINUTE)
      expect(
        OwnedRuntimeContext.sleepMilliseconds({
          ordinaryMilliseconds: 10 * MINUTE,
          heartbeatMinutes: 2,
          observation: current,
        }),
      ).toBe(2 * MINUTE)
      expect(
        OwnedRuntimeContext.sleepMilliseconds({
          ordinaryMilliseconds: 10 * MINUTE,
          heartbeatMinutes: 2,
          observation: { ...current, workers: [], shells: [] },
        }),
      ).toBe(10 * MINUTE)
    }),
  )
})
