import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import path from "node:path"
import { Database } from "@novaclaw/core/database/database"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionAutoGrant } from "@novaclaw/core/session/auto-grant"
import { SessionTable } from "@novaclaw/core/session/sql"
import { tmpdir } from "./fixture/tmpdir"

const fixture = path.join(import.meta.dir, "fixtures/session-auto-grant-worker.ts")

describe("session auto-grant crosses the worker boundary", () => {
  test("a worker's narrowing is visible after that process exits", async () => {
    await using tmp = await tmpdir()
    const directory = tmp.path
    const databasePath = path.join(directory, "instance.db")
    const sessionID = SessionV2.ID.make("ses_auto_grant_worker_boundary")
    const database = Database.layerFromPath(databasePath)
    const environment = Layer.merge(database, SessionAutoGrant.layer.pipe(Layer.provide(database)))

    await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const grants = yield* SessionAutoGrant.Service
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            slug: String(sessionID),
            directory,
            title: "worker boundary",
            version: "test",
          })
          .run()
          .pipe(Effect.orDie)

        // NEGATIVE CONTROL: the host begins with no grant. The only writer below is another OS
        // process, matching production's disposable session-worker topology.
        expect(yield* grants.get(sessionID)).toBeUndefined()
        const worker = Bun.spawn([process.execPath, fixture, databasePath, sessionID], {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, NOVACLAW_DB: databasePath },
        })
        const [exitCode, stderr] = yield* Effect.promise(() =>
          Promise.all([worker.exited, new Response(worker.stderr).text()]),
        )
        expect(exitCode, stderr).toBe(0)

        expect(yield* grants.get(sessionID)).toMatchObject({
          mode: "plan",
          justification: "the worker is dropping mutation authority before analysis",
        })

        yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run().pipe(Effect.orDie)
        expect(yield* grants.get(sessionID), "the entity-lifetime component outlived its session").toBeUndefined()
      }).pipe(Effect.provide(environment), Effect.scoped),
    )
  }, 15_000)
})
