import { describe, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect, Exit } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@novaclaw/effect-drizzle-sqlite"
import { DatabaseMigration } from "@novaclaw/core/database/migration"
import retireAnonymousAgents from "@novaclaw/core/database/migration/20260927201500_retire_the_anonymous_agents"

/**
 * 🔴 **RETIRING THE ANONYMOUS AGENTS — on a database that actually holds them.**
 *
 * Owner, 2026-09-27: *"get completely rid of build and plan both as colleagues and as machinery."*
 *
 * The measured shape this exists for is on the owner's OWN instances, 2026-08-24: **55–98 live `build`
 * roots and 76 `plan`**, held there by a partial unique index that exempted `agent NOT IN
 * ('build','plan')` — an index exempting the very state it was supposed to prevent. So the migration's
 * job is not to delete two rows from a table; it is to make that index express what it always meant
 * while the rows it was sheltering are dealt with safely.
 *
 * ⭐ **The order is the whole test.** Archive, THEN rebuild the index. Run in the other order SQLite
 * refuses `CREATE UNIQUE INDEX` — which is why these assertions are in this order and why the archive
 * is asserted *before* the index is touched: a migration that looks right and cannot run is a
 * migration that strands every instance on that version.
 */
const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

/** The legacy schema, with the exempted index — the state the owner's instances are in. */
const legacyInstance = Effect.gen(function* () {
  const db = yield* makeDb
  yield* db.run(sql`
    CREATE TABLE session (
      id text PRIMARY KEY,
      agent text,
      parent_id text,
      time_archived integer,
      time_created integer NOT NULL DEFAULT 0
    )
  `)
  yield* db.run(sql`CREATE TABLE agent_config (name text PRIMARY KEY, layers text NOT NULL, time_created integer NOT NULL DEFAULT 0)`)
  yield* db.run(sql`CREATE TABLE agent_retirement (id integer PRIMARY KEY AUTOINCREMENT, agent text NOT NULL, retired_at integer NOT NULL)`)
  yield* db.run(sql`CREATE TABLE session_message (id text PRIMARY KEY, type text NOT NULL, data text, time_created integer NOT NULL DEFAULT 0)`)
  yield* db.run(sql`
    CREATE UNIQUE INDEX session_agent_live_root_idx ON session (agent)
    WHERE parent_id IS NULL AND time_archived IS NULL AND agent IS NOT NULL AND agent NOT IN ('build', 'plan')
  `)
  // 3 build roots, 2 plan roots, one archived build, one live colleague, and two WORKERS whose
  // `agent` is an override rather than ownership.
  yield* db.run(sql`
    INSERT INTO session (id, agent, parent_id, time_archived, time_created) VALUES
      ('b1', 'build', NULL, NULL, 10),
      ('b2', 'build', NULL, NULL, 20),
      ('b3', 'build', NULL, NULL, 30),
      ('p1', 'plan',  NULL, NULL, 15),
      ('p2', 'plan',  NULL, NULL, 25),
      ('b_old', 'build', NULL, 999, 5),
      ('nova1', 'nova', NULL, NULL, 40),
      ('w1', 'nova', 'b1', NULL, 50),
      ('w2', 'nova', 'p1', NULL, 60)
  `)
  yield* db.run(sql`INSERT INTO agent_config (name, layers, time_created) VALUES ('build', '[]', 1), ('plan', '[]', 1), ('daedalus', '[]', 1)`)
  yield* db.run(sql`INSERT INTO session_message (id, type, data, time_created) VALUES ('m1', 'colleague', '{"sender":"build"}', 70)`)
  return db
})

describe("retiring the anonymous agents", () => {
  test("🔴 every live posture root is ARCHIVED — recoverable, not deleted, not reassigned", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* legacyInstance
        yield* DatabaseMigration.applyOnly(db, [retireAnonymousAgents])

        const rows = yield* db.all<{ id: string; time_archived: number | null }>(
          sql`SELECT id, time_archived FROM session ORDER BY id`,
        )
        const archived = new Map(rows.map((row) => [row.id, row.time_archived]))
        // The five live posture roots are all filed. This is the load-bearing assertion: ARCHIVED,
        // so `Clear chat` and `retire` already know how to read them back. Deleting would have
        // thrown away the user's own history to tidy an index.
        for (const id of ["b1", "b2", "b3", "p1", "p2"])
          expect(archived.get(id), `${id} is still a live session`).not.toBeNull()
        // …and the rows still EXIST. Nothing was dropped.
        expect(rows).toHaveLength(9)
        // The colleague's own live root is untouched, and the already-archived one keeps its stamp.
        expect(archived.get("nova1")).toBeNull()
        expect(archived.get("b_old")).toBe(999)
      }),
    )
  })

  test("🔴 a posture is no longer EXEMPT — the index now holds it to one live root", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* legacyInstance
        yield* DatabaseMigration.applyOnly(db, [retireAnonymousAgents])
        // This is the RATCHET, and its true shape is worth stating exactly: the index does NOT refuse
        // a posture root outright, because a unique index cannot express "this value is not allowed" —
        // only "this value appears once". Before, `build` was exempt and could hold 55-98 live roots
        // on the owner's own instances. Now it holds AT MOST ONE, under the identical rule as a
        // colleague.
        //
        // The stronger half is above the database and is why this is a backstop rather than the guard:
        // `plugin/agent.ts` no longer seeds either id, the migration deleted the stored rows, and
        // `createSessionRecord` requires a resolvable agent on a root. This test is the last line, and
        // a last line that grows from "unlimited" to "one" is the difference between a state the
        // instance could accumulate in and one it cannot.
        yield* db.run(sql`INSERT INTO session (id, agent, parent_id, time_archived, time_created) VALUES ('b4', 'build', NULL, NULL, 70)`)
        const refused = yield* Effect.exit(
          db.run(sql`INSERT INTO session (id, agent, parent_id, time_archived, time_created) VALUES ('b5', 'build', NULL, NULL, 80)`),
        )
        expect(Exit.isFailure(refused), "a SECOND live build root was accepted").toBe(true)
        expect(yield* db.all(sql`SELECT count(*) AS n FROM session WHERE agent = 'build' AND parent_id IS NULL AND time_archived IS NULL`)).toEqual([{ n: 1 }])
      }),
    )
  })

  test("a COLLEAGUE's live root is still one, and still enforced", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* legacyInstance
        yield* DatabaseMigration.applyOnly(db, [retireAnonymousAgents])
        // The positive half of the ratchet: an index that refuses everything is not a fix either, and
        // one chat per colleague is the invariant the whole roster rests on.
        const refused = yield* Effect.exit(
          db.run(sql`INSERT INTO session (id, agent, parent_id, time_archived, time_created) VALUES ('nova2', 'nova', NULL, NULL, 70)`),
        )
        expect(Exit.isFailure(refused), "a second live nova root was accepted").toBe(true)
        expect(yield* db.all(sql`SELECT count(*) AS n FROM session WHERE agent = 'nova' AND parent_id IS NULL AND time_archived IS NULL`)).toEqual([{ n: 1 }])
        // A worker is exempt — it is a thread under its officer, not a second root.
        yield* db.run(sql`INSERT INTO session (id, agent, parent_id, time_archived, time_created) VALUES ('w3', 'nova', 'nova1', NULL, 80)`)
        expect(yield* db.all(sql`SELECT count(*) AS n FROM session WHERE agent = 'nova'`)).toEqual([{ n: 4 }])
      }),
    )
  })

  test("🔴 the stored agent rows are DELETED, and a colleague's are not", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* legacyInstance
        yield* DatabaseMigration.applyOnly(db, [retireAnonymousAgents])
        const rows = yield* db.all<{ name: string }>(sql`SELECT name FROM agent_config ORDER BY name`)
        // They were code-seeded by the plugin, so a surviving row is a resurrection rather than a
        // memory: `plugin/agent.ts` re-declares its agents every boot.
        expect(rows.map((row) => row.name)).toEqual(["daedalus"])
      }),
    )
  })

  test("both ids land in the retirement ledger, dated by their newest evidence", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* legacyInstance
        yield* DatabaseMigration.applyOnly(db, [retireAnonymousAgents])
        const rows = yield* db.all<{ agent: string; retired_at: number }>(
          sql`SELECT agent, retired_at FROM agent_retirement ORDER BY agent`,
        )
        // The pool of names and every "who used to be here" reader now learn these two are GONE
        // rather than never having existed. `build` is dated 70 — its newest evidence is a colleague
        // message, later than its newest session.
        expect(rows).toEqual([
          { agent: "build", retired_at: 70 },
          { agent: "plan", retired_at: 25 },
        ])
      }),
    )
  })

  test("it is IDEMPOTENT — a second run neither throws nor un-archives anything", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* legacyInstance
        yield* DatabaseMigration.applyOnly(db, [retireAnonymousAgents])
        const first = yield* db.all<{ id: string; time_archived: number | null }>(sql`SELECT id, time_archived FROM session WHERE id = 'b1'`)
        yield* DatabaseMigration.applyOnly(db, [retireAnonymousAgents])
        const second = yield* db.all<{ id: string; time_archived: number | null }>(sql`SELECT id, time_archived FROM session WHERE id = 'b1'`)
        // `coalesce` keeps the original stamp: re-running must not rewrite history, and the ledger
        // insert is guarded by NOT EXISTS for the same reason.
        expect(second).toEqual(first)
        expect(second[0]?.time_archived).not.toBeNull()
        expect(yield* db.all(sql`SELECT count(*) AS n FROM agent_retirement`)).toEqual([{ n: 2 }])
      }),
    )
  })
})
