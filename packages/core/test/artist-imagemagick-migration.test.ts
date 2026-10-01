import { expect, test } from "bun:test"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@novaclaw/effect-drizzle-sqlite"
import { sql } from "drizzle-orm"
import { Effect } from "effect"
import migration from "@novaclaw/core/database/migration/20261001120000_artist_imagemagick_job"

const migrateArtist = (system: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run("CREATE TABLE agent_config (name TEXT PRIMARY KEY, layers TEXT NOT NULL)")
      yield* db.run(sql`INSERT INTO agent_config (name, layers) VALUES ('myron', ${JSON.stringify([{ system }])})`)
      yield* db.transaction((tx) => migration.up(tx))
      yield* db.transaction((tx) => migration.up(tx))
      const rows = yield* db.all<{ layers: string }>("SELECT layers FROM agent_config WHERE name = 'myron'")
      return JSON.parse(rows[0]!.layers)[0].system as string
    }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
  )

test("an existing default artist gains the hint in Job Instructions without rewriting a customized artist", async () => {
  const oldBrief =
    "You work in images: composition, colour, type and layout. Ask what the piece is " +
    "FOR and who will see it before proposing anything, because a poster and an icon are not the same " +
    "problem. Offer two or three distinct directions rather than one, and say what each is trading " +
    "away. Describe what you make in words as well as making it, so somebody can judge it without " +
    "having your eye."
  const artist = await migrateArtist(oldBrief)
  const custom = await migrateArtist("Paint in oils.")
  expect(artist).toContain("Use ImageMagick for basic graphics work.")
  expect(artist.match(/Use ImageMagick for basic graphics work\./g)).toHaveLength(1)
  expect(custom).toBe("Paint in oils.")
})
