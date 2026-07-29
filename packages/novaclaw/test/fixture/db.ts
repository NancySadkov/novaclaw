import { Database } from "@novaclaw/core/database/database"
import { disposeAllInstances, sweepDataPlane } from "./fixture"

/**
 * The one database configuration this fixture knows how to handle: the in-memory SQLite that
 * `test/preload.ts` pins for every test in this package (`NOVACLAW_DB=":memory:"`).
 */
export const RESETTABLE_DB = ":memory:"

/**
 * Fail loudly if the process is running against a database `resetDatabase()` cannot speak for.
 *
 * Exported so `db.test.ts` can drive BOTH sides of the guard — the whole point of the guard is that
 * it bites, and a guard nobody exercises is the same silent-no-op defect one level up.
 */
export function assertResettableDatabase(dbPath: string = Database.path()): void {
  if (dbPath === RESETTABLE_DB) return
  throw new Error(
    `resetDatabase(): the test fixture only supports NOVACLAW_DB=":memory:" (test/preload.ts pins it), ` +
      `but Database.path() resolved to ${JSON.stringify(dbPath)}. This fixture disposes instances and ` +
      `does NOT clear a file-backed database — it is refusing rather than reporting a reset it did not do.`,
  )
}

/**
 * Dispose every live instance, then clear the session/runtime data plane of the database the server
 * under test actually uses. The name is now true; for most of this fixture's life it was not.
 *
 * **What it used to be.** Three `rm()` calls against `Database.path()` plus `-wal`/`-shm`. Under this
 * package's preload `Database.path()` is the literal `":memory:"` (`DatabasePath.path` returns
 * `Flag.NOVACLAW_DB` verbatim for that value), so all three targeted a RELATIVE path named `:memory:`
 * that has never existed — `{ force: true }` swallowed the ENOENT and a trailing `.catch()` swallowed
 * the rest. Every one of the ~77 call sites across `test/server/**` believed it was getting a fresh
 * database in `beforeAll`/`beforeEach` and was getting an instance dispose (ruling 3 — a failed
 * mutation never reports success).
 *
 * **Why the reset has this shape.** Under `:memory:` a database is identified by its LAYER BUILD, not
 * a path: every distinct top-level build is a separate private database. The only one the server
 * under test reads is the instance behind the shared `memoMap`, so the sweep runs through
 * `fixture.ts`'s `onServer()` and nowhere else. Rebuilding the layer instead is NOT viable — the
 * fixture's scope is deliberately never closed (`fixture.ts` §"the scope is NEVER CLOSED"), because
 * the first `tmpdir()` precedes `Server.Default()` and releasing it would finalize the very database
 * the server is about to memoize.
 *
 * **What it does NOT clear, deliberately: the config plane.** `SettingsConfigSeed` runs from
 * `config-seed-startup.ts`, a startup node rather than the store layer, so truncating the config
 * stores would wipe seeded settings with nothing on the request path to re-seed them. Config
 * isolation is already owned — correctly and with its own bookkeeping — by `provisioned` +
 * `clearProvisioned`, and two mechanisms competing for one concern is how the original defect
 * survived a commit. `sweepDataPlane` therefore ends by running `clearProvisioned` and
 * `Config.use.invalidate()` rather than deleting those rows itself.
 */
export async function resetDatabase() {
  assertResettableDatabase()
  await disposeAllInstances().catch(() => undefined)
  await sweepDataPlane()
}

// V1-nuke slice D: the facade Session.Service died — route tests seed sessions by publishing the
// NATIVE record event (the projector writes the row; the durable event feeds sync history).
import { DateTime, Effect } from "effect"
import { EventV2 } from "@novaclaw/core/event"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionRecordEvent } from "@novaclaw/schema/session-record-event"
import { AbsolutePath } from "@novaclaw/core/schema"
import { Location } from "@novaclaw/core/location"

let seededSessions = 0
export function seedSessionRow(input?: { title?: string; directory?: string }) {
  return Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const id = SessionSchema.ID.make(`ses_test${String(++seededSessions).padStart(20, "0")}`)
    const directory = AbsolutePath.make(input?.directory ?? "C:/project")
    const now = DateTime.makeUnsafe(Date.now())
    const title = input?.title ?? "test"
    yield* events.publish(
      SessionRecordEvent.Created,
      {
        sessionID: id,
        info: SessionSchema.Info.make({
          id,
          slug: id,
          version: "test",
          title,
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          location: Location.Ref.make({ directory }),
          time: { created: now, updated: now },
        }),
      },
      { location: Location.Ref.make({ directory }) },
    )
    return { id, title }
  })
}
