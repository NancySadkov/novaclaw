// THE TOMBSTONE'S DRAIN — a mechanism that existed, was tested, and was never called.
//
// 🔴 Deleting a chat writes a durable `session_memory_cleanup` row and then sweeps it best-effort,
// under a comment promising *"the durable row is what guarantees the cleanup happens; this is only
// what makes it happen NOW rather than at the next boot."* **There was no next-boot sweep.**
// `SessionBootRecovery.start` forked two arms and `SessionMemoryCleanup.sweep` had exactly one
// production caller — the deletion that had just written the row. So a deletion that ran while the
// memory engine was down left every `scope: "session"` memory on disk under `session:<deleted-id>`,
// still enumerable in the Memory app, until the user happened to delete ANOTHER chat.
//
// ⚠️ That is NC-SEC-019 reopened one layer down: the tombstone landed, its drain did not. A feature
// built, tested and never called is indistinguishable from the bug it replaced, so the claim here is
// specifically about the CALLER — the sweep's own behaviour is already covered by
// `session-memory-cleanup.test.ts`.

import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect, Layer } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { ProjectV2 } from "@novaclaw/core/project"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionExecution } from "@novaclaw/core/session/execution"
import { SessionMemoryCleanup } from "@novaclaw/core/session/memory-cleanup"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionTable } from "@novaclaw/core/session/sql"
import { testEffect } from "./lib/effect"

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({ resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }) }),
)

/**
 * ⭐ The harness holds only the DATABASE. Booting the session graph is the thing under test, so it
 * happens INSIDE the test body — over this same database — which is what lets a tombstone exist
 * before the boot that has to discharge it. A harness that already contained `SessionV2.node` would
 * have run the sweep against an empty table before the first line of any test.
 */
const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node])))

const survivor = SessionSchema.ID.make("ses_tombstone_boot_survivor")

/** The boot arm is forked, so give it a bounded chance to land rather than racing it. */
const settle = (db: Database.Interface["db"]) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((yield* SessionMemoryCleanup.pending(db)).length === 0) return
      yield* Effect.sleep("10 millis")
    }
  })

describe("SessionMemoryCleanup at boot", () => {
  /**
   * The tombstone here names a session that STILL EXISTS — the crash-in-between window the module's
   * own header describes. That path is deliberate: it discharges through `sweep`'s retraction arm
   * and touches no graph at all, so this test measures the CALLER and cannot go red because a memory
   * engine was unreachable in CI.
   */
  it.live("a boot discharges a tombstone left behind by a previous process", () =>
    Effect.gen(function* () {
      const database = yield* Database.Service
      const { db } = database
      yield* db
        .insert(SessionTable)
        .values({ id: survivor, slug: "survivor", directory: "/project", title: "survivor", version: "test" })
        .run()
        .pipe(Effect.orDie)
      yield* SessionMemoryCleanup.request(db, survivor)
      expect(
        (yield* SessionMemoryCleanup.pending(db)).map((row) => String(row.session_id)),
        "the tombstone is outstanding before the boot",
      ).toEqual([String(survivor)])

      // BOOT — a session graph over this exact database. Nothing else in this test deletes a chat,
      // so the only thing that can drain the table is a caller wired into startup.
      yield* Effect.provide(
        settle(db),
        AppNodeBuilder.build(SessionV2.node, [
          [Database.node, Layer.succeed(Database.Service, database)],
          [ProjectV2.node, projects],
          [SessionExecution.node, SessionExecution.noopLayer],
        ]),
      )

      expect(
        (yield* SessionMemoryCleanup.pending(db)).length,
        "boot must discharge it — before this fix, only the NEXT chat deletion did",
      ).toBe(0)

      // …and it was RETRACTED, not applied: a tombstone for a live chat must never take that chat's
      // memories with it, which is the whole reason the sweeper re-checks liveness.
      expect(
        yield* db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.id, survivor)).get().pipe(
          Effect.orDie,
        ),
      ).toBeDefined()
    }),
  )
})
