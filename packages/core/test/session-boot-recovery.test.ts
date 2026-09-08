import { AgentV2 } from "@novaclaw/core/agent"
import { describe, expect, test } from "bun:test"
import { DateTime, Deferred, Duration, Effect, Layer } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { makeGlobalNode, makeLocationNode } from "@novaclaw/core/effect/app-node"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { Location } from "@novaclaw/core/location"
import { LocationServiceMap } from "@novaclaw/core/location-service-map"
import { ModelV2 } from "@novaclaw/core/model"
import { ProjectV2 } from "@novaclaw/core/project"
import { ProviderV2 } from "@novaclaw/core/provider"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionBootRecovery } from "@novaclaw/core/session/boot-recovery"
import { SessionEvent } from "@novaclaw/core/session/event"
import { SessionExecution } from "@novaclaw/core/session/execution"
import { SessionExecutionLocal } from "@novaclaw/core/session/execution/local"
import { SessionInput } from "@novaclaw/core/session/input"
import { SessionMessage } from "@novaclaw/core/session/message"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { Prompt } from "@novaclaw/core/session/prompt"
import { SessionRunner } from "@novaclaw/core/session/runner"
import * as SessionRunnerLLM from "@novaclaw/core/session/runner/llm"
import { SessionScheduler } from "@novaclaw/core/session/scheduler"
import { SessionExecutionTable } from "@novaclaw/core/session/sql"
import type { SessionStore } from "@novaclaw/core/session/store"
import { SessionStore as SessionStoreService } from "@novaclaw/core/session/store"
import { it as bare, testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

/**
 * **A process restart used to eat an accepted prompt.**
 *
 * Admission is durable — `session_input` rows survive anything — while the thing that RUNS them is
 * a `Map` in `SessionRunCoordinator`. Nothing polled, subscribed or timed, so a prompt typed while
 * the agent was mid-turn (or a spawned child's opening prompt) simply never ran again after a
 * crash, a quit or a binary replacement. The user saw an accepted message and no answer, forever.
 *
 * The sibling half is quieter and was worse: `recoverStale` — the sweep that reclassifies leases a
 * dead host abandoned — was forked inside `SessionExecutionLocal`, which has **no production
 * caller**. So stale-host recovery ran in tests only, and the shipped server left every abandoned
 * lease reading *busy* forever.
 *
 * Both now live in `session/boot-recovery.ts`, started where an instance adopts an executor. The
 * first test is the one that matters: it restarts a real graph over a real database file.
 */

/**
 * 🔴 NC-SEC-020 — a ROOT names the agent it runs as; there is no anonymous chat. `build` records the
 * POSTURE this chat runs in, which is the ordinary production case and keeps these tests' semantics
 * unchanged: a posture is excluded from the canonical `ses_<agent>` id and from the one-chat guard.
 */
const rootAgent = AgentV2.ID.make("build")

const PROMPT = "the prompt that was accepted before the crash"

const runs: string[] = []
const drained = new Map<string, Deferred.Deferred<void>>()
const drainOf = (sessionID: string) => {
  const existing = drained.get(sessionID)
  if (existing) return existing
  const created = Deferred.makeUnsafe<void>()
  drained.set(sessionID, created)
  return created
}

/** Stands in for `runner/llm.ts` (which needs a live model): records that a drain reached a session. */
const fakeRunner = makeLocationNode({
  service: SessionRunner.Service,
  layer: Layer.succeed(
    SessionRunner.Service,
    SessionRunner.Service.of({
      run: ({ sessionID }) =>
        Effect.sync(() => {
          runs.push(sessionID)
          Deferred.doneUnsafe(drainOf(sessionID), Effect.void)
        }),
    }),
  ),
  deps: [],
})

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
  }),
)

/** The executor a process has when nothing can run: exactly what a dead host leaves behind. */
const inertExecution = makeGlobalNode({
  service: SessionExecution.Service,
  layer: SessionExecution.noopLayer,
  deps: [],
})

const instanceGraph = (replacements: LayerNode.Replacements) =>
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStoreService.node,
      SessionScheduler.node,
      LocationServiceMap.node,
      SessionV2.node,
    ]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecutionLocal.node],
      [SessionRunnerLLM.node, fakeRunner],
      ...replacements,
    ],
  )

/**
 * ⚠️ The restart tests must pin the database to a FILE. `test/preload.ts` sets
 * `NOVACLAW_DB=:memory:`, so every graph build otherwise gets its own private, empty database —
 * under which "the second process cannot see the first one's row" is a property of the fixture and
 * the sweep is never exercised at all.
 */
const onDisk = (file: string) =>
  makeGlobalNode({ service: Database.Service, layer: Database.layerFromPath(file), deps: [] })

/** The same graph with nothing able to run — the process that accepts a prompt and then dies. */
const deadGraph = (file: string) =>
  instanceGraph([
    [Database.node, onDisk(file)],
    [SessionExecution.node, inertExecution],
  ])
const liveGraph = (file: string) => instanceGraph([[Database.node, onDisk(file)]])

const it = testEffect(instanceGraph([]))

const scratch = Effect.acquireRelease(
  Effect.promise(() => tmpdir()),
  (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
)

const workspace = scratch.pipe(Effect.map((tmp) => Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })))

/** A workspace directory plus a database file inside it that outlives one graph build. */
const restartFixture = scratch.pipe(
  Effect.map((tmp) => ({
    location: Location.Ref.make({ directory: AbsolutePath.make(tmp.path) }),
    database: `${tmp.path}/boot-recovery.db`,
  })),
)

const queue = (sessionID: SessionV2.ID, delivery: "queue" | "steer" = "queue") =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    yield* SessionInput.admit(db, events, {
      id: SessionMessage.ID.create(),
      sessionID,
      prompt: Prompt.make({ text: PROMPT }),
      delivery,
    })
  })

/** Did a drain reach this session within `window`? Real time — the drain is a detached fiber. */
const ranWithin = (sessionID: string, window: Duration.Duration) =>
  Effect.race(Deferred.await(drainOf(sessionID)).pipe(Effect.as(true)), Effect.sleep(window).pipe(Effect.as(false)))

/**
 * ⚠️ These two use the BARE `it`, never `testEffect(liveGraph)`, and that is load-bearing rather
 * than stylistic. A layer provided to the test body is built when the body starts — so the "second
 * process" would already have booted, swept an empty database, and been memoized long before the
 * first one admitted anything. The graphs must be provided INSIDE, one after the other, or the test
 * measures nothing and passes for it. (Found the honest way: the sweep probe fired once, at 0.)
 */
describe("a restart does not eat an accepted prompt", () => {
  bare.live(
    "a second process resumes queued input the first one never promoted",
    () =>
      Effect.gen(function* () {
        const { location, database } = yield* restartFixture

        // ── process 1 — accepts the prompt, then dies without running it ────────────────────────
        // Its scope CLOSES before the second graph opens, so the database file is genuinely handed
        // from one process-shaped lifetime to another; nothing is shared in memory.
        const sessionID = yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* SessionV2.Service
            const created = yield* session.create({ location, agent: rootAgent })
            yield* queue(created.id)
            return created.id
          }).pipe(Effect.provide(deadGraph(database))),
        )
        expect(runs).not.toContain(sessionID)

        // ── process 2 — boots over the same database ───────────────────────────────────────────
        yield* Effect.scoped(
          Effect.gen(function* () {
            // Acquiring the service is what BUILDS the layer, exactly as the instance's routes do at
            // server start. Nothing here prompts, resumes or spawns — the only thing that can start
            // this session is the boot sweep, so a pass is evidence of the sweep and nothing else.
            yield* SessionV2.Service
            // Generous on purpose: the drain builds this directory's Location graph from scratch
            // (config discovery, agents, tools), which is seconds on Windows and is the same cost
            // `spawn-wakes-child.test.ts` budgets ten for.
            expect(yield* ranWithin(sessionID, Duration.seconds(15))).toBe(true)
          }).pipe(Effect.provide(liveGraph(database))),
        )
        expect(runs).toContain(sessionID)
      }),
    30_000,
  )

  bare.live(
    "NEGATIVE CONTROL: a session with no pending input is not woken by a boot",
    () =>
      Effect.gen(function* () {
        const { location, database } = yield* restartFixture
        // Same two-process shape, same graphs, one difference: nothing was ever queued. If the sweep
        // woke on session EXISTENCE rather than on pending input, the test above would pass for the
        // wrong reason and this one would fail.
        const sessionID = yield* Effect.scoped(
          Effect.gen(function* () {
            const session = yield* SessionV2.Service
            return (yield* session.create({ location, agent: rootAgent })).id
          }).pipe(Effect.provide(deadGraph(database))),
        )

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* SessionV2.Service
            expect(yield* ranWithin(sessionID, Duration.seconds(3))).toBe(false)
          }).pipe(Effect.provide(liveGraph(database))),
        )
        expect(runs).not.toContain(sessionID)
      }),
    30_000,
  )
})

describe("which sessions the sweep hands back", () => {
  const record = () => {
    const woken: string[] = []
    return { woken, wake: (sessionID: SessionV2.ID) => Effect.sync(() => void woken.push(sessionID)) }
  }

  it.live("queued input wakes; a leftover steer does not", () =>
    Effect.gen(function* () {
      const location = yield* workspace
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const store = yield* SessionStoreService.Service

      const queued = yield* session.create({ location, agent: rootAgent })
      const steered = yield* session.create({ location, agent: rootAgent })
      yield* queue(queued.id)
      yield* queue(steered.id, "steer")

      const { woken, wake } = record()
      yield* SessionBootRecovery.wakeAbandonedInput({ db, store, resume: wake })

      expect(woken).toContain(queued.id)
      // A steer is an interjection for a turn that no longer exists. It rides the cutoff of whatever
      // turn runs next; starting one on its behalf would resurrect an agent on a leftover nudge.
      expect(woken).not.toContain(steered.id)
    }),
  )

  it.live("input already promoted by the previous process is not run twice", () =>
    Effect.gen(function* () {
      const location = yield* workspace
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const store = yield* SessionStoreService.Service

      const promoted = yield* session.create({ location, agent: rootAgent })
      yield* queue(promoted.id)
      // What a completed drain does: promotion is what clears `promoted_seq IS NULL`.
      expect(yield* SessionInput.promoteNextQueued(db, events, promoted.id)).toBe(true)

      const { woken, wake } = record()
      yield* SessionBootRecovery.wakeAbandonedInput({ db, store, resume: wake })
      expect(woken).not.toContain(promoted.id)
    }),
  )

  it.live("a settled replacement that stranded provider recovery is woken on upgrade", () =>
    Effect.gen(function* () {
      const location = yield* workspace
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const store = yield* SessionStoreService.Service

      const interrupted = yield* session.create({ location, agent: rootAgent })
      // This is the exact state left by 0.1.71: the replacement drain returned at its cached
      // empty-queue gate and the supervisor truthfully settled that no-op, leaving recovery behind.
      yield* db
        .insert(SessionExecutionTable)
        .values({
          session_id: interrupted.id,
          attempt_id: "provider-attempt",
          generation: 2,
          owner_id: "replacement-host",
          state: "settled",
          phase: "drain",
          failure_count: 0,
          heartbeat_at: 1234,
          provider_recovery: {
            attemptID: EventV2.ID.create(),
            assistantMessageID: SessionMessage.ID.create(),
            model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
            startedAt: 1234,
            toolProtocol: true,
          },
          started_at: 1234,
          time_updated: 1234,
        })
        .run()
        .pipe(Effect.orDie)

      const { woken, wake } = record()
      yield* SessionBootRecovery.wakeAbandonedInput({ db, store, resume: wake })
      expect(woken).toEqual([interrupted.id])
    }),
  )

  it.live("a session under operator control is left alone until control comes back", () =>
    Effect.gen(function* () {
      const location = yield* workspace
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const store = yield* SessionStoreService.Service

      const handedOff = yield* session.create({ location, agent: rootAgent })
      yield* session.switchResponder({ sessionID: handedOff.id, responder: "operator" })
      yield* queue(handedOff.id)

      const { woken, wake } = record()
      yield* SessionBootRecovery.wakeAbandonedInput({ db, store, resume: wake })
      // The runner returns before any turn for these, so a wake buys one worker process per boot
      // that spawns only to discover it has nothing to do. `switchResponder("nova")` wakes it.
      expect(woken).not.toContain(handedOff.id)

      // …and the skip is about the RESPONDER, not about the row: hand control back and the same
      // sweep resumes it. Without this the test above would also pass if the sweep were broken.
      yield* session.switchResponder({ sessionID: handedOff.id, responder: "nova" })
      const second = record()
      yield* SessionBootRecovery.wakeAbandonedInput({ db, store, resume: second.wake })
      expect(second.woken).toContain(handedOff.id)
    }),
  )

  it.live("an unreadable config FAILS OPEN — the prompt is resumed, not silently dropped", () =>
    Effect.gen(function* () {
      const location = yield* workspace
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service

      const created = yield* session.create({ location, agent: rootAgent })
      yield* queue(created.id)

      // Only `.get` is reached by the config walk; the cast keeps the stub to the one method under
      // test. Skipping on an unreadable config would re-create the exact defect this sweep fixes,
      // so the failure has to resolve to "wake it anyway".
      const broken = {
        get: () => Effect.die("config walk exploded"),
      } as unknown as SessionStore.Interface

      const { woken, wake } = record()
      yield* SessionBootRecovery.wakeAbandonedInput({ db, store: broken, resume: wake })
      expect(woken).toContain(created.id)
    }),
  )
})

describe("the sweep is owned by the instance, not by one executor", () => {
  // The regression that already happened once, in the opposite direction: `recoverStale` was forked
  // inside `SessionExecutionLocal`, whose only callers are tests, so production never swept. A
  // comment cannot hold that; these can.
  test("no executor implementation forks the stale-lease sweep for itself", async () => {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const root = path.resolve(import.meta.dir, "..")
    for (const file of ["src/session/execution/local.ts"]) {
      const source = fs.readFileSync(path.join(root, file), "utf8")
      // Named in prose by the comment that explains the move; what must not return is the CALL.
      expect(source).not.toMatch(/attempts\s*\n?\s*\.recoverStale\(/)
      expect(source).not.toContain("attempts.recoverStale(")
    }
  })

  test("SessionV2 reaches the attempt service the sweep reclassifies through", () => {
    expect(SessionV2.node.dependencies.map((node) => node.name)).toContain("@novaclaw/v2/SessionExecutionAttempt")
  })
})
