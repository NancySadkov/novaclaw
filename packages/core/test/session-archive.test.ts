import { AgentV2 } from "@novaclaw/core/agent"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { Location } from "@novaclaw/core/location"
import { ProjectV2 } from "@novaclaw/core/project"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionExecution } from "@novaclaw/core/session/execution"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionScheduler } from "@novaclaw/core/session/scheduler"
import { SessionStore } from "@novaclaw/core/session/store"
import { testEffect } from "./lib/effect"

/**
 * 🔴 The invariant's OTHER half, beside removal: *"If session gets cleared/archived — it gets
 * cleared/archived too. I.e. workers and shell commands of an cleared/archived session are stopped."*
 *
 * `setArchived` used to only patch the row, so archiving a chat left its workers and shells running —
 * and `time_archived IS NULL` is the "live root" predicate, so the product's own clear/yield path
 * (`sql.ts`) archived precisely to make way for a successor while the predecessor kept working.
 * Found 2026-09-22 while fixing the orphaned-`bash_job`-row class.
 *
 * The executor is a RECORDER here: the point is that the archive seam calls `interrupt` (which walks
 * the whole tree and, in production, kills worker processes and settles their job rows), and that a
 * restore does not.
 */
const rootAgent = AgentV2.ID.make("build")

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
  }),
)

const interrupts: string[] = []
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set()),
    resume: () => Effect.void,
    adopt: () => Effect.void,
    wake: () => Effect.void,
    interrupt: (sessionID) => Effect.sync(() => void interrupts.push(String(sessionID))),
    stopCommand: () => Effect.succeed(false),
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
      [SessionExecution.node, execution],
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })

const ledgerHas = (devices: readonly SessionScheduler.DeviceSnapshot[], sessionID: string) =>
  devices.some((device) => device.ledger.some((entry) => entry.id === sessionID))

describe("archiving a session stops its work", () => {
  it.effect("interrupts the archived session before patching the row", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location, agent: rootAgent })
      interrupts.length = 0

      yield* session.setArchived({ sessionID: created.id, time: Date.now() })

      expect(interrupts).toEqual([String(created.id)])
      expect((yield* session.get(created.id)).time.archived).toBeDefined()
    }),
  )

  it.effect("🔴 evicts the archived session from the device ledger, so a queued turn cannot dispatch", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const scheduler = yield* SessionScheduler.Service
      const created = yield* session.create({ location, agent: rootAgent })
      yield* scheduler.admit({ sessionID: created.id, deviceKey: "d", sessionClass: "interactive-focused" })
      expect(ledgerHas(yield* scheduler.snapshot(), created.id)).toBe(true)

      yield* session.setArchived({ sessionID: created.id, time: Date.now() })

      expect(ledgerHas(yield* scheduler.snapshot(), created.id)).toBe(false)
    }),
  )

  it.effect("a non-archiving call interrupts nothing (the guard is `time`, not the method)", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location, agent: rootAgent })
      interrupts.length = 0

      // `undefined` is not an archive: the RESTORE route clears `archived` through `restore`, and a
      // restore must never stop the work it is bringing back.
      yield* session.setArchived({ sessionID: created.id, time: undefined })

      expect(interrupts).toEqual([])
    }),
  )
})
