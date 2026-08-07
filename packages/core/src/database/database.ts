export * as Database from "./database"

import { EffectDrizzleSqlite } from "@novaclaw/effect-drizzle-sqlite"
import { Log } from "@novaclaw/schema/log"
import { sql } from "drizzle-orm"
import { layer as sqliteLayer } from "#sqlite"
import { Cause, Context, Data, Duration, Effect, Layer, Option, Schedule } from "effect"
import { DatabasePath } from "./db-path"
import { DatabaseMigration } from "./migration"
import { migrations } from "./migration.gen"
import { Global } from "../global"
import { makeGlobalNode } from "../effect/app-node"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type DatabaseShape = Effect.Success<typeof makeDatabase>

export interface Interface {
  db: DatabaseShape
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/storage/Database") {}

// ────────────────────────────────────────────────────────────────────────────────────────────────
// THE RULING: the database REFUSES; it never quarantines and it never boots half-working.
// ────────────────────────────────────────────────────────────────────────────────────────────────
//
// This module was the fourth unconditional boot-killer in
// `notes/reports/startup-classification-2026-08-07.md` §4.1: the whole build — six PRAGMAs plus
// `DatabaseMigration.apply` — was piped through one `Effect.orDie`, so every possible database fault
// arrived as an anonymous defect and the instance died without saying why. Its three siblings
// (`RuntimeFlags`, `Observability`, `Global`, app `40223f295`) each degraded IN PLACE, because a
// defaulted flag and a lost log line cost the user nothing.
//
// **A database is not that shape, and the difference is the whole decision.** Coming up
// "successfully" on an unusable or half-migrated store is WORSE than refusing, because the user then
// acts on an instance that looks healthy and writes into a store the code disagrees with. That is
// ruling 2's *quarantine is scarier than a hard fail* case, and `Global`'s own fix hit the same
// reasoning the same day when it decided a broken `<data>/log` must degrade in place rather than
// relocate — relocating would have orphaned the real sessions database in a temp directory.
//
// So this fix changes almost no behaviour and all of the legibility: **the boot still stops, but the
// stop is now classified, named, and repairable.** Concretely, four faults are separated, because
// they have four different repairs and describing one as another is ruling 2 broken
// (*a fault is never described falsely*):
//
//   · the file is MISSING          — a first run. Not a fault at all; it is created. The most
//                                    important arm, and the one the adversarial pass caught an
//                                    earlier draft of this decision about to get wrong: an
//                                    undifferentiated quarantine would have renamed aside every
//                                    healthy user database the moment a regenerated migration landed.
//   · the file cannot be OPENED    — EACCES/EPERM/EROFS, a directory in the way, another process.
//                                    The bytes are presumed intact; the environment is the fault.
//   · the file is CORRUPT          — SQLITE_NOTADB / a malformed image. The bytes are the fault.
//   · the file is FOREIGN          — a real SQLite database that is not one of ours (tables, but no
//                                    `session`). Someone else's file living at our path.
//   · a MIGRATION fails on a structurally valid database — *our* bug against *their* healthy data.
//
// ── why NOT quarantine, argued rather than deferred ─────────────────────────────────────────────
//
// `notes/reports/decisions-v0.2.0.md` §2 ruled that a corrupt/foreign database quarantines to
// `<name>.damaged-<ts>.db` and boots degraded — and priced it: *"quarantine-and-boot-degraded is
// scarier than a hard fail if done sloppily — the banner must name the quarantined file's full path,
// state that nothing was deleted, and link Recovery."* Three things make the rename the strictly
// worse option **today**, and none of them is "it is hard":
//
//   1. **The banner and Recovery do not exist.** Shipping the rename without them is a destructive-
//      LOOKING mutation the user is never told about — the same "claims a safety win that is not
//      real" that ruling 2 names. The rename is the half that cannot ship alone.
//   2. **A degraded boot cannot host the agent that would repair it.** Settings, the provider catalog
//      and every model entry live in THIS database (*Settings in SQLite*, ruling 10). An instance
//      booted without it has no models, so *"ask an agent to fix it"* is unreachable from inside it
//      either way — and it would render the empty Settings/Sessions screens ruling 2 forbids. The
//      quarantine buys legibility only, and a named refusal buys the same legibility without
//      touching a byte.
//   3. **Refusing preserves every repair option; renaming forecloses one.** Each migration runs in
//      its own transaction, so a failed upgrade leaves the database at the last COMPLETED migration —
//      a consistent, older shape that the previous NovaClaw version still opens. Refusing keeps
//      "install the previous version, keep your chats" available. Quarantine destroys it and boots
//      the user into an empty instance, which reads as *NovaClaw ate my data*.
//
// So: **nothing on this path renames, moves, deletes or truncates anything.** That is asserted by
// `test/database-refuses.test.ts`, not merely promised here.
//
// ── and the self-healing law, honestly ──────────────────────────────────────────────────────────
//
// *"If this breaks while the vendor is asleep, can an agent inside the OS repair it?"* — no, and no
// design can make it yes, because the agent's own catalog is the thing that failed to open. What is
// achievable, and what this does, is to make the fault repairable **from outside**: one classified
// sentence naming the file, the case, and the failing migration id, on stderr (which the desktop
// forwards into its own log) AND as `event=instance.database.refused` in `novaclaw.log`. A person, or
// an agent on another instance, can act on that. Before this commit the same failure produced an
// opaque `SQLiteError` inside a defect and, on the desktop, a window that never opened at all.

/** Which of the five separated faults this is. Each has a different repair; see `repairsFor`. */
export type FaultKind =
  /** The file could not be opened: permissions, a directory in the way, a locked or read-only volume. */
  | "unreadable"
  /** The file opened but is not a well-formed SQLite image. */
  | "corrupt"
  /** A real SQLite database that is not one of ours — tables, but no `session`. */
  | "foreign"
  /** A structurally valid NovaClaw database whose schema upgrade failed. Our bug, their data. */
  | "migration"
  /** Nothing above matched. Named as unknown rather than guessed — ruling 2. */
  | "unknown"

/**
 * **One named database fault, as a VALUE.**
 *
 * `summary` is the single sentence a non-developer sees; `detail` is the pretty-printed cause and
 * belongs in the log. `repair` is the part that makes this more than an error message: it is what a
 * person — or an agent reading the log from another instance — can actually do.
 */
export interface Fault {
  readonly kind: FaultKind
  /** The database file, in full. Always absolute (or `:memory:`), never abbreviated. */
  readonly path: string
  readonly summary: string
  readonly repair: readonly string[]
  readonly detail: string
  /** `migration` only: the first migration that had NOT been recorded complete when it failed. */
  readonly migration?: string
  /** `foreign` only: the table names actually found, so the reader can recognise their own file. */
  readonly tables?: readonly string[]
}

/**
 * The refusal, as a defect payload. It carries the whole `Fault`, so a caller that catches the cause
 * (the desktop's `describeSidecarFailure` shape, a future Recovery surface) gets the classification
 * rather than a re-parse of an English sentence.
 */
export class Unusable extends Data.TaggedError("DatabaseUnusable")<{
  readonly fault: Fault
  readonly message: string
}> {}

// SQLite's own error text, which both drivers surface verbatim (`bun:sqlite` as `SQLiteError`,
// `node:sqlite` as `ERR_SQLITE_ERROR`). Matching the message rather than a driver-specific code is
// what keeps one classifier correct under both halves of the `#sqlite` import map.
// ⚠️ Measured under bun on win32 (see the test); the node leg is reasoned, not exercised.
const CORRUPT =
  /file is not a database|not a database file|disk image is malformed|file is encrypted|SQLITE_NOTADB|SQLITE_CORRUPT/i
const UNREADABLE =
  /unable to open database file|SQLITE_CANTOPEN|EACCES|EPERM|EROFS|EBUSY|ENOENT|ENOTDIR|EISDIR|database is locked|SQLITE_BUSY|readonly database|SQLITE_READONLY|disk I\/O error|SQLITE_IOERR/i

/** What a person can do about each case. Pure, and exercised directly. */
export const repairsFor = (fault: Omit<Fault, "repair" | "summary">): readonly string[] => {
  switch (fault.kind) {
    case "unreadable":
      return [
        "Close any other NovaClaw that may be using this file, then start it again.",
        `Check that your account can read and write ${fault.path} and the folder it is in.`,
        "Point NovaClaw somewhere else with --home <dir> (or NOVACLAW_HOME), or NOVACLAW_DB=<file>.",
      ]
    case "corrupt":
      return [
        "Restore this file from a backup if you have one — it was NOT modified, moved or deleted.",
        `If you have no backup, move ${fault.path} aside yourself and start NovaClaw again; it will create a new, empty database. Doing that loses the chats and settings in the old file, which is why NovaClaw will not do it for you.`,
        "Point NovaClaw somewhere else with --home <dir> (or NOVACLAW_HOME) to keep this file untouched.",
      ]
    case "foreign":
      return [
        `${fault.path} is a database, but not one of NovaClaw's. Nothing was changed.`,
        "If this file is yours, move it somewhere else — NovaClaw will create its own database here.",
        "If NovaClaw is pointed at the wrong place, fix --home <dir> (or NOVACLAW_HOME / NOVACLAW_DB).",
      ]
    case "migration":
      return [
        "This is a fault in this version of NovaClaw, not in your data. Your database was NOT modified — every schema step runs in its own transaction, so it is still exactly as the last working version left it.",
        "Install the NovaClaw version you were running before; it will open this database as it always did.",
        `Report this with the line above${fault.migration === undefined ? "" : `, including migration ${fault.migration}`}.`,
      ]
    case "unknown":
      return [
        `NovaClaw could not tell what is wrong with ${fault.path}, and stopped rather than guess. It was NOT modified.`,
        "The `detail` line above is the raw fault — report it.",
        "Point NovaClaw somewhere else with --home <dir> (or NOVACLAW_HOME) to keep this file untouched.",
      ]
  }
}

/**
 * The one sentence a person reads. Pure, and exercised directly — the five must not collapse into
 * one wording, which is exactly how the desktop's own `describeSidecarFailure` broke ruling 2 the
 * same day (app `738233284`): one sentence covering two faults sends the reader to the wrong
 * subsystem, and a fault described vaguely is better than a fault described falsely.
 */
export const summaryFor = (kind: FaultKind, file: string, migration?: string): string => {
  switch (kind) {
    case "unreadable":
      return `NovaClaw could not open its database file (${file}).`
    case "corrupt":
      return `NovaClaw's database file is damaged and could not be read (${file}).`
    case "foreign":
      return `The file at ${file} is a database, but it is not NovaClaw's.`
    case "migration":
      return migration === undefined
        ? `NovaClaw could not create the tables in its database (${file}).`
        : `NovaClaw could not upgrade its database to this version (${file}); it stopped at migration ${migration}.`
    case "unknown":
      return `NovaClaw could not use its database file (${file}).`
  }
}

/** Assemble a fault from its kind and evidence. One place, so `summary`/`repair` cannot drift apart. */
const faultOf = (
  kind: FaultKind,
  file: string,
  detail: string,
  extra: { readonly migration?: string; readonly tables?: readonly string[] } = {},
): Fault => {
  const partial = { kind, path: file, detail, ...extra }
  return { ...partial, summary: summaryFor(kind, file, extra.migration), repair: repairsFor(partial) }
}

/**
 * Classify a failure that happened while OPENING the file — the sqlite driver's own throw, before
 * any of our SQL ran. Pure over the cause's text, so the test can drive every arm.
 *
 * ⚠️ `Cause.pretty`, not `Cause.squash().message`: the open failures arrive as DEFECTS (they are raw
 * throws inside `Layer.effect`), and squashing a defect-only cause does not reliably yield the
 * original `Error`. The text is the evidence either way.
 */
export const classifyOpenFailure = (file: string, cause: Cause.Cause<unknown>): Fault => {
  const detail = Cause.pretty(cause)
  if (CORRUPT.test(detail)) return faultOf("corrupt", file, detail)
  if (UNREADABLE.test(detail)) return faultOf("unreadable", file, detail)
  return faultOf("unknown", file, detail)
}

/**
 * Classify a failure that happened while MIGRATING — i.e. with a live connection still in hand.
 *
 * This is where the differentiation that ruling 2's adversary insisted on actually happens, and it
 * is decided from the database's own `sqlite_master`, **never from the error message**. The foreign
 * case is `DatabaseMigration.apply`'s `Effect.die("Database is not empty and has no session table")`
 * — matching that sentence would make this classifier a hostage to a string literal in another
 * module, so it asks the file instead.
 *
 * ⚠️ The pending migration id is DERIVED, not caught: every migration runs inside its own
 * transaction, so a failed `up` never records its id. The first declared migration missing from the
 * `migration` table is therefore the one that failed. When that table does not exist at all, the
 * initial schema creation is what failed and no id is claimed — a guessed id would be ruling 2's
 * *described falsely*, which is worse than saying nothing.
 */
const describeMigrationFailure = (db: DatabaseShape, file: string, cause: Cause.Cause<unknown>) =>
  Effect.gen(function* () {
    const detail = Cause.pretty(cause)
    const tables = yield* db
      .all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .pipe(Effect.catchCause(() => Effect.succeed(undefined)))

    // The connection itself is gone — that is an open-class fault, not a migration one.
    if (tables === undefined) return classifyOpenFailure(file, cause)

    const names = tables.map((table) => table.name)
    if (names.length > 0 && !names.includes("session"))
      return faultOf("foreign", file, detail, { tables: names.slice().sort() })

    if (!names.includes("migration")) return faultOf("migration", file, detail)

    const completed = yield* db
      .all<{ id: string }>(sql`SELECT id FROM ${sql.identifier("migration")}`)
      .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
    if (completed === undefined) return faultOf("migration", file, detail)

    const done = new Set(completed.map((row) => row.id))
    const pending = migrations.find((migration) => !done.has(migration.id))
    return faultOf("migration", file, detail, pending === undefined ? {} : { migration: pending.id })
  })

/**
 * **What the user sees.** Plain text on stderr, deliberately not a stack trace.
 *
 * Pure, so the test asserts the CONTENT rather than that something was written. Two properties are
 * load-bearing: the full path appears (a fault the reader cannot locate is not named), and the words
 * *nothing was moved, renamed or deleted* appear, because the single most damaging misreading of a
 * refusing database is that it ate your chats.
 */
export const report = (fault: Fault): string => {
  const lines = [
    `[novaclaw] ${fault.summary}`,
    `[novaclaw] NovaClaw stopped instead of starting up without it — an instance that looks healthy on a`,
    `[novaclaw] database it cannot use would write into a broken store.`,
    `[novaclaw]`,
    `[novaclaw]   database: ${fault.path}`,
    `[novaclaw]   fault:    ${fault.kind}`,
    ...(fault.migration === undefined ? [] : [`[novaclaw]   migration: ${fault.migration}`]),
    ...(fault.tables === undefined ? [] : [`[novaclaw]   tables:   ${fault.tables.join(", ")}`]),
    `[novaclaw]`,
    `[novaclaw] Nothing was moved, renamed or deleted. Your data is exactly where it was.`,
    `[novaclaw]`,
    `[novaclaw] What repairs this:`,
    ...fault.repair.map((line) => `[novaclaw]   - ${line}`),
    `[novaclaw]`,
    `[novaclaw] detail: ${fault.detail.split("\n")[0] ?? ""}`,
  ]
  return lines.join("\n") + "\n"
}

/**
 * Report the fault everywhere it can be read, then stop.
 *
 * Two sinks on purpose, and this is NOT the "second log file" defect `schema/log-events.ts` warns
 * about: `Log.event` is the instance's own record (`novaclaw.log`, greppable as
 * `event=instance.database.refused`), and stderr is the only channel that survives when the boot has
 * not got as far as a working logger — it is also the one the desktop main process forwards into its
 * own log (`desktop/src/main/index.ts` → `onStderr`), so it is what a user with no terminal sees.
 * `Global` set the same precedent for the same reason.
 */
const refuse = (fault: Fault): Effect.Effect<never> =>
  Effect.gen(function* () {
    yield* Log.event("instance.database.refused", {
      "instance.database": fault.path,
      "instance.database.kind": fault.kind,
      "instance.database.migration": fault.migration ?? "none",
      "instance.cause": fault.detail,
    })
    yield* Effect.sync(() => process.stderr.write(report(fault)))
    return yield* Effect.die(new Unusable({ fault, message: fault.summary }))
  })

const build = (filename: string) =>
  Effect.gen(function* () {
    const db = yield* makeDatabase

    yield* db.run("PRAGMA journal_mode = WAL")
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA busy_timeout = 5000")
    yield* db.run("PRAGMA cache_size = -64000")
    yield* db.run("PRAGMA foreign_keys = ON")
    yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
    // `catchCause`, never `catch`: `DatabaseMigration.apply` reaches an `Effect.die` (the foreign-file
    // arm) and a raw driver throw, and `Effect.catch`/`Effect.ignore` do not see defects
    // (effect@4.0.0-beta.83, `Effect.catch`'s own doc: *"It will not recover from unrecoverable
    // defects."*). A seam built on `catch` would have caught NONE of the faults this module has.
    yield* DatabaseMigration.apply(db).pipe(
      Effect.catchCause((cause) =>
        Effect.flatMap(describeMigrationFailure(db, filename, cause), (fault) =>
          Effect.fail(new Unusable({ fault, message: fault.summary })),
        ),
      ),
    )

    return { db }
  })

/**
 * The fault behind a failed build, however it arrived.
 *
 * Two shapes reach here and they must not be confused: `describeMigrationFailure` already did the
 * work and failed with a typed `Unusable` (it had a live connection and could ask the file what it
 * was), while a driver throw during the open is an unclassified defect. Re-running
 * `classifyOpenFailure` over the former would relabel a migration fault as `unknown` — a fault
 * described falsely, which is the thing this whole module is for.
 */
const faultFrom = (filename: string, cause: Cause.Cause<unknown>): Fault => {
  const found = Cause.findErrorOption(cause)
  if (Option.isSome(found) && found.value instanceof Unusable) return found.value.fault
  return classifyOpenFailure(filename, cause)
}

/**
 * **The one way to obtain a `Database.Service`.** There is deliberately no second entry point and no
 * unguarded escape hatch — the pre-fix composition lives in `test/database-refuses.test.ts` as the
 * twin every arm is measured against, not here where the product could reach it.
 *
 * ⚠️ The catch is OUTSIDE `Layer.provide`, and it has to be: `Layer.provide(self, that)` builds
 * `that` first, so a `catchCause` inside `Layer.effect(Service, …)` never sees the driver's own
 * `new Database(file)` throw — which is exactly where the *corrupt* and *unreadable* cases land.
 * Measured, not assumed: with the catch on the inner layer the corrupt arm still killed the boot.
 */
export function layerFromPath(filename: string) {
  return Layer.effect(Service, build(filename)).pipe(
    Layer.provide(sqliteLayer({ filename })),
    Layer.catchCause((cause) => Layer.effect(Service, refuse(faultFrom(filename, cause)))),
  )
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
