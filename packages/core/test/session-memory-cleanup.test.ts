import { AgentV2 } from "@novaclaw/core/agent"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { Location } from "@novaclaw/core/location"
import { Memory } from "@novaclaw/core/kb-graph/memory"
import { MemoryClient } from "@novaclaw/core/kb-graph/memory-client"
import { ProjectV2 } from "@novaclaw/core/project"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionExecution } from "@novaclaw/core/session/execution"
import { SessionMemoryCleanup } from "@novaclaw/core/session/memory-cleanup"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionScheduler } from "@novaclaw/core/session/scheduler"
import { SessionStore } from "@novaclaw/core/session/store"
import { testEffect } from "./lib/effect"

/**
 * DELETING A CHAT MUST TAKE ITS MEMORIES WITH IT — NC-SEC-019.
 *
 * 🔴 Revalidated at HEAD before any work, because the finding was written against an app commit
 * hundreds behind: `removeSessionRecord` enumerates interrupt, scheduler eviction, JH records,
 * recursive children, the session row and the event log, and its dependency shape contained no memory
 * service at all. Repository-wide, `clearScope` was called only by the Memory HTTP endpoint. So a
 * memory the user deliberately wrote with `scope: "session"` outlived the conversation the product
 * told them was removed permanently.
 *
 * ⚠️ **The graph-unavailable case is the point of the design**, not an edge case. A best-effort call
 * inside the deletion would turn a ten-second outage into permanent retention with success already
 * reported, so the request is a DURABLE tombstone and the sweep is retryable.
 */

/**
 * 🔴 NC-SEC-020 — a ROOT names the agent it runs as; there is no anonymous chat. `build` records the
 * POSTURE this chat runs in, which is the ordinary production case and keeps these tests' semantics
 * unchanged: a posture is excluded from the canonical `ses_<agent>` id and from the one-chat guard.
 */
const rootAgent = AgentV2.ID.make("build")

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({ resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }) }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionScheduler.node,
      SessionV2.node,
      // ⚠️ Declared HERE too because these tests reach the client directly. The session node already
      // depends on it, so existing harnesses resolve it unchanged — verified across 54 of their tests.
      Memory.node,
    ]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })

/**
 * A memory client that can be taken away, so "the graph is down" is a thing a test can do.
 *
 * ⚠️ Used only for the SWEEP's own tests. The wiring tests go through the LAYER's client, because the
 * first draft of this file seeded a separate stub and asserted against it — while the sweep that
 * `session.remove` performs cleared the tombstone against the other store. Every assertion failed, for
 * the right reason: two stores, and the one under test was not the one production used.
 */
/**
 * Do these specific ids still exist?
 *
 * ⚠️ Asserted per ID rather than on the whole list. The layer's memory store is ONE real engine shared
 * by every test in this file, so an earlier test's rows are still there — the first draft asserted an
 * empty store and got twenty-two. A test that needs the world to be empty is a test coupled to
 * everything that ran before it.
 */
const survivors = (memory: MemoryClient.Interface, ids: readonly string[]) =>
  memory.list({ limit: 500, includeInvalid: true }).pipe(
    Effect.map((rows) =>
      rows
        .filter((row) => ids.includes(row.id))
        .map((row) => row.id)
        .sort(),
    ),
  )

function makeMemory(options: { available?: boolean } = {}) {
  const live = MemoryClient.stub()
  const state = { available: options.available ?? true, cleared: [] as string[] }
  const client: MemoryClient.Interface = {
    ...live,
    clearScope: (scope) => {
      if (!state.available) return Effect.fail(new MemoryClient.MemoryError({ reason: "memory is unavailable" }))
      state.cleared.push(scope)
      return live.clearScope(scope)
    },
  }
  return { client, state, live }
}

describe("deleting a chat takes its memories", () => {
  it.effect("🔴 a session-scoped memory is gone once the chat is deleted", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const memory = Memory.client(yield* Memory.node.service)
      const created = yield* session.create({ location, agent: rootAgent })
      yield* memory.addMemory({ id: "m1", kind: "entity", text: "a private note", scope: `session:${created.id}` })
      yield* memory.addMemory({ id: "keep", kind: "entity", text: "a shared note", scope: "global" })

      yield* session.remove(created.id)

      // `session.remove` writes the tombstone AND sweeps, so the memory is gone by the time the user's
      // request returns. The durable row is what makes it survive an outage, not what delays it.
      // ⚠️ `includeInvalid` — `clearScope` is a hard delete, so a soft-invalidated row would still be
      // here and this assertion has to be able to see one.
      expect(yield* survivors(memory, ["m1", "keep"])).toEqual(["keep"])
    }),
  )

  it.effect("⚠️ another chat's memories are untouched", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const memory = Memory.client(yield* Memory.node.service)
      const doomed = yield* session.create({ location, agent: rootAgent })
      const survivor = yield* session.create({ location, agent: rootAgent })
      yield* memory.addMemory({ id: "gone", kind: "entity", text: "x", scope: `session:${doomed.id}` })
      yield* memory.addMemory({ id: "stays", kind: "entity", text: "y", scope: `session:${survivor.id}` })

      yield* session.remove(doomed.id)

      expect(yield* survivors(memory, ["gone", "stays"])).toEqual(["stays"])
    }),
  )

  it.effect("every chat in a deleted TREE loses its memories, not just the root", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const memory = Memory.client(yield* Memory.node.service)
      const parent = yield* session.create({ location, agent: rootAgent })
      const child = yield* session.create({ location, agent: rootAgent, parentID: parent.id })
      for (const id of [parent.id, child.id])
        yield* memory.addMemory({ id: `m_${id}`, kind: "entity", text: "note", scope: `session:${id}` })

      yield* session.remove(parent.id)

      expect(yield* survivors(memory, [`m_${parent.id}`, `m_${child.id}`])).toEqual([])
    }),
  )

  it.effect("nothing is left outstanding once the sweep succeeds", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location, agent: rootAgent })
      yield* session.remove(created.id)
      expect(yield* SessionMemoryCleanup.pending(db)).toEqual([])
    }),
  )
})

describe("the sweep itself", () => {
  it.effect("🔴 an UNAVAILABLE graph DEFERS the cleanup — it never loses it", () =>
    Effect.gen(function* () {
      // The failure the whole design exists for: a best-effort inline call would report success to the
      // user and never come back to it. Driven directly, because what matters here is what happens
      // AFTER the sweep `session.remove` already attempted could not do its job.
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location, agent: rootAgent })
      yield* session.remove(created.id)
      // Re-request as if the earlier sweep had failed: the session is gone, the work is not done.
      yield* SessionMemoryCleanup.request(db, created.id)

      const down = makeMemory({ available: false })
      expect(yield* SessionMemoryCleanup.sweep(db, down.client)).toEqual({ cleared: 0, retracted: 0, deferred: 1 })
      // The tombstone SURVIVES, which is the whole difference.
      expect((yield* SessionMemoryCleanup.pending(db)).map((r) => r.session_id)).toEqual([created.id])

      // …and when the graph comes back — a later sweep, or the next boot — it is discharged.
      const up = makeMemory()
      expect(yield* SessionMemoryCleanup.sweep(db, up.client)).toEqual({ cleared: 1, retracted: 0, deferred: 0 })
      expect(up.state.cleared).toEqual([`session:${created.id}`])
      expect(yield* SessionMemoryCleanup.pending(db)).toEqual([])
    }),
  )

  it.effect("⚠️ a tombstone whose session STILL EXISTS is retracted, never honoured", () =>
    Effect.gen(function* () {
      // The tombstone is written before the deletion, so a crash between the two can leave one for a
      // live chat. Clearing a live chat's memories would be far worse than delaying a dead one's, so
      // the sweeper re-checks rather than trusting the row.
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const memory = makeMemory()
      const alive = yield* session.create({ location, agent: rootAgent })
      yield* memory.live.addMemory({ id: "m1", kind: "entity", text: "still mine", scope: `session:${alive.id}` })

      yield* SessionMemoryCleanup.request(db, alive.id)
      expect(yield* SessionMemoryCleanup.sweep(db, memory.client)).toEqual({ cleared: 0, retracted: 1, deferred: 0 })
      expect(memory.state.cleared).toEqual([])
      expect((yield* memory.live.list({ limit: 50 })).map((m) => m.id)).toEqual(["m1"])
      expect(yield* SessionMemoryCleanup.pending(db)).toEqual([])
    }),
  )

  it.effect("requesting twice is idempotent — one row", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location, agent: rootAgent })
      yield* SessionMemoryCleanup.request(db, created.id)
      yield* SessionMemoryCleanup.request(db, created.id)
      expect((yield* SessionMemoryCleanup.pending(db)).length).toBe(1)
    }),
  )

  it.effect("a sweep with nothing outstanding does nothing and does not reach the graph", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const memory = makeMemory()
      expect(yield* SessionMemoryCleanup.sweep(db, memory.client)).toEqual({
        cleared: 0,
        retracted: 0,
        deferred: 0,
      })
      expect(memory.state.cleared).toEqual([])
    }),
  )
})
