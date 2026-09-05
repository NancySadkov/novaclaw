import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { eq } from "drizzle-orm"
import { DateTime, Deferred, Duration, Effect, Fiber, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { AgentV2 } from "@novaclaw/core/agent"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { CapabilityRegistry } from "@novaclaw/core/effect/capability-registry"
import { makeLocationNode, Node } from "@novaclaw/core/effect/app-node"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { Location } from "@novaclaw/core/location"
import { LocationServiceMap } from "@novaclaw/core/location-service-map"
import { locationServices } from "@novaclaw/core/location-services"
import { ProjectV2 } from "@novaclaw/core/project"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionEvent } from "@novaclaw/core/session/event"
import { SessionExecution } from "@novaclaw/core/session/execution"
import { SessionExecutionLocal } from "@novaclaw/core/session/execution/local"
import { SessionInput } from "@novaclaw/core/session/input"
import { SessionJoin } from "@novaclaw/core/session/join"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionRunCoordinator } from "@novaclaw/core/session/run-coordinator"
import { SessionRunner } from "@novaclaw/core/session/runner"
import * as SessionRunnerLLM from "@novaclaw/core/session/runner/llm"
import { SessionScheduler } from "@novaclaw/core/session/scheduler"
import { SessionSpawner } from "@novaclaw/core/session/spawner"
import { SpawnAdmission } from "@novaclaw/core/session/spawn-admission"
import { SessionStore } from "@novaclaw/core/session/store"
import { SessionTable } from "@novaclaw/core/session/sql"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { testEffect } from "./lib/effect"
import { settleTool, toolIdentity } from "./lib/tool"
import { tmpdir } from "./fixture/tmpdir"

// B1 (v0.2.0 PREP Wave 2) — `spawn` used to create a child, admit its opening prompt with delivery
// "queue", and return to nobody. `SessionExecution.wake` had four callers, ALL request-driven inside
// `SessionV2`; nothing polled, subscribed or timed. So a spawned child never ran, `exit()` was
// unreachable, and both `wait` surfaces could only poll for ~2 minutes and fail — while the tool told
// the model the child would "run its prompt on the next scheduler cycle".
//
// The regression this file exists to prevent is the WAKE SEAM being removed, or a future composition
// root never wiring it again. So the assertions are on the END of the chain — the child's own exit
// result, read back through the parent's join — never on "a drain was started".

/**
 * 🔴 NC-SEC-020 — a ROOT names the agent it runs as; there is no anonymous chat. `build` records the
 * POSTURE this chat runs in, which is the ordinary production case and keeps these tests' semantics
 * unchanged: a posture is excluded from the canonical `ses_<agent>` id and from the one-chat guard.
 */
const rootAgent = AgentV2.ID.make("build")

const PROMPT = "do the delegated sub-task"

/** Every run the fake runner performed — direct evidence a drain actually reached a given session. */
const runs: Array<{ readonly sessionID: string; readonly prompts: readonly string[] }> = []
const drained = new Map<string, Deferred.Deferred<void>>()
const drainOf = (sessionID: string) => {
  const existing = drained.get(sessionID)
  if (existing) return existing
  const created = Deferred.makeUnsafe<void>()
  drained.set(sessionID, created)
  return created
}

/**
 * Stands in for `runner/llm.ts`, which a unit test can never execute (it needs a live model — that is
 * what `tests/os-foundation-smoke.ts` is for). It does the two things the chain depends on: it SEES
 * the child's queued opening prompt, and it does what the `exit` tool does — publish
 * `session.next.completed`, whose projector writes `result` onto the session row, which is exactly
 * what both `wait` surfaces poll.
 */
const fakeRunner = makeLocationNode({
  service: SessionRunner.Service,
  layer: Layer.effect(
    SessionRunner.Service,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      return SessionRunner.Service.of({
        run: ({ sessionID }) =>
          Effect.gen(function* () {
            const pending = yield* SessionInput.listPending(db, sessionID)
            const prompts = pending.map((row) => row.prompt.text)
            runs.push({ sessionID, prompts })
            yield* events.publish(SessionEvent.Completed, {
              sessionID,
              timestamp: yield* DateTime.now,
              result: `ran: ${prompts.join(" | ")}`,
            })
            yield* Effect.sync(() => Deferred.doneUnsafe(drainOf(sessionID), Effect.void))
          }),
      })
    }),
  ),
  deps: [Database.node, EventV2.node],
})

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
  }),
)

// The production shape, node for node: `packages/server/src/routes.ts` builds exactly this — the
// instance graph plus `SessionExecutionLocal` bound over the unbound `SessionExecution` node, with
// `LocationServiceMap` listed at top level so the same map serves the routes and the executor.
const instanceGraph = (replacements: LayerNode.Replacements) =>
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
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

const it = testEffect(instanceGraph([]))

/**
 * The seam gone silent: `Wake` still resolves, `attach` still type-checks, `wake` still reports
 * success — and nothing reaches an executor. This is what the regression LOOKS like, and it compiles
 * green, which is why ruling 1 wants it pinned by a test rather than by a comment.
 */
const inertWake = Layer.succeed(
  SessionRunCoordinator.Wake,
  SessionRunCoordinator.Wake.of({
    attach: () => Effect.void,
    wake: () => Effect.succeed(true),
  }),
)
const itUnwired = testEffect(instanceGraph([[SessionRunCoordinator.wakeNode, inertWake]]))

/** Did a drain reach this session within `window`? Real time — the drain is a detached fiber. */
const ranWithin = (sessionID: string, window: Duration.Duration) =>
  Effect.race(Deferred.await(drainOf(sessionID)).pipe(Effect.as(true)), Effect.sleep(window).pipe(Effect.as(false)))

const workspace = Effect.acquireRelease(
  Effect.promise(() => tmpdir()),
  (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
).pipe(Effect.map((tmp) => Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })))

const spawnChildEffect = (parentID: SessionV2.ID, location: Location.Ref) =>
  LocationServiceMap.Service.use((locations) =>
    SessionSpawner.Service.use((spawner) => spawner.spawn({ parentID, text: PROMPT })).pipe(
      Effect.provide(locations.get(location)),
    ),
  )

const spawnChild = (parentID: SessionV2.ID, location: Location.Ref) =>
  spawnChildEffect(parentID, location).pipe(Effect.orDie)

const settleWait = (location: Location.Ref, parentID: SessionV2.ID, childID: SessionV2.ID) =>
  LocationServiceMap.Service.use((locations) =>
    ToolRegistry.Service.use((registry) =>
      settleTool(registry, {
        sessionID: parentID,
        ...toolIdentity,
        call: { type: "tool-call", id: `call-wait-${childID}`, name: "wait", input: { sessionID: childID } },
      }),
    ).pipe(Effect.provide(locations.get(location))),
  ).pipe(Effect.orDie)

describe("SessionSpawner.spawn — the child actually runs", () => {
  // A real directory: the Location graph does config discovery on boot, so `/project` would not do.
  it.live("spawn -> run -> exit -> wait returns the child's own result", () =>
    Effect.gen(function* () {
      const location = yield* workspace
      const session = yield* SessionV2.Service
      // The parent is created and NEVER prompted, so nothing request-driven can be what ran the
      // child: the only thing that could have started it is the spawn itself.
      const parent = yield* session.create({ location, agent: rootAgent })

      const spawned = yield* spawnChild(parent.id, location)

      expect(spawned.started).toBe(true)
      expect(yield* ranWithin(spawned.id, Duration.seconds(10))).toBe(true)
      // …the runner saw the child's QUEUED opening prompt (not an empty turn — the wake has to come
      // after the admit, or the drain reads a session with nothing to do)…
      expect(runs.find((run) => run.sessionID === spawned.id)?.prompts).toEqual([PROMPT])
      // …the child's exit(result) is durable on its row…
      expect((yield* session.get(spawned.id)).result).toBe(`ran: ${PROMPT}`)
      // …and the parent's join returns instead of failing OperationUnavailable after ~2 minutes.
      yield* session.wait(spawned.id)
    }),
  )

  it.live("the spawn TOOL tells the model the child started, and how to join it", () =>
    Effect.gen(function* () {
      const location = yield* workspace
      const session = yield* SessionV2.Service
      const locations = yield* LocationServiceMap.Service
      const parent = yield* session.create({ location, agent: rootAgent })

      // v0.2.0 B4c: `spawn` is no longer granted by a compiled catch-all, so it falls through to the
      // evaluator's `ask` default. This test drives the REAL permission service under an ATTENDED
      // root, so an ungranted `spawn` parks on a consent Deferred nobody answers and the test times
      // out — which is the gate working, not a wake-seam regression. Grant exactly `spawn` (never
      // ALLOW_ALL): this file's subject is the tool's message contract, and a blanket fixture would
      // stop it noticing if `spawn` later needed a second permission.
      yield* AgentV2.Service.use((agents) =>
        agents.transform((editor) =>
          editor.update(toolIdentity.agent, (agent) => {
            agent.permissions = [{ action: "spawn", resource: "*", effect: "allow" }]
          }),
        ),
      ).pipe(Effect.provide(locations.get(location)), Effect.orDie)

      const settlement = yield* ToolRegistry.Service.use((registry) =>
        settleTool(registry, {
          sessionID: parent.id,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-spawn", name: "spawn", input: { prompt: PROMPT } },
        }),
      ).pipe(Effect.provide(locations.get(location)), Effect.orDie)

      // The message is a contract with the model: it named a mechanism that did not exist, so a
      // supervisor that believed it burned two minutes in `wait` and the fault read as the model's.
      const rendered = JSON.stringify(settlement.result)
      expect(rendered).not.toContain("scheduler cycle")
      expect(rendered).toContain("and started it")
      expect(rendered).toContain("call wait with sessionID")
    }),
  )
})

describe("wait — a durable, owned join", () => {
  it.live("wakes from the child's completion event without a polling interval", () =>
    Effect.gen(function* () {
      const location = yield* workspace
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const parent = yield* session.create({ location, agent: rootAgent })
      const child = yield* session.create({ location, agent: rootAgent, parentID: parent.id })

      const waiting = yield* settleWait(location, parent.id, child.id).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* events.publish(SessionEvent.Completed, {
        sessionID: child.id,
        timestamp: yield* DateTime.now,
        result: "joined by event",
      })

      const settlement = yield* Fiber.join(waiting)
      expect(settlement.result.type).not.toBe("error")
      expect(JSON.stringify(settlement.result)).toContain("joined by event")
    }),
  )

  it.live("repairs one unambiguous copied-id typo without widening beyond direct children", () =>
    Effect.gen(function* () {
      const location = yield* workspace
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const parent = yield* session.create({ location, agent: rootAgent })
      const child = yield* session.create({ location, agent: rootAgent, parentID: parent.id })
      const original = String(child.id)
      const index = original.length - 3
      const replacement = original[index] === "a" ? "b" : "a"
      const mistyped = SessionV2.ID.make(original.slice(0, index) + replacement + original.slice(index + 1))

      yield* events.publish(SessionEvent.Completed, {
        sessionID: child.id,
        timestamp: yield* DateTime.now,
        result: "joined after one copied-id typo",
      })

      const settlement = yield* settleWait(location, parent.id, mistyped)
      expect(settlement.result.type).not.toBe("error")
      expect(JSON.stringify(settlement.result)).toContain("joined after one copied-id typo")
      expect(JSON.stringify(settlement.result)).toContain(String(child.id))
    }),
  )

  it.live("refuses a grandchild instead of allowing arbitrary session observation", () =>
    Effect.gen(function* () {
      const location = yield* workspace
      const session = yield* SessionV2.Service
      const parent = yield* session.create({ location, agent: rootAgent })
      const child = yield* session.create({ location, agent: rootAgent, parentID: parent.id })
      const grandchild = yield* session.create({ location, agent: rootAgent, parentID: child.id })

      const settlement = yield* settleWait(location, parent.id, grandchild.id)
      expect(settlement.result.type).toBe("error")
      expect(JSON.stringify(settlement.result)).toContain("not a direct child")
      expect(JSON.stringify(settlement.result)).not.toContain("Unable to wait")
    }),
  )
})

describe("SessionSpawner quotas use durable session facts", () => {
  it.live("completed direct children release the active fan-out slot", () =>
    Effect.gen(function* () {
      const location = yield* workspace
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const parent = yield* session.create({ location, agent: rootAgent })

      for (let index = 0; index < SessionSpawner.MAX_SPAWN_CHILDREN; index++) {
        const child = yield* session.create({ location, agent: rootAgent, parentID: parent.id })
        yield* events.publish(SessionEvent.Completed, {
          sessionID: child.id,
          timestamp: yield* DateTime.now,
          result: `done ${index}`,
        })
      }
      yield* db
        .update(SessionTable)
        .set({ time_created: Date.now() - 120_000 })
        .where(eq(SessionTable.parent_id, parent.id))
        .run()
        .pipe(Effect.orDie)

      const spawned = yield* spawnChild(parent.id, location)
      expect(spawned.started).toBe(true)
    }),
  )

  it.live("recent child rows enforce the rate cap without an in-memory ledger", () =>
    Effect.gen(function* () {
      const location = yield* workspace
      const session = yield* SessionV2.Service
      const parent = yield* session.create({ location, agent: rootAgent })

      for (let index = 0; index < SessionSpawner.MAX_SPAWNS_PER_MINUTE; index++) {
        yield* session.create({ location, agent: rootAgent, parentID: parent.id })
      }

      const error = yield* spawnChildEffect(parent.id, location).pipe(Effect.flip)
      // ⚠️ Narrowed, because `spawn` can now also fail with `OwnerRequiredError` (NC-SEC-020) — on
      // the ROOTLESS path only, which this is not. Asserting the tag first is what keeps the
      // failure legible if that ever changes: "expected rate, got OwnerRequired" beats a property
      // that does not exist.
      expect(error._tag).toBe("SessionSpawner.LimitError")
      if (error._tag !== "SessionSpawner.LimitError") return
      expect(error.reason).toBe("rate")
      expect(error.depth).toBe(SessionSpawner.MAX_SPAWNS_PER_MINUTE)
    }),
  )
})

// v0.2.0 prep: `SessionV2.spawn` is how a GLOBAL caller (the messenger dispatcher, and anything after
// it) reaches this location-scoped seam. The delegation is only worth having if the quota comes with
// it — the whole defect it closes is a caller that SPENDS the caps without checking them, because
// the spawner counts by `parent_id` and does not care who wrote the row.
describe("SessionV2.spawn — a global caller gets the same quota", () => {
  it.live("counts children written by OTHER paths against its own fan-out cap", () =>
    Effect.gen(function* () {
      const location = yield* workspace
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const parent = yield* session.create({ location, agent: rootAgent })

      // Sixteen children created OFF-SEAM — exactly what the messenger dispatcher used to do. The
      // cap is a DB count on `parent_id`, so it does not care who wrote the row.
      for (let index = 0; index < SessionSpawner.MAX_SPAWN_CHILDREN; index++) {
        yield* session.create({ location, agent: rootAgent, parentID: parent.id })
      }
      // Backdate them past the rate window. Without this the RATE cap (10/min) fires first and the
      // assertion below would pass for the wrong reason — the caps are 10 and 16, so a loop that
      // fills the fan-out cap always trips the rate cap on its way there.
      yield* db
        .update(SessionTable)
        .set({ time_created: Date.now() - 120_000 })
        .where(eq(SessionTable.parent_id, parent.id))
        .run()
        .pipe(Effect.orDie)

      const error = yield* session.spawn({ parentID: parent.id, text: PROMPT }).pipe(Effect.flip)
      expect((error as SessionSpawner.SpawnLimitError).reason).toBe("children")
      expect((error as SessionSpawner.SpawnLimitError).limit).toBe(SessionSpawner.MAX_SPAWN_CHILDREN)
    }),
  )

  // Calendar's shape: no parent at all. The guards key on `parent_id`, so they are skipped BY
  // CONSTRUCTION rather than passing — this pins that a rootless launch is not silently quotaed to
  // zero, and that it lands in the location it NAMED rather than inheriting one it does not have.
  it.live("launches ROOTLESS at a named location, past the caps that key on a parent", () =>
    Effect.gen(function* () {
      const location = yield* workspace
      const session = yield* SessionV2.Service

      // More than every per-parent cap, all parentless. None of them may refuse.
      const ids: string[] = []
      for (let index = 0; index < SessionSpawner.MAX_SPAWNS_PER_MINUTE + 2; index++) {
        const spawned = yield* session
          .spawn({ location, agent: rootAgent, text: PROMPT, type: "goal-oriented", title: `scheduled ${index}` })
          .pipe(Effect.orDie)
        ids.push(spawned.id)
      }
      expect(new Set(ids).size).toBe(SessionSpawner.MAX_SPAWNS_PER_MINUTE + 2)

      const first = yield* session.get(ids[0] as SessionV2.ID)
      expect(first.parentID).toBeUndefined()
      expect(first.location.directory).toBe(location.directory)
      expect(first.type).toBe("goal-oriented")
    }),
  )

  it.live("applies the instance-wide pressure gate to a rootless launch", () =>
    Effect.gen(function* () {
      const location = yield* workspace
      const session = yield* SessionV2.Service
      yield* SpawnAdmission.register(() => Effect.succeed({ refuse: "host resources are at the floor" }))

      const error = yield* session
        .spawn({ location, agent: rootAgent, text: PROMPT, type: "goal-oriented", title: "scheduled under pressure" })
        .pipe(Effect.flip)

      expect((error as SessionSpawner.SpawnLimitError).reason).toBe("pressure")
    }),
  )

  it.live("carries title, metadata and prompt origin — the fields whose absence caused the bypass", () =>
    Effect.gen(function* () {
      const location = yield* workspace
      const session = yield* SessionV2.Service
      const parent = yield* session.create({ location, agent: rootAgent })

      const spawned = yield* session
        .spawn({
          parentID: parent.id,
          text: PROMPT,
          type: "goal-oriented",
          title: "summarize my inbox",
          metadata: { messengerChatID: "self1" },
          origin: {
            via: "messenger",
            driver: "fake",
            accountID: "acct1",
            chatID: "self1",
            senderID: "u1",
            senderName: "Nancy",
            messageID: "m1",
            trust: "operator",
          },
        })
        .pipe(Effect.orDie)

      const child = yield* session.get(spawned.id)
      expect(child.title).toBe("summarize my inbox")
      expect(child.metadata).toMatchObject({ messengerChatID: "self1" })
      expect(child.type).toBe("goal-oriented")
      expect(child.parentID).toBe(parent.id)
      // The child inherits the PARENT's location — one lookup, so the two cannot disagree.
      expect(child.location.directory).toBe(location.directory)
    }),
  )
})

describe("the spawn seam stays cycle-free", () => {
  // Why the wake is PUSHED into a dependency-free relay instead of the spawner PULLING
  // `SessionExecution`: the obvious edge is not a smell, it is fatal. `buildLocationServiceMap`
  // first binds the one process-wide CapabilityRegistry seam, then hoists global nodes out of every
  // location subtree and compiles them. `LayerNode.compile` throws on any OTHER unbound node — so one
  // added dependency still breaks every location boot in the product, including the plain
  // `locationServiceMapLayer` the CLI debug commands use.
  test("no unbound node is reachable from the location graph", () => {
    const replacements = CapabilityRegistry.bind(locationServices, [])
    const { hoisted } = LayerNode.hoist(locationServices, Node.tags.values.global, replacements)
    expect(() => LayerNode.compile(hoisted)).not.toThrow()
  })

  test("the guard actually bites: one SessionExecution edge makes the location graph uncompilable", () => {
    const withExecution = LayerNode.group([...locationServices.dependencies, SessionExecution.node])
    const replacements = CapabilityRegistry.bind(withExecution, [])
    const { hoisted } = LayerNode.hoist(withExecution, Node.tags.values.global, replacements)
    expect(() => LayerNode.compile(hoisted)).toThrow(/Unbound layer node/)
  })

  test("SessionSpawner reaches neither SessionExecution nor LocationServiceMap", () => {
    expect(LayerNode.hasUnbound(SessionSpawner.node, SessionExecution.node)).toBe(false)
    expect(LayerNode.hasUnbound(SessionSpawner.node, LocationServiceMap.node)).toBe(false)
    // …and it does reach the relay that carries the wake instead.
    expect(SessionSpawner.node.dependencies.map((node) => node.name)).toContain(SessionRunCoordinator.wakeNode.name)
  })

  test("the guard actually bites: hasUnbound finds the edge where one genuinely exists", () => {
    // SessionV2 is the node that legitimately holds both — the reachability check is not vacuous.
    expect(LayerNode.hasUnbound(SessionV2.node, SessionExecution.node)).toBe(true)
    expect(LayerNode.hasUnbound(SessionV2.node, LocationServiceMap.node)).toBe(true)
  })
})

describe("the wake relay", () => {
  // The relay is the ONE object both scopes see — Layer memoization on a single module-level layer,
  // with `LayerMap` building each location under the enclosing MemoMap. That identity is what the
  // end-to-end test above measures; this pins the relay's own contract, including the case that
  // must never be reported as success.
  it.effect("the guard actually bites: an unattached relay reports false instead of pretending", () =>
    Effect.gen(function* () {
      const wake = yield* SessionRunCoordinator.Wake
      const woken: string[] = []

      // Nothing attached yet — a fresh relay must NOT claim the work is running (ruling 2).
      expect(yield* wake.wake(SessionV2.ID.make("ses_relay_unattached"))).toBe(false)
      yield* wake.attach((sessionID) => Effect.sync(() => void woken.push(sessionID)))
      expect(yield* wake.wake(SessionV2.ID.make("ses_relay_attached"))).toBe(true)
      expect(woken).toEqual(["ses_relay_attached"])
    }).pipe(Effect.provide(Layer.fresh(SessionRunCoordinator.wakeLayer))),
  )
})

describe("the guard actually bites", () => {
  itUnwired.live("NEGATIVE CONTROL: with the wake seam inert the child never runs and never exits", () =>
    Effect.gen(function* () {
      const location = yield* workspace
      const session = yield* SessionV2.Service
      const parent = yield* session.create({ location, agent: rootAgent })

      const spawned = yield* spawnChild(parent.id, location)

      // The stub reports success — which is exactly how this regression would ship green again.
      expect(spawned.started).toBe(true)
      // Two seconds is generous: the location graph is already booted by the spawn above, so a live
      // seam starts the drain in milliseconds.
      expect(yield* ranWithin(spawned.id, Duration.seconds(2))).toBe(false)
      expect(runs.some((run) => run.sessionID === spawned.id)).toBe(false)
      expect((yield* session.get(spawned.id)).result).toBeUndefined()

      // …and the harness is otherwise live: resuming the child by hand (what `prompt` does through
      // `execution.wake`) runs it to its exit. So the silence above is the missing seam, not a dead
      // fixture — and every assertion in the first test of this file inverts here.
      yield* session.resume(spawned.id)
      expect(runs.some((run) => run.sessionID === spawned.id)).toBe(true)
      expect((yield* session.get(spawned.id)).result).toBe(`ran: ${PROMPT}`)
    }),
  )
})

/**
 * **The two doors onto "has this child finished?", proved to be ONE join** ().
 *
 * 🔴 `SessionV2.wait` — the `POST /api/session/:id/wait` door — used to be a hand-rolled
 * `for (let i = 0; i < 60)` loop re-reading the session row every 2000 ms and failing
 * `OperationUnavailable` after ~120 s, under a comment claiming *"same semantics as the wait TOOL"*.
 * It had neither the tool's transport nor its bound: `tool/wait.ts:53-59` records the measurement
 * that killed the 2-minute value — a child asked only to reply "BANANA" settled **121.7 s** after
 * `wait` started, 1.6 s after the poll had given up. So the HTTP door reported a healthy run as
 * unavailable, which is the one thing a supervisor must never do.
 *
 * ⚠️ The first test of this file already covers the case where the child has ALREADY exited, and it
 * passed against the poll too — the store read carries it. What could not be told apart there is
 * whether the wait actually JOINS. These use `TestClock`, because the claim under test IS a duration:
 * a virtual clock is the only way to stand at 3 minutes (past the old bound, inside the new one) and
 * at 11 minutes (past the new one) without a test that takes eleven minutes.
 */
describe("both wait doors are the same bounded join", () => {
  const stillRunning = <A, E>(fiber: Fiber.Fiber<A, E>) => fiber.pollUnsafe() === undefined

  it.effect("🔴 at THREE minutes it is still waiting — the old 2-minute bound is gone", () =>
    Effect.gen(function* () {
      const location = yield* workspace
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const child = yield* session.create({ location, agent: rootAgent })

      const waiting = yield* Effect.exit(session.wait(child.id)).pipe(Effect.forkChild)
      // Past 120_000 ms. The old implementation had failed `OperationUnavailable` by here, on a
      // child that is perfectly healthy and simply slow.
      yield* TestClock.adjust(Duration.minutes(3))
      expect(stillRunning(waiting)).toBe(true)

      // …and it is a JOIN, not a poll: the child's Completed event releases it.
      yield* events.publish(
        SessionEvent.Completed,
        { sessionID: child.id, timestamp: yield* DateTime.now, result: "done" },
        { location },
      )
      yield* TestClock.adjust(Duration.seconds(1))
      const exit = yield* Fiber.join(waiting)
      expect(exit._tag).toBe("Success")
    }),
  )

  it.effect("⚠️ it is still BOUNDED: past ten minutes it answers OperationUnavailable, as the endpoint promises", () =>
    Effect.gen(function* () {
      const location = yield* workspace
      const session = yield* SessionV2.Service
      const child = yield* session.create({ location, agent: rootAgent })

      const waiting = yield* Effect.exit(session.wait(child.id)).pipe(Effect.forkChild)
      yield* TestClock.adjust(Duration.millis(SessionJoin.JOIN_TIMEOUT_MS + 1000))
      const exit = yield* Fiber.join(waiting)
      expect(exit._tag).toBe("Failure")
      // The endpoint's contract is "503, re-call to keep waiting" — a timeout must NOT read as
      // success, which would tell a client a running child had finished.
      expect(JSON.stringify(exit)).toContain("OperationUnavailableError")
    }),
  )

  test("the bound is ONE constant, not two — this is the whole finding", () => {
    // The tool path and the HTTP path both read `SessionJoin.JOIN_TIMEOUT_MS`. Two copies is how the
    // 2026-08-20 fix landed on one door and not the other.
    expect(SessionJoin.JOIN_TIMEOUT_MS).toBe(10 * 60_000)
    const waitTool = readFileSync(new URL("../src/tool/wait.ts", import.meta.url), "utf8")
    const kernel = readFileSync(new URL("../src/session.ts", import.meta.url), "utf8")
    expect(waitTool).toContain("SessionJoin.JOIN_TIMEOUT_MS")
    expect(kernel).toContain("SessionJoin.JOIN_TIMEOUT_MS")
    // And the poll is gone: the kernel's `wait` no longer sleeps in a loop.
    //
    // ⚠️ Bounded by the NEXT method, not by a character count. This read `slice(0, 2000)` until
    // 2026-09-02, when adding four lines of comment inside `wait` pushed `awaitCompletion` past
    // character 2000 and turned this red — for a function whose behaviour had not changed at all. A
    // window measured in characters is a guard that fires on prose, and prose is the thing this
    // repository asks for most.
    const from = kernel.indexOf('Effect.fn("V2Session.wait")')
    expect(from, "the kernel no longer defines V2Session.wait — this scan is looking at nothing").toBeGreaterThan(0)
    const next = kernel.indexOf('Effect.fn("', from + 1)
    const wait = next === -1 ? kernel.slice(from) : kernel.slice(from, next)
    expect(wait.length, "the slice is empty or absurdly short — the boundary marker moved").toBeGreaterThan(200)
    expect(wait).not.toContain("Effect.sleep")
    expect(wait).toContain("awaitCompletion")
  })
})
