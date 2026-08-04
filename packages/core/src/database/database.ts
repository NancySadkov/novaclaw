export * as Database from "./database"

import { EffectDrizzleSqlite } from "@novaclaw/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { Context, Duration, Effect, Layer, Schedule } from "effect"
import { DatabasePath } from "./db-path"
import { DatabaseMigration } from "./migration"
import { Global } from "../global"
import { makeGlobalNode } from "../effect/app-node"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/storage/Database") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* makeDatabase

    yield* db.run("PRAGMA journal_mode = WAL")
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA busy_timeout = 5000")
    yield* db.run("PRAGMA cache_size = -64000")
    yield* db.run("PRAGMA foreign_keys = ON")
    yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
    yield* DatabaseMigration.apply(db)

    return { db }
  }).pipe(Effect.orDie),
)

export function layerFromPath(filename: string) {
  return layer.pipe(Layer.provide(sqliteLayer({ filename })))
}

// Moved to db-path.ts (a leaf module) so boot-time snapshot readers — the offline chokepoint —
// can resolve the file without this module's drizzle/migration import graph. Same callable here.
export const path = DatabasePath.path

export const defaultLayer = Layer.unwrap(
  Effect.gen(function* () {
    return layerFromPath(path())
  }),
).pipe(Layer.provide(Global.defaultLayer))

export const node = makeGlobalNode({ service: Service, layer: layerFromPath(path()), deps: [] })

// Periodically truncate the WAL so the `-wal` sidecar doesn't grow without bound
// during long-lived write bursts (only a PASSIVE checkpoint runs at boot otherwise).
// TRUNCATE resets the WAL file to zero once no reader needs it; it fails harmlessly
// (BUSY) if a reader is mid-checkpoint, so errors are swallowed and retried next tick.
// Its own global node so it runs only where wired (the serve), not short-lived CLI/
// test contexts — mirrors ToolOutputStore.cleanupNode.
//
// NOTE: this bounds the WAL, NOT the main DB file. Reclaiming freed pages from the
// main file (VACUUM) is deliberately NOT done here — `auto_vacuum` won't engage
// post-write without a converting VACUUM, and an unguarded full VACUUM rewrites +
// briefly locks the whole file. A guarded reclamation (freelist-gated incremental
// vacuum) is the tracked follow-up; see the SQLite-growth task.
export const maintenanceLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const { db } = yield* Service
    const checkpoint = db.run("PRAGMA wal_checkpoint(TRUNCATE)").pipe(Effect.catchCause(() => Effect.void))
    yield* checkpoint.pipe(Effect.repeat(Schedule.spaced(Duration.hours(1))), Effect.forkScoped)
  }),
)

export const maintenanceNode = makeGlobalNode({ name: "database-maintenance", layer: maintenanceLayer, deps: [node] })
