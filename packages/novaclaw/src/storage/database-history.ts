export * as DatabaseHistory from "./database-history"

import { and, eq, inArray, sql } from "drizzle-orm"
import { Duration, Effect, Layer } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { EventTable } from "@novaclaw/core/event/sql"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { DEFAULT_DATABASE_MIB, DEFAULT_PRUNE_HOURS } from "@novaclaw/core/config/storage"
import { makeGlobalNode } from "@novaclaw/core/effect/app-node"
import { Log } from "@novaclaw/schema/log"

type Db = Database.Interface["db"]

const databaseBytes = (db: Db) => Effect.gen(function* () {
  const pages = (yield* db.all(sql`PRAGMA page_count`).pipe(Effect.orDie)) as { page_count: number }[]
  const size = (yield* db.all(sql`PRAGMA page_size`).pipe(Effect.orDie)) as { page_size: number }[]
  return (pages[0]?.page_count ?? 0) * (size[0]?.page_size ?? 4096)
})

export const prune = (db: Db, maxDatabaseMiB: number) => Effect.gen(function* () {
  const rows = yield* db.select({ id: EventTable.id, aggregate: EventTable.aggregate_id, seq: EventTable.seq })
    .from(EventTable)
    .where(and(eq(EventTable.type, "session.updated.2"), sql`json_type(${EventTable.data}, '$.info.summary.diffs') IS NOT NULL`))
    .orderBy(EventTable.aggregate_id, EventTable.seq)
    .all()
    .pipe(Effect.orDie)
  const latest = new Map<string, number>()
  for (const row of rows) latest.set(row.aggregate, row.seq)
  const obsolete = rows.filter((row) => row.seq !== latest.get(row.aggregate))
  for (let offset = 0; offset < obsolete.length; offset += 64) {
    const batch = obsolete.slice(offset, offset + 64).map((row) => row.id)
    yield* db.update(EventTable)
      .set({ data: sql`json_remove(${EventTable.data}, '$.info.summary.diffs')` })
      .where(inArray(EventTable.id, batch))
      .run()
      .pipe(Effect.orDie)
    yield* db.run("PRAGMA wal_checkpoint(TRUNCATE)").pipe(Effect.catchCause(() => Effect.void))
  }
  const before = yield* databaseBytes(db)
  const free = (yield* db.all(sql`PRAGMA freelist_count`).pipe(Effect.orDie)) as { freelist_count: number }[]
  const pageSize = (yield* db.all(sql`PRAGMA page_size`).pipe(Effect.orDie)) as { page_size: number }[]
  const reclaimable = (free[0]?.freelist_count ?? 0) * (pageSize[0]?.page_size ?? 4096)
  if (before > maxDatabaseMiB * 1024 * 1024 && reclaimable > before / 10) {
    yield* db.run("PRAGMA wal_checkpoint(TRUNCATE)").pipe(Effect.orDie)
    yield* db.run("VACUUM").pipe(Effect.orDie)
  }
  return { prunedEvents: obsolete.length, beforeBytes: before, afterBytes: yield* databaseBytes(db) }
})

const configured = (value: unknown) => {
  if (!value || typeof value !== "object") return { maxDatabaseMiB: DEFAULT_DATABASE_MIB, pruneHours: DEFAULT_PRUNE_HOURS }
  const config = value as { max_database_mib?: unknown; prune_interval_hours?: unknown }
  return {
    maxDatabaseMiB: typeof config.max_database_mib === "number" ? config.max_database_mib : DEFAULT_DATABASE_MIB,
    pruneHours: typeof config.prune_interval_hours === "number" ? config.prune_interval_hours : DEFAULT_PRUNE_HOURS,
  }
}

export const layer = Layer.effectDiscard(Effect.gen(function* () {
  const { db } = yield* Database.Service
  const settings = yield* SettingsConfigStore.Service
  let lastRun = 0
  const tick = Effect.gen(function* () {
    const values = yield* settings.all()
    const { maxDatabaseMiB, pruneHours } = configured(values.storage)
    const now = Date.now()
    const bytes = yield* databaseBytes(db)
    if (now - lastRun >= pruneHours * 60 * 60 * 1000 || bytes > maxDatabaseMiB * 1024 * 1024) {
      const succeeded = yield* prune(db, maxDatabaseMiB).pipe(
        Effect.as(true),
        Effect.catchCause((cause) => Log.event("instance.database.history.failed", {
          "instance.database.phase": "prune",
          "instance.cause": Log.fault(cause),
        }).pipe(Effect.as(false))),
      )
      if (succeeded) lastRun = Date.now()
    }
  }).pipe(Effect.catchCause((cause) => Log.event("instance.database.history.failed", {
    "instance.database.phase": "check",
    "instance.cause": Log.fault(cause),
  })))
  yield* Effect.forkScoped(Effect.forever(Effect.gen(function* () {
    yield* tick
    yield* Effect.sleep(Duration.minutes(15))
  })))
}))

export const node = makeGlobalNode({ name: "database-history", layer, deps: [Database.node, SettingsConfigStore.node] })
