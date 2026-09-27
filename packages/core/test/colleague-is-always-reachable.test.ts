import { describe, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import type { SqlClient as SqlClientService } from "effect/unstable/sql/SqlClient"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@novaclaw/effect-drizzle-sqlite"
import { DatabaseMigration } from "@novaclaw/core/database/migration"
import retireColleague from "@novaclaw/core/database/migration/20260928093000_colleague_is_always_reachable"
import { AgentPlugin } from "@novaclaw/core/plugin/agent"
import { PermissionV2 } from "@novaclaw/core/permission"

/**
 * 🔴 **A STORED `colleague` RULE IS A TOOL WITHDRAWN, AND THE MIGRATION IS THE ONLY THING THAT CAN
 * TAKE IT BACK.**
 *
 * Owner, 2026-09-27, on a live instance: *"Sopitis … tries to call colleague tool to report the
 * superior, nova, about the completed task, but it gets access denied `Deferred tool colleague is not
 * callable in this session`."*
 *
 * ⭐ **The code change alone would not have fixed the reported bug, and that is the finding this file
 * exists for.** `floor()` granting `colleague` to everyone changes nothing for an agent that already
 * has a stored layer, because `config/plugin/agent.ts` pushes the floor only on the `!exists` branch.
 * Measured on the owner's own store: Sopitis carried `deny colleague *`, and `materialize`'s
 * `whollyDisabled` therefore deleted the tool from its registry — which is why the model was handed a
 * name it could not use. A test that only exercised the floor would have gone green while the
 * reported failure stayed exactly as it was.
 */
const run = <A, E>(effect: Effect.Effect<A, E, SqlClientService>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

const makeDb = EffectDrizzleSqlite.makeWithDefaults()

/** One `agent_config` row, shaped exactly as the live store holds it. */
const store = Effect.gen(function* () {
  const db = yield* makeDb
  yield* db.run(sql`CREATE TABLE agent_config (name text PRIMARY KEY, layers text NOT NULL, time_created integer NOT NULL DEFAULT 0)`)
  return db
})

const put = (layers: unknown) => JSON.stringify([layers])

/**
 * The rules a stored layer carries. Takes the JSON rather than the client on purpose: annotating a
 * drizzle handle in this `effect` build means naming a success type the module does not export, and a
 * helper that cannot be typed is a helper that gets an `any` instead.
 */
const rulesIn = (layers: string) =>
  (JSON.parse(layers) as { permissions?: { action: string; effect: string; resource: string }[] }[]).flatMap(
    (layer) => layer.permissions ?? [],
  )

const rulesOf = (db: { all: (q: never) => unknown }, name: string) =>
  Effect.gen(function* () {
    const row = yield* (db as { all: (q: unknown) => Effect.Effect<Array<{ layers: string }>, unknown, never> }).all(
      sql`SELECT layers FROM agent_config WHERE name = ${name}`,
    )
    return rulesIn(row[0]!.layers)
  })

describe("a stored `colleague` rule is not a dial", () => {
  test("🔴 a stored DENY is removed — this is the one that withheld the tool from Sopitis", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* store
        yield* db.run(
          sql`INSERT INTO agent_config (name, layers) VALUES ('sopitis', ${put({
            permissions: [
              { action: "read", resource: "*", effect: "allow" },
              { action: "plan_enter", resource: "*", effect: "deny" },
              { action: "colleague", resource: "*", effect: "deny" },
            ],
          })})`,
        )
        yield* DatabaseMigration.applyOnly(db, [retireColleague])
        const left = yield* rulesOf(db, "sopitis")
        expect(left.map((rule) => rule.action), "the deny survived").not.toContain("colleague")
        // Everything else is untouched, which is the part a careless `json_remove` gets wrong: a
        // `deny` the operator may have wanted, and the grants that make the agent able to work.
        expect(left).toContainEqual({ action: "read", resource: "*", effect: "allow" })
        expect(left).toContainEqual({ action: "plan_enter", resource: "*", effect: "deny" })
        expect(left).toHaveLength(2)
      }),
    )
  })

  test("a redundant stored ALLOW goes too — the floor is the single source", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* store
        yield* db.run(
          sql`INSERT INTO agent_config (name, layers) VALUES ('geryon', ${put({
            permissions: [
              { action: "read", resource: "*", effect: "allow" },
              { action: "colleague", resource: "*", effect: "allow" },
            ],
          })})`,
        )
        yield* DatabaseMigration.applyOnly(db, [retireColleague])
        const left = yield* rulesOf(db, "geryon")
        expect(left.map((rule) => rule.action)).not.toContain("colleague")
        expect(left).toHaveLength(1)
      }),
    )
  })

  test("a layer with NO permissions array survives — the common shape, and json_each raises on it", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* store
        // The seed writes a bare layer for a colleague that inherits everything, so this is the
        // common case and not a defensive one. `json_each` on a missing key ERRORS rather than
        // yielding nothing, which is what the `json_type(...) = 'array'` guard in the migration is for.
        yield* db.run(
          sql`INSERT INTO agent_config (name, layers) VALUES ('myron', ${put({ shortChat: true })})`,
        )
        yield* db.run(
          sql`INSERT INTO agent_config (name, layers) VALUES ('nova', ${put({})})`,
        )
        yield* DatabaseMigration.applyOnly(db, [retireColleague])
        for (const name of ["myron", "nova"]) {
          const row = yield* db.all<{ layers: string }>(
            sql`SELECT layers FROM agent_config WHERE name = ${name}`,
          )
          expect(row, `${name} lost its row`).toHaveLength(1)
          expect(JSON.parse(row[0]!.layers), `${name} layer was mangled`).toEqual(
            JSON.parse(JSON.stringify([name === "myron" ? { shortChat: true } : {}])),
          )
        }
      }),
    )
  })

  test("it is IDEMPOTENT — a second run is a no-op, not a second rewrite", async () => {
    await run(
      Effect.gen(function* () {
        const db = yield* store
        yield* db.run(
          sql`INSERT INTO agent_config (name, layers) VALUES ('sopitis', ${put({
            permissions: [
              { action: "read", resource: "*", effect: "allow" },
              { action: "colleague", resource: "*", effect: "deny" },
            ],
          })})`,
        )
        yield* DatabaseMigration.applyOnly(db, [retireColleague])
        const first = yield* db.all<{ layers: string }>(sql`SELECT layers FROM agent_config`)
        yield* DatabaseMigration.applyOnly(db, [retireColleague])
        expect(yield* db.all<{ layers: string }>(sql`SELECT layers FROM agent_config`)).toEqual(first)
      }),
    )
  })

  test("🔴 and the floor really does grant it to a non-officer — the half the migration depends on", () => {
    // The migration removes a stored rule; the floor is what puts the capability back. Asserting them
    // together is the point: either alone leaves an agent unable to address a peer, and a test of
    // only one of them would have passed while the reported failure persisted.
    const floor = AgentPlugin.floor({ scratchDirs: [], officer: false })
    expect(PermissionV2.evaluate("colleague", "*", floor).effect).toBe("allow")
  })
})
