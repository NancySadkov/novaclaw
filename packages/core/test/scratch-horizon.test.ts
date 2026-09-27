import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { EffectDrizzleSqlite } from "@novaclaw/effect-drizzle-sqlite"
import { DAY_MS } from "@novaclaw/schema/scratch-horizon"
import { ConfigAgent } from "@novaclaw/core/config/agent"
import type { Database } from "@novaclaw/core/database/database"
import { DatabaseMigration } from "@novaclaw/core/database/migration"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionTable } from "@novaclaw/core/session/sql"
import { ScratchHorizon } from "@novaclaw/core/scratch/horizon"
import { ScratchHorizonTable } from "@novaclaw/core/scratch/horizon.sql"
import { ScratchTrash } from "@novaclaw/core/scratch/trash"
import { tmpdir } from "./fixture/tmpdir"

const born = Date.UTC(2026, 0, 1)
const sessionID = SessionSchema.ID.make("ses_iris")
const config = (value: Record<string, unknown> = {}) => Schema.decodeUnknownSync(ConfigAgent.Info)(value)
type Db = Database.Interface["db"]

const file = async (folder: string, name: string, modified: number) => {
  const target = path.join(folder, name)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, name)
  await fs.utimes(target, modified / 1_000, modified / 1_000)
  return target
}

const fixture = async <A>(run: (db: Db, folder: string) => Effect.Effect<A, unknown>) => {
  await using temporary = await tmpdir()
  const prior = process.env.NOVACLAW_SCRATCH_ROOT
  process.env.NOVACLAW_SCRATCH_ROOT = temporary.path
  const folder = path.join(temporary.path, "iris")
  await fs.mkdir(folder)
  try {
    return await Effect.runPromise(
      Effect.gen(function* () {
        const db = yield* EffectDrizzleSqlite.makeWithDefaults()
        yield* db.run("PRAGMA foreign_keys = ON")
        yield* DatabaseMigration.apply(db)
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            agent: "iris",
            slug: "iris",
            title: "Iris",
            directory: folder,
            version: "test",
            time_created: born,
            time_updated: born,
          })
          .run()
        return yield* run(db, folder)
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ":memory:", disableWAL: true })), Effect.scoped),
    )
  } finally {
    if (prior === undefined) delete process.env.NOVACLAW_SCRATCH_ROOT
    else process.env.NOVACLAW_SCRATCH_ROOT = prior
  }
}

describe("officer scratch horizon", () => {
  test("three-day cycles warn first, recheck touched files, and only delete the preceding list", async () => {
    await fixture((db, folder) =>
      Effect.gen(function* () {
        const stale = yield* Effect.promise(() => file(folder, "tmp/old-context.txt", born - 1))
        const kept = yield* Effect.promise(() => file(folder, "important notes.txt", born - 1))
        const later = yield* Effect.promise(() => file(folder, "new.txt", born + DAY_MS))
        const trash = (yield* Effect.promise(() => ScratchTrash.open(folder)))!
        yield* Effect.promise(() => trash.write([stale]))
        const notices: ScratchHorizon.Notice[] = []
        const deliver: ScratchHorizon.Deliver = (notice) =>
          Effect.sync(() => {
            notices.push(notice)
          })
        const tick = (day: number) => ScratchHorizon.sweep(db, { iris: [config()] }, deliver, born + day * DAY_MS)
        expect(yield* tick(2)).toBe(0)
        expect(yield* tick(3)).toBe(1)
        expect(yield* Effect.promise(() => Bun.file(stale).exists())).toBe(true)
        expect(yield* Effect.promise(() => trash.read())).toEqual([kept, stale].sort())
        expect(notices).toHaveLength(1)
        expect(notices[0]).toMatchObject({ agent: "iris", sessionID, sessionEpoch: born })
        expect(notices[0]!.text).toContain(`"${trash.list}" lists files older than 3 days`)
        yield* Effect.promise(() => fs.utimes(kept, (born + 4 * DAY_MS) / 1_000, (born + 4 * DAY_MS) / 1_000))
        expect(yield* tick(5)).toBe(0)
        expect(yield* tick(6)).toBe(1)
        expect(yield* Effect.promise(() => Bun.file(stale).exists())).toBe(false)
        expect(yield* Effect.promise(() => Bun.file(kept).exists())).toBe(true)
        expect(yield* Effect.promise(() => Bun.file(later).exists())).toBe(true)
        expect(yield* Effect.promise(() => trash.read())).toEqual([later])
        expect(notices).toHaveLength(2)
      }),
    )
  })

  test("removing trash-list preserves its files and produces a fresh review list", async () => {
    await fixture((db, folder) =>
      Effect.gen(function* () {
        const stale = yield* Effect.promise(() => file(folder, "keep.txt", born - 1))
        const tick = (day: number) =>
          ScratchHorizon.sweep(db, { iris: [config()] }, () => Effect.void, born + day * DAY_MS)
        yield* tick(3)
        yield* Effect.promise(() => fs.unlink(path.join(folder, ScratchTrash.LIST_NAME)))
        yield* tick(6)
        expect(yield* Effect.promise(() => Bun.file(stale).exists())).toBe(true)
        expect(yield* Effect.promise(() => fs.readFile(path.join(folder, ScratchTrash.LIST_NAME), "utf8"))).toBe(
          stale + "\n",
        )
      }),
    )
  })

  test("failed notification retries the same cycle and starts the grace period after admission", async () => {
    await fixture((db, folder) =>
      Effect.gen(function* () {
        const stale = yield* Effect.promise(() => file(folder, "work.txt", born - 1))
        const notices: ScratchHorizon.Notice[] = []
        let offline = true
        const deliver: ScratchHorizon.Deliver = (notice) =>
          Effect.suspend(() => {
            notices.push(notice)
            return offline ? Effect.fail("delivery unavailable") : Effect.void
          })
        const tick = (day: number) => ScratchHorizon.sweep(db, { iris: [config()] }, deliver, born + day * DAY_MS)
        expect(yield* tick(3)).toBe(0)
        expect(yield* tick(9)).toBe(0)
        expect(yield* Effect.promise(() => Bun.file(stale).exists())).toBe(true)
        offline = false
        expect(yield* tick(10)).toBe(1)
        expect(new Set(notices.map((notice) => notice.cycleAt)).size).toBe(1)
        expect(yield* tick(12)).toBe(0)
        expect(yield* tick(13)).toBe(1)
        expect(yield* Effect.promise(() => Bun.file(stale).exists())).toBe(false)
      }),
    )
  })

  test("an interrupted scan never consumes a replacement list, even after a long outage", async () => {
    await fixture((db, folder) =>
      Effect.gen(function* () {
        const stale = yield* Effect.promise(() => file(folder, "work.txt", born - 1))
        yield* db
          .insert(ScratchHorizonTable)
          .values({
            agent: "iris",
            session_id: sessionID,
            cycle_at: born + 3 * DAY_MS,
            horizon_days: 3,
            phase: "scan",
          })
          .run()
        const trash = (yield* Effect.promise(() => ScratchTrash.open(folder)))!
        yield* Effect.promise(() => trash.write([stale]))
        expect(yield* ScratchHorizon.sweep(db, { iris: [config()] }, () => Effect.void, born + 20 * DAY_MS)).toBe(1)
        expect(yield* Effect.promise(() => Bun.file(stale).exists())).toBe(true)
        const [state] = yield* db.select().from(ScratchHorizonTable).all()
        expect(state).toMatchObject({ phase: "idle", completed_at: born + 20 * DAY_MS })
      }),
    )
  })

  test("changing the horizon gives a fresh warning and grace period; empty scans stay quiet", async () => {
    await fixture((db, folder) =>
      Effect.gen(function* () {
        const stale = yield* Effect.promise(() => file(folder, "keep.txt", born - 1))
        let calls = 0
        const deliver = () =>
          Effect.sync(() => {
            calls++
          })
        expect(
          yield* ScratchHorizon.sweep(db, { iris: [config({ horizonDays: 7 })] }, deliver, born + 3 * DAY_MS),
        ).toBe(0)
        expect(
          yield* ScratchHorizon.sweep(
            db,
            { iris: [config({ horizonDays: 7 }), config({ horizonDays: 2 })] },
            deliver,
            born + 3 * DAY_MS,
          ),
        ).toBe(1)
        expect(
          yield* ScratchHorizon.sweep(db, { iris: [config({ horizonDays: 2 })] }, deliver, born + 4 * DAY_MS),
        ).toBe(0)
        expect(
          yield* ScratchHorizon.sweep(db, { iris: [config({ horizonDays: 1 })] }, deliver, born + 4 * DAY_MS),
        ).toBe(1)
        expect(yield* Effect.promise(() => Bun.file(stale).exists())).toBe(true)
        expect(calls).toBe(2)
        expect(
          yield* ScratchHorizon.sweep(db, { iris: [config({ horizonDays: 1 })] }, deliver, born + 5 * DAY_MS),
        ).toBe(1)
        expect(yield* Effect.promise(() => Bun.file(stale).exists())).toBe(false)
        expect(calls).toBe(2)
      }),
    )
  })

  test("chat, human, disabled, worker and archived sessions are never cleaned or awakened", async () => {
    await fixture((db, folder) =>
      Effect.gen(function* () {
        const stale = yield* Effect.promise(() => file(folder, "work.txt", born - 1))
        const deliver = () => Effect.die("must not deliver")
        for (const value of [
          { kind: "chat" },
          { shortChat: true },
          { kind: "human" },
          { disabled: true },
          { mode: "subagent" },
        ])
          expect(yield* ScratchHorizon.sweep(db, { iris: [config(value)] }, deliver, born + 4 * DAY_MS)).toBe(0)
        yield* db
          .update(SessionTable)
          .set({ parent_id: SessionSchema.ID.make("ses_parent") })
          .where(eq(SessionTable.id, sessionID))
          .run()
        expect(yield* ScratchHorizon.sweep(db, { iris: [config()] }, deliver, born + 4 * DAY_MS)).toBe(0)
        yield* db
          .update(SessionTable)
          .set({ parent_id: null, time_archived: born + DAY_MS })
          .where(eq(SessionTable.id, sessionID))
          .run()
        expect(yield* ScratchHorizon.sweep(db, { iris: [config()] }, deliver, born + 4 * DAY_MS)).toBe(0)
        expect(yield* Effect.promise(() => Bun.file(stale).exists())).toBe(true)
      }),
    )
  })

  test("overlapping ticks serialize and clearing a chat cascades the timer state", async () => {
    await fixture((db, folder) =>
      Effect.gen(function* () {
        yield* Effect.promise(() => file(folder, "old.txt", born - 1))
        let calls = 0
        const tick = ScratchHorizon.sweep(
          db,
          { iris: [config()] },
          () =>
            Effect.sync(() => {
              calls++
            }),
          born + 3 * DAY_MS,
        )
        const results = yield* Effect.all([tick, tick], { concurrency: 2 })
        expect(results.sort()).toEqual([0, 1])
        expect(calls).toBe(1)
        yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run()
        expect(yield* db.select().from(ScratchHorizonTable).all()).toEqual([])
      }),
    )
  })

  test("the setting accepts positive whole days only", () => {
    for (const horizonDays of [0, -1, 1.5, Infinity, NaN, "3"]) expect(() => config({ horizonDays })).toThrow()
    expect(config({ horizonDays: 14 }).horizonDays).toBe(14)
  })
})
