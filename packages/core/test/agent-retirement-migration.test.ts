import { describe, expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@novaclaw/effect-drizzle-sqlite"
import { Effect } from "effect"
import retirementLedger from "../src/database/migration/20260925165054_agent_retirement_ledger"

describe("agent retirement ledger migration", () => {
  test("fences ambiguous legacy identities without fencing agents whose history starts after their config", async () => {
    const rows = await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        yield* db.run(`CREATE TABLE agent_config (name text PRIMARY KEY, layers text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL);`)
        yield* db.run(`CREATE TABLE session (id text PRIMARY KEY, agent text, time_created integer NOT NULL);`)
        yield* db.run(`CREATE TABLE session_message (id text PRIMARY KEY, type text NOT NULL, data text NOT NULL, time_created integer NOT NULL);`)
        yield* db.run(`INSERT INTO agent_config VALUES ('reused', '[]', 100, 100), ('sender_only', '[]', 100, 100), ('clean', '[]', 100, 100);`)
        yield* db.run(`INSERT INTO session VALUES ('ses_old', 'reused', 50), ('ses_clean', 'clean', 150), ('ses_retired', 'retired', 60), ('ses_nova', 'nova', 20);`)
        yield* db.run(`INSERT INTO session_message VALUES ('msg_old', 'colleague', '{"sender":"sender_only"}', 90), ('msg_retired', 'colleague', '{"sender":"retired"}', 95);`)
        yield* db.transaction((tx) => retirementLedger.up(tx))
        yield* db.run(`INSERT INTO agent_retirement (agent, retired_at) VALUES ('reused', 100), ('reused', 100);`)
        return yield* db.all<{ id: number; agent: string; retired_at: number }>(
          `SELECT id, agent, retired_at FROM agent_retirement ORDER BY id`,
        )
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
    )

    expect(rows.filter((row) => row.agent === "reused")).toHaveLength(3)
    expect(rows.some((row) => row.agent === "sender_only")).toBe(true)
    expect(rows.some((row) => row.agent === "clean")).toBe(false)
    expect(rows.find((row) => row.agent === "retired")?.retired_at).toBe(95)
    expect(rows.some((row) => row.agent === "nova")).toBe(false)
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length)
  })
})
