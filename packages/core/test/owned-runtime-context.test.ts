import { describe, expect } from "bun:test"
import { Effect, Schema } from "effect"
import { ConfigAgent } from "@novaclaw/core/config/agent"
import { OwnedRuntimeContext } from "@novaclaw/core/session/owned-runtime-context"
import { WorkerPurpose } from "@novaclaw/core/session/worker-purpose"
import { SystemContext } from "@novaclaw/core/system-context"
import { it } from "./lib/effect"

const MINUTE = 60_000
const observation = (observedAt: number, purpose = "Build the four character assets") => ({
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
