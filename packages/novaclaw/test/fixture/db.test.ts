import { afterEach, describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import { Database } from "@novaclaw/core/database/database"
import { Flag } from "@novaclaw/core/flag/flag"
import { RESETTABLE_DB, assertResettableDatabase, resetDatabase } from "./db"
import { tmpdir } from "./fixture"
import { InstanceRuntime } from "../../src/project/instance-runtime"

/**
 * ─── the guard on `resetDatabase()` ────────────────────────────────────────────────────────────────
 *
 * `resetDatabase()` shipped as three `rm()` calls against `Database.path()` plus its `-wal`/`-shm`
 * sidecars. `test/preload.ts` pins `NOVACLAW_DB=":memory:"` and `DatabasePath.path` returns that value
 * verbatim, so every removal targeted a relative path named `:memory:` that has never existed, both
 * `{ force: true }` and a trailing `.catch()` swallowed the outcome, and the function silently degraded
 * to "dispose instances". 31 suites / ~77 call sites believed otherwise.
 *
 * These tests exist so that cannot happen again without a red. Each has its own negative control —
 * an assertion that FAILS if the thing being checked stops being observable — because a check that
 * passes vacuously is the same defect one level up.
 */
describe("resetDatabase", () => {
  const original = Flag.NOVACLAW_DB
  afterEach(() => {
    Flag.NOVACLAW_DB = original
  })

  /**
   * The anchor fact. If this ever stops holding, the fixture's whole model of the test database is
   * wrong and the guard below starts throwing at all ~77 call sites — which is the intended failure
   * mode, but this test says WHY in one line instead of 77.
   */
  test("the test process runs against the in-memory database preload.ts pins", () => {
    expect(Flag.NOVACLAW_DB).toBe(RESETTABLE_DB)
    expect(Database.path()).toBe(RESETTABLE_DB)
  })

  test("the guard accepts the in-memory database", () => {
    expect(() => assertResettableDatabase()).not.toThrow()
    expect(() => assertResettableDatabase(RESETTABLE_DB)).not.toThrow()
  })

  /**
   * NEGATIVE CONTROL for the guard: point the flag at a real file path — the one configuration whose
   * removal the deleted code pretended to perform — and require a refusal that NAMES the path.
   * If the guard is weakened to a warning or deleted, this goes red.
   */
  test("refuses a file-backed database instead of reporting a reset it did not do", async () => {
    const file = path.join(os.tmpdir(), "novaclaw-db-guard-negative-control.sqlite")
    Flag.NOVACLAW_DB = file

    expect(Database.path()).toBe(file)
    expect(() => assertResettableDatabase()).toThrow(/only supports NOVACLAW_DB/)
    // the path itself must appear, so the refusal names the fault instead of describing it vaguely
    expect(() => assertResettableDatabase()).toThrow("novaclaw-db-guard-negative-control.sqlite")
    await expect(resetDatabase()).rejects.toThrow(/only supports NOVACLAW_DB/)
  })

  /**
   * The anti-no-op check. `resetDatabase()` is allowed to not clear the database, but it is NOT
   * allowed to do nothing: it must still dispose live instances, which is the one effect ~77 call
   * sites actually get. `InstanceStore` caches one `InstanceContext` object per directory and deletes
   * the entry on dispose, so object identity across `load()` is the observable.
   *
   * NEGATIVE CONTROL, in-test: the `toBe(first)` leg proves the identity signal is meaningful — a
   * cached load returns the SAME object, so `not.toBe` afterwards can only be produced by a real
   * dispose, never by `load()` handing out a fresh object every time.
   */
  test("disposes live instances (it may be a no-op for the DB, never a no-op outright)", async () => {
    await using dir = await tmpdir()

    const first = await InstanceRuntime.load({ directory: dir.path })
    const cached = await InstanceRuntime.load({ directory: dir.path })
    expect(cached).toBe(first)

    await resetDatabase()

    const afterReset = await InstanceRuntime.load({ directory: dir.path })
    expect(afterReset).not.toBe(first)

    await InstanceRuntime.disposeAllInstances()
  }, 30_000)
})
