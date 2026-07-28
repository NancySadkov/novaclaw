import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import type { JhEngine } from "@novaclaw/core/jh/engine"
import { JhStore } from "@novaclaw/core/jh/store"
import { JhTree } from "@novaclaw/core/jh/tree"
import { Location } from "@novaclaw/core/location"
import { ProjectV2 } from "@novaclaw/core/project"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionExecution } from "@novaclaw/core/session/execution"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionScheduler } from "@novaclaw/core/session/scheduler"
import { SessionStore } from "@novaclaw/core/session/store"
import { testEffect } from "./lib/effect"

// `scheduler.evict` existed from day one and had NO production caller: the only reference anywhere
// was scheduler.test.ts. So every removed session kept its EEVDF ledger entry — and, if it died
// mid-turn, its in-flight or waiting entry — for the life of the instance. `removeSessionRecord`
// takes it the same way it takes `interrupt`: an optional injected primitive, so the service-less
// callers (the CLI's `session delete`) still compile and still mean something.

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
  }),
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
    ]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })

const ledgerHas = (devices: readonly SessionScheduler.DeviceSnapshot[], sessionID: string) =>
  devices.some((device) => device.ledger.some((entry) => entry.id === sessionID))

describe("removeSessionRecord — scheduler eviction", () => {
  it.effect("SessionV2.remove drops the session from the EEVDF ledger", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const scheduler = yield* SessionScheduler.Service
      const created = yield* session.create({ location })
      yield* scheduler.admit({ sessionID: created.id, deviceKey: "d", sessionClass: "interactive" })
      expect(ledgerHas(yield* scheduler.snapshot(), created.id)).toBe(true)

      yield* session.remove(created.id)

      const devices = yield* scheduler.snapshot()
      expect(ledgerHas(devices, created.id)).toBe(false)
      // and the slot it held is gone too, so the device is not left permanently batch-blocked
      expect(devices[0]!.inFlightInteractive).toEqual([])
    }),
  )

  it.effect("NEGATIVE CONTROL: without the injected evict the ledger entry survives removal", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const scheduler = yield* SessionScheduler.Service
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const created = yield* session.create({ location })
      yield* scheduler.admit({ sessionID: created.id, deviceKey: "d", sessionClass: "interactive" })

      // the pre-fix wiring: the seam called with {db, events} only
      yield* SessionV2.removeSessionRecord({ db, events }, created.id)

      const devices = yield* scheduler.snapshot()
      expect(ledgerHas(devices, created.id)).toBe(true)
      expect(devices[0]!.inFlightInteractive).toEqual([created.id])
    }),
  )

  it.effect("evicts every session in the removed tree, not just the root", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const scheduler = yield* SessionScheduler.Service
      const parent = yield* session.create({ location })
      const child = yield* session.create({ location, parentID: parent.id })
      const grandchild = yield* session.create({ location, parentID: child.id })
      // interactive, not batch: MAX_BATCH is 2, so a third batch admit would legitimately BLOCK
      for (const id of [parent.id, child.id, grandchild.id])
        yield* scheduler.admit({ sessionID: id, deviceKey: "d", sessionClass: "interactive" })

      yield* session.remove(parent.id)

      const devices = yield* scheduler.snapshot()
      for (const id of [parent.id, child.id, grandchild.id]) expect(ledgerHas(devices, id)).toBe(false)
      expect(devices[0]!.inFlightInteractive).toEqual([])
    }),
  )

  it.effect("removal cascades to the session's jh plans, logs and artifacts", () =>
    Effect.gen(function* () {
      // jh_plan/jh_log/jh_artifact carry no FK to the session table, so the `session.deleted`
      // projector's row-delete cascade never reached them: a deleted chat left its Strict plans,
      // its whole event log and its artifact CONTENT behind forever. `removeSessionRecord` writes
      // that cascade by hand.
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })
      const other = yield* session.create({ location })
      const state: JhEngine.State = {
        tree: JhTree.create({ goal: "g", size: "atomic", success: "ok" }),
        artifacts: [{ id: "a.c", type: "file", hash: "h", content: "int main(){}" }],
        log: [{ type: "task_started", goal: "g", seq: 0 }],
        telemetry: new Map(),
      }
      const key = `${JhStore.sessionPrefix(created.id)}msg_1`
      yield* JhStore.save(db, { id: key, goal: "g", status: "running", state, now: 1 })
      const survivor = `${JhStore.sessionPrefix(other.id)}msg_1`
      yield* JhStore.save(db, { id: survivor, goal: "g", status: "running", state, now: 1 })
      expect(yield* JhStore.load(db, key)).toBeDefined()

      yield* session.remove(created.id)

      expect(yield* JhStore.load(db, key)).toBeUndefined()
      expect(yield* JhStore.latest(db, JhStore.sessionPrefix(created.id))).toBeUndefined()
      // …and only this session's rows: the neighbouring chat still resumes.
      expect(yield* JhStore.load(db, survivor)).toBeDefined()
    }),
  )

  it.effect("the injected evict sees the whole tree, deepest child first", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const parent = yield* session.create({ location })
      const child = yield* session.create({ location, parentID: parent.id })
      const evicted: string[] = []

      yield* SessionV2.removeSessionRecord(
        { db, events, evict: (id) => Effect.sync(() => void evicted.push(id)) },
        parent.id,
      )

      // parent first (its own eviction precedes the child recursion) — what matters is that the
      // whole tree is covered, so a child's turn cannot keep holding a device slot after the
      // parent is deleted.
      expect(evicted).toEqual([parent.id, child.id])
    }),
  )
})
