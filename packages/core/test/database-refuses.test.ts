/**
 * **The database REFUSES, by name — and it never touches the file.**
 *
 * `database.ts` was the fourth unconditional boot-killer in
 * `notes/reports/startup-classification-2026-08-07.md` §4.1: six PRAGMAs plus the whole migration
 * path under one `Effect.orDie`, so every database fault arrived as an anonymous defect. Its three
 * siblings (app `40223f295`) each degraded IN PLACE. This one cannot, and the module's header argues
 * why: booting "successfully" on an unusable or half-migrated store is worse than refusing, because
 * the user then acts on an instance that looks healthy.
 *
 * So what is under test here is not *"the boot survived"* — it deliberately does not — but the four
 * separated faults, the message a person gets, and the promise that **nothing is renamed, moved or
 * deleted**. Ruling 2, four ways: *an unavailable subsystem names itself*, and *a fault is never
 * described falsely*.
 *
 * ── why each arm carries its unguarded twin ─────────────────────────────────────────────────────
 *
 * ⚠️ Every poison below is run TWICE against the same file in the same test: once through
 * `Database.layerFromPath` (the shipped path) and once through `preFix` below, which is the module
 * as it stood before this commit — the same six PRAGMAs, the same `DatabaseMigration.apply`, and the
 * `Effect.orDie` that made all of it anonymous. *"The refusal was well-formed"* is trivially true if
 * the poison stopped biting — a permissions quirk, a Windows update, a typo in this file — and a
 * green test that cannot fail is worse than no test. The twin asserts the poison still bites.
 *
 * ⚠️ **The first draft's twin was NOT the pre-fix code and it silently weakened two arms.** It went
 * through an exported `openUnclassified`, which still contained the new `catchCause` around the
 * migration — so for the `foreign` and `migration` cases the "unguarded" twin was already half
 * fixed, and a test asserting the old path DIED there was measuring the new one. It was caught by
 * `Cause.hasDies` coming back `false` where the whole argument said it must be `true`. The export is
 * gone; the twin is written out here where it cannot drift.
 *
 * ⚠️ **A valid database is not byte-identical after a refusal, and that is not a violation.** Opening any
 * SQLite file at all sets `journal_mode = WAL`, which writes the header. A byte comparison here
 * would have been a false assertion (it was the first draft, and it went red for the right reason).
 * The claim that matters is about DATA and NAMES: no file is renamed or removed, and the rows that
 * were in the database are still in it afterwards.
 *
 * **NEGATIVE CONTROLS — 9 mutations, 9 red, each restored. Measured 2026-08-07 (win32, bun 1.3.14,
 * `#sqlite` → `sqlite.bun.ts`), baseline 22 pass / 0 fail.** Each one edits `src/database/database.ts`,
 * re-runs this file, and puts the original back (throwaway harness, not committed):
 *
 * | mutation | fails |
 * |---|---|
 * | **a fresh `Layer.effect` per `layerFromPath` call — THE REGRESSION** | **3** — two connections, two `:memory:` databases |
 * | `defaultLayer` building its own service layer (the `Layer.unwrap` half of it) | **3** |
 * | `Layer.catchCause` → `Layer.catch` in `layerFromPath` | **7** — a defect is not a typed error, so nothing is caught at all |
 * | the catch moved INSIDE, i.e. before `Layer.provide` | **3** — the driver's own open throw is never seen |
 * | `faultFrom` always calling `classifyOpenFailure` | **3** — `foreign` and `migration` both come back `unknown` |
 * | `Effect.catchCause` → `Effect.catch` around `DatabaseMigration.apply` | **3** — the foreign arm dies, so `catch` misses it |
 * | `refuse` without the `process.stderr.write` | **5** — the log event alone is invisible in the packaged app |
 * | the whole pre-fix module restored (`Effect.orDie` over the build) | **10** |
 * | two summaries collapsed into one wording | **2** |
 *
 * …and the *"two memo maps are two databases"* control is itself arrangement-sensitive rather than
 * trivially true: handing its two builds ONE memo map instead of two turns it red (1 fail), measured
 * the same way.
 */
import { describe, expect, test } from "bun:test"
import fsSync from "node:fs"
import path from "node:path"
import { Database as BunSqlite } from "bun:sqlite"
import { EffectDrizzleSqlite } from "@novaclaw/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "#sqlite"
import { sql } from "drizzle-orm"
import { Cause, Context, Effect, Exit, Layer, Scope } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { DatabaseMigration } from "@novaclaw/core/database/migration"
import { migrations } from "@novaclaw/core/database/migration.gen"
import { tmpdir } from "./fixture/tmpdir"

/** Build the shipped layer and demand the service. Returns the Exit, never throws. */
const open = (file: string) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      return db
    }).pipe(Effect.provide(Database.layerFromPath(file)), Effect.scoped),
  )

/**
 * **The twin: `database.ts` as it was BEFORE this fix, verbatim.**
 *
 * Held here rather than exported from the module, so the product has no unguarded entry point at
 * all. `Effect.orDie` is included on purpose — it is the construct under indictment, and a defect
 * is what the old code produced. Every poison below is run through this against the SAME file in
 * the same test: if it stops failing, the poison stopped biting and the arm beside it is asserting
 * nothing.
 */
const preFix = (file: string) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.run("PRAGMA journal_mode = WAL")
      yield* db.run("PRAGMA synchronous = NORMAL")
      yield* db.run("PRAGMA busy_timeout = 5000")
      yield* db.run("PRAGMA cache_size = -64000")
      yield* db.run("PRAGMA foreign_keys = ON")
      yield* db.run("PRAGMA wal_checkpoint(PASSIVE)")
      yield* DatabaseMigration.apply(db)
      return db
    }).pipe(Effect.orDie, Effect.provide(sqliteLayer({ filename: file })), Effect.scoped),
  )

/** The refusal, as a value — plus everything it wrote to stderr while producing it. */
async function refusalOf(file: string): Promise<{ fault: Database.Fault; stderr: string }> {
  const written: string[] = []
  const original = process.stderr.write.bind(process.stderr)
  // eslint-disable-next-line
  process.stderr.write = ((chunk: unknown) => {
    written.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  let exit: Exit.Exit<unknown, unknown>
  try {
    exit = await open(file)
  } finally {
    process.stderr.write = original
  }
  if (Exit.isSuccess(exit)) throw new Error(`${file} was expected to refuse, and it opened`)
  const squashed = Cause.squash(exit.cause)
  if (!(squashed instanceof Database.Unusable))
    throw new Error(`${file} failed with something other than a named refusal:\n${Cause.pretty(exit.cause)}`)
  return { fault: squashed.fault, stderr: written.join("") }
}

/** Every entry in `dir`, so a rename or a deletion cannot happen unnoticed. */
const entries = (dir: string) => fsSync.readdirSync(dir).sort()

/** A structurally valid database carrying the user's own row, written outside NovaClaw. */
function writeUserDatabase(file: string, build: (db: BunSqlite) => void) {
  const db = new BunSqlite(file)
  try {
    build(db)
  } finally {
    db.close()
  }
}

// ── 1. a missing file is a FIRST RUN, not a fault ───────────────────────────────────────────────
//
// The most important arm on this page. `notes/reports/decisions-v0.2.0.md` §2's adversarial pass
// caught an earlier version of this very decision about to rename aside every healthy user database,
// so the case that must never be classified as damaged gets its own test rather than being implied
// by the others passing.
describe("a database that does not exist yet", () => {
  test("is created and migrated — no fault, no warning, no extra files", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "novaclaw.db")
    expect(fsSync.existsSync(file)).toBe(false)

    const written: string[] = []
    const original = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: unknown) => {
      written.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    let exit: Exit.Exit<unknown, unknown>
    try {
      exit = await open(file)
    } finally {
      process.stderr.write = original
    }

    expect(Exit.isSuccess(exit)).toBe(true)
    expect(written.join("")).not.toContain("[novaclaw]")
    expect(fsSync.existsSync(file)).toBe(true)

    // …and it really is OUR database, fully journalled: every declared migration is recorded, so a
    // second boot is a no-op rather than a replay.
    const db = new BunSqlite(file, { readonly: true })
    try {
      const names = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
        (row) => row.name,
      )
      expect(names).toContain("session")
      expect(names).toContain("migration")
      const recorded = (db.query("SELECT id FROM migration").all() as { id: string }[]).map((row) => row.id)
      expect(recorded.length).toBe(migrations.length)
    } finally {
      db.close()
    }

    // The control on the control: the unguarded twin opens this one too, so a passing arm here is
    // not evidence that the guard is doing anything.
    const twin = await preFix(path.join(dir.path, "second.db"))
    expect(Exit.isSuccess(twin)).toBe(true)
  })
})

// ── 2. the file cannot be OPENED ────────────────────────────────────────────────────────────────
describe("a database that cannot be opened", () => {
  test("a directory where the file belongs refuses as `unreadable`, and says how to move", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "occupied")
    fsSync.mkdirSync(file)

    // The twin: this is exactly what used to die anonymously.
    expect(Exit.isFailure(await preFix(file))).toBe(true)

    const { fault, stderr } = await refusalOf(file)
    expect(fault.kind).toBe("unreadable")
    expect(fault.path).toBe(file)
    expect(fault.migration).toBeUndefined()
    expect(stderr).toContain("[novaclaw]")
    expect(stderr).toContain(file)
    expect(stderr).toContain("Nothing was moved, renamed or deleted")
    expect(stderr).toContain("--home <dir>")
    // The directory is still a directory, and nothing appeared beside it.
    expect(fsSync.statSync(file).isDirectory()).toBe(true)
    expect(entries(dir.path)).toEqual(["occupied"])
  })

  test("a parent that is a file refuses the same way", async () => {
    await using dir = await tmpdir()
    fsSync.writeFileSync(path.join(dir.path, "blocker"), "not a directory")
    const file = path.join(dir.path, "blocker", "novaclaw.db")

    expect(Exit.isFailure(await preFix(file))).toBe(true)
    const { fault } = await refusalOf(file)
    expect(fault.kind).toBe("unreadable")
    expect(entries(dir.path)).toEqual(["blocker"])
    expect(fsSync.readFileSync(path.join(dir.path, "blocker"), "utf8")).toBe("not a directory")
  })
})

// ── 3. the file is CORRUPT ──────────────────────────────────────────────────────────────────────
describe("a database whose bytes are not a database", () => {
  test("refuses as `corrupt`, keeps the file byte-for-byte, and never offers to delete it", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "novaclaw.db")
    const garbage = Buffer.from("this is definitely not a sqlite image\n".repeat(64))
    fsSync.writeFileSync(file, garbage)

    expect(Exit.isFailure(await preFix(file))).toBe(true)

    const { fault, stderr } = await refusalOf(file)
    expect(fault.kind).toBe("corrupt")
    // A file SQLite cannot open is a file SQLite cannot write to either, so this one really is
    // byte-identical — unlike a valid database, which the WAL pragma touches (see the header).
    expect(Buffer.compare(garbage, fsSync.readFileSync(file))).toBe(0)
    expect(entries(dir.path)).toEqual(["novaclaw.db"])
    // The repair tells the user what moving it aside COSTS, and puts the act in their hands.
    expect(stderr).toContain("Restore this file from a backup")
    expect(fault.repair.join(" ")).toContain("which is why NovaClaw will not do it for you")
  })
})

// ── 4. the file is a database, but not OURS ─────────────────────────────────────────────────────
describe("a foreign database at our path", () => {
  test("refuses as `foreign`, names the tables it found, and leaves them alone", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "novaclaw.db")
    writeUserDatabase(file, (db) => {
      db.run("CREATE TABLE invoices (id TEXT PRIMARY KEY, total INTEGER)")
      db.run("CREATE TABLE customers (id TEXT PRIMARY KEY)")
      db.run("INSERT INTO invoices (id, total) VALUES ('inv-1', 4200)")
    })

    expect(Exit.isFailure(await preFix(file))).toBe(true)

    const { fault, stderr } = await refusalOf(file)
    expect(fault.kind).toBe("foreign")
    expect(fault.tables).toEqual(["customers", "invoices"])
    expect(stderr).toContain("customers, invoices")
    expect(entries(dir.path).filter((entry) => !entry.startsWith("novaclaw.db"))).toEqual([])

    // The user's own rows are untouched — and no NovaClaw table was created beside them.
    const db = new BunSqlite(file, { readonly: true })
    try {
      expect((db.query("SELECT total FROM invoices WHERE id = 'inv-1'").get() as { total: number }).total).toBe(4200)
      const names = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
        (row) => row.name,
      )
      expect(names.sort()).toEqual(["customers", "invoices"])
    } finally {
      db.close()
    }
  })
})

// ── 5. a MIGRATION fails on a structurally valid database ───────────────────────────────────────
//
// This is the case the whole ruling turns on. The fixture reproduces Wave 0's B5 shape exactly —
// a perfectly healthy user database plus a migration that collides with what is already there —
// without touching a single migration file: a `session` table (so the upgrade path runs) beside an
// EMPTY `migration` journal, so migration #1's `CREATE TABLE session` throws.
describe("a migration that fails on a structurally valid database", () => {
  test("refuses as `migration`, names the id, and does not touch a byte of the user's data", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "novaclaw.db")
    writeUserDatabase(file, (db) => {
      db.run("CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT)")
      db.run("CREATE TABLE migration (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL)")
      db.run("INSERT INTO session (id, title) VALUES ('ses-1', 'the chat the user cares about')")
    })

    expect(Exit.isFailure(await preFix(file))).toBe(true)

    const { fault, stderr } = await refusalOf(file)
    expect(fault.kind).toBe("migration")
    // DERIVED from the journal, not caught: the first declared migration that is not recorded.
    expect(fault.migration).toBe(migrations[0]!.id)
    expect(stderr).toContain(migrations[0]!.id)
    expect(stderr).toContain("Install the NovaClaw version you were running before")

    // ⚠️ NOT a byte comparison — see the header. Nothing was renamed away, and nothing was written
    // into the user's table.
    expect(entries(dir.path).filter((entry) => !entry.startsWith("novaclaw.db"))).toEqual([])
    expect(entries(dir.path)).not.toContain("novaclaw.damaged.db")
    const db = new BunSqlite(file, { readonly: true })
    try {
      expect(db.query("SELECT title FROM session WHERE id = 'ses-1'").get()).toEqual({
        title: "the chat the user cares about",
      })
      expect((db.query("SELECT id FROM migration").all() as { id: string }[]).length).toBe(0)
    } finally {
      db.close()
    }
  })

  test("a failed CREATE of the initial schema claims no migration id rather than guessing one", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "novaclaw.db")
    // Zero tables (so `apply` takes the fresh-install branch) but a VIEW named `session`, which
    // `schema.up`'s `CREATE TABLE session` collides with. The journal is never created, so there is
    // no evidence for an id — and ruling 2 makes claiming one worse than saying nothing.
    writeUserDatabase(file, (db) => db.run("CREATE VIEW session AS SELECT 1 AS id"))

    expect(Exit.isFailure(await preFix(file))).toBe(true)

    const { fault, stderr } = await refusalOf(file)
    expect(fault.kind).toBe("migration")
    expect(fault.migration).toBeUndefined()
    expect(stderr).toContain("could not create the tables")
    expect(stderr).not.toContain("migration:")
  })
})

// ── the mechanism the whole fix rests on ────────────────────────────────────────────────────────
describe("the constructs this fix depends on, pinned against effect@4.0.0-beta.83", () => {
  test("`Effect.catch` does NOT see a defect, and `catchCause` does", async () => {
    const dying = Effect.die(new Error("boom"))
    const viaCatch = await Effect.runPromiseExit(dying.pipe(Effect.catch(() => Effect.succeed("caught"))))
    expect(Exit.isFailure(viaCatch)).toBe(true)
    const viaCatchCause = await Effect.runPromise(dying.pipe(Effect.catchCause(() => Effect.succeed("caught"))))
    expect(viaCatchCause).toBe("caught")
  })

  test("`Effect.ignore` does NOT see a defect either — the same trap, one call away", async () => {
    expect(Exit.isFailure(await Effect.runPromiseExit(Effect.die(new Error("boom")).pipe(Effect.ignore)))).toBe(true)
    expect(Exit.isSuccess(await Effect.runPromiseExit(Effect.die(new Error("boom")).pipe(Effect.ignoreCause)))).toBe(
      true,
    )
  })

  test("the foreign arm really is a DEFECT, so `catch` would have missed it", async () => {
    await using dir = await tmpdir()
    const file = path.join(dir.path, "novaclaw.db")
    writeUserDatabase(file, (db) => db.run("CREATE TABLE strangers (id TEXT PRIMARY KEY)"))
    const exit = await preFix(file)
    if (!Exit.isFailure(exit)) throw new Error("the foreign database opened — the poison stopped biting")
    // `hasFails` would be true for a typed failure. It is not: `DatabaseMigration.apply` DIES, so
    // an `Effect.catch` around it — the shape three other subsystems shipped — sees nothing at all.
    expect(Cause.hasDies(exit.cause)).toBe(true)
    expect(Cause.hasFails(exit.cause)).toBe(false)
  })
})

// ── the message, as a pure function ─────────────────────────────────────────────────────────────
describe("what the user reads", () => {
  const FILE = "C:\\Users\\someone\\AppData\\Local\\novaclaw\\novaclaw.db"
  const sample = (kind: Database.FaultKind, extra: Partial<Database.Fault> = {}): Database.Fault => {
    const base = { kind, path: FILE, detail: "SQLiteError: something\n    at somewhere", ...extra }
    return { ...base, summary: Database.summaryFor(kind, FILE, base.migration), repair: Database.repairsFor(base) }
  }

  test("every kind names the file, promises nothing was destroyed, and offers a way out", () => {
    // `Database.faultKinds`, never a list retyped here: a hand-kept copy stays green when a sixth
    // kind lands, so the new arm ships with no coverage at all — which is how a kind whose only job
    // is to not be described as another one would get described as another one.
    for (const kind of Database.faultKinds) {
      const text = Database.report(sample(kind))
      expect(text).toContain("C:\\Users\\someone\\AppData\\Local\\novaclaw\\novaclaw.db")
      expect(text).toContain("Nothing was moved, renamed or deleted")
      expect(text).toContain("What repairs this:")
      expect(Database.repairsFor(sample(kind)).length).toBeGreaterThanOrEqual(2)
      // One line per repair, and none of them empty.
      expect(text.split("\n").filter((line) => line.startsWith("[novaclaw]   - ")).length).toBe(
        sample(kind).repair.length,
      )
      // The raw cause never leaks a stack into the user's face — one line only.
      expect(text.split("\n").filter((line) => line.includes("at somewhere")).length).toBe(0)
    }
  })

  test("no two kinds share a sentence — a fault described falsely is the failure mode", () => {
    const summaries = Database.faultKinds.map((kind) => Database.report(sample(kind)).split("\n")[0])
    expect(new Set(summaries).size).toBe(Database.faultKinds.length)
  })

  test("🔴 contention is not blamed on this VERSION — `busy` never sends the user to downgrade", () => {
    // The whole point of the kind. `migration` says "this is a fault in this version of NovaClaw"
    // and "install the NovaClaw version you were running before"; a second window on one database
    // file earned that sentence for as long as the classifier had nowhere else to put it.
    const busy = Database.repairsFor(sample("busy")).join(" ")
    expect(/install the novaclaw version you were running before/i.test(busy)).toBe(false)
    expect(/downgrade|reinstall/i.test(Database.repairsFor(sample("migration")).join(" "))).toBe(false)
    expect(busy).toContain("Close the other one")
    expect(busy).toContain("do NOT reinstall or downgrade")
    // …and the control: `migration` still says exactly what it always said.
    expect(Database.repairsFor(sample("migration")).join(" ")).toContain(
      "Install the NovaClaw version you were running before",
    )
  })

  test("the migration id appears only when there is one", () => {
    expect(Database.report(sample("migration", { migration: "20260127222353_familiar_lady_ursula" }))).toContain(
      "migration: 20260127222353_familiar_lady_ursula",
    )
    expect(Database.report(sample("migration"))).not.toContain("migration:")
  })

  test("no repair on any path tells NovaClaw to move the user's file for them", () => {
    for (const kind of Database.faultKinds)
      for (const line of Database.repairsFor(sample(kind)))
        expect(/novaclaw (will|would) (rename|move|delete)/i.test(line)).toBe(false)
  })
})

// ── the invariant this fix BROKE once, and the guard that did not exist ─────────────────────────
//
// 🔴 The first version of this work shipped a real regression and 19 green tests plus a live `serve`
// smoke all missed it, because every one of them built ONE composition of `Database`. Server tests
// went 259/11 with `Session.NotFoundError` on a session that had just been created: two SQLite
// connections in one process, so the write landed in one `:memory:` database and the read went to
// the other.
//
// The mechanism, read out of `effect@4.0.0-beta.83` rather than guessed: `MemoMap` is
// `new Map<Layer<any, any, any>, MemoMapEntry>()` — keyed on layer **object identity** — and only
// `Layer.effect` (via `fromBuildMemo`) is ever a key; `Layer.provide`/`catchCause`/`unwrap` are
// `fromBuildUnsafe` pass-throughs that forward the same memo map down. Making the service layer a
// function of the filename allocated a fresh key per call, so `Database.node` (built once at module
// load) and `Database.defaultLayer` (rebuilt through `Layer.unwrap`) stopped sharing.
//
// `layer-node.ts`'s own `compile` comment states the invariant in as many words — *"Effect memoizes
// by the inner reference, not by the `Layer.provide` wrapper … a node with `deps: []` is returned as
// its module-level layer object unchanged"* — and nothing enforced it. This does.
describe("one process, one database", () => {
  /** Any composition that yields a Database — what a memo map is asked to share. */
  type Composition = Layer.Layer<Database.Service, never, never>
  const NODE = LayerNode.compile(Database.node) as Composition
  const DEFAULT = Database.defaultLayer as Composition

  /**
   * Build several compositions in ONE memo map, exactly as a `serve` boot does, and hand the test
   * the resolved services.
   */
  const share = <A>(
    use: (get: (layer: Composition) => Effect.Effect<Database.Interface>) => Effect.Effect<A, unknown>,
  ): Promise<A> =>
    Effect.runPromise(
      Effect.gen(function* () {
        const memoMap = yield* Layer.makeMemoMap
        const scope = yield* Scope.make()
        try {
          return yield* use((layer) =>
            Layer.buildWithMemoMap(layer, memoMap, scope).pipe(
              Effect.map((context) => Context.getUnsafe(context, Database.Service)),
            ),
          )
        } finally {
          yield* Scope.close(scope, Exit.void)
        }
      }) as Effect.Effect<A>,
    )

  test("Database.node and Database.defaultLayer resolve to the SAME connection", async () => {
    const [viaNode, viaDefault, viaDefaultAgain] = await share((get) =>
      Effect.gen(function* () {
        const a = yield* get(NODE)
        const b = yield* get(DEFAULT)
        const c = yield* get(DEFAULT)
        return [a, b, c] as const
      }),
    )
    expect(viaNode.db).toBe(viaDefault.db)
    expect(viaDefault.db).toBe(viaDefaultAgain.db)
  })

  test("…and it is one DATABASE, not merely one object — a write through either is visible to both", async () => {
    // The behavioural half, and the one that matches the production symptom. `NOVACLAW_DB` is
    // `:memory:` under the suite, so two connections are two EMPTY databases: a row written through
    // one is simply absent from the other, which is what `Session.NotFoundError` was.
    const seen = await share((get) =>
      Effect.gen(function* () {
        const writer = yield* get(NODE)
        const reader = yield* get(DEFAULT)
        yield* writer.db.run("CREATE TABLE IF NOT EXISTS one_process_one_database (id TEXT PRIMARY KEY)")
        yield* writer.db.run("DELETE FROM one_process_one_database")
        yield* writer.db.run("INSERT INTO one_process_one_database (id) VALUES ('shared')")
        return yield* reader.db
          .all<{ id: string }>(sql`SELECT id FROM one_process_one_database`)
          .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      }),
    )
    expect(seen).toEqual([{ id: "shared" }])
  })

  test("the guard bites: two memo maps are two databases (negative control)", async () => {
    // The same two builds under SEPARATE memo maps must NOT share — otherwise the assertions above
    // would pass for a reason that has nothing to do with memoization, and would keep passing after
    // the regression came back. This is the failing shape, reproduced on purpose.
    const separate = await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make()
        try {
          const first = yield* Layer.buildWithMemoMap(NODE, yield* Layer.makeMemoMap, scope)
          const second = yield* Layer.buildWithMemoMap(DEFAULT, yield* Layer.makeMemoMap, scope)
          const writer = Context.getUnsafe(first, Database.Service)
          const reader = Context.getUnsafe(second, Database.Service)
          yield* writer.db.run("CREATE TABLE IF NOT EXISTS two_memo_maps (id TEXT PRIMARY KEY)")
          const visible = yield* reader.db
            .all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'two_memo_maps'`)
            .pipe(Effect.catchCause(() => Effect.succeed(undefined)))
          return { same: writer.db === reader.db, visible }
        } finally {
          yield* Scope.close(scope, Exit.void)
        }
      }),
    )
    expect(separate.same).toBe(false)
    expect(separate.visible).toEqual([])
  })
})

// ── ruling 1: the invariant ships with a mechanical check ───────────────────────────────────────
describe("the module cannot quietly re-arm the killer", () => {
  const SOURCE_PATH = path.join(import.meta.dir, "..", "src", "database", "database.ts")
  // ⚠️ Comments FIRST. This file documents `Effect.orDie` at length in its own header, and a regex
  // over raw source would count that prose — the standing "a regex over source counts PROSE" rule,
  // which has produced three wrong numbers inside guards written to prevent the very thing.
  const CODE = fsSync
    .readFileSync(SOURCE_PATH, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n")

  test("the comment stripper actually strips (negative control)", () => {
    const raw = fsSync.readFileSync(SOURCE_PATH, "utf8")
    expect(raw).toContain("Effect.orDie")
    expect(raw).toContain("quarantine")
    expect(CODE).not.toContain("quarantine")
    expect(CODE.length).toBeLessThan(raw.length)
    expect(CODE).toContain("layerFromPath")
  })

  test("no `orDie` survives anywhere in the module", () => {
    expect(CODE).not.toContain("orDie")
  })

  test("the ONLY death is `refuse`, and it is reached through the classifier", () => {
    expect([...CODE.matchAll(/Effect\.die\(/g)]).toHaveLength(1)
    expect(CODE).toContain("Effect.die(new Unusable(")
    expect([...CODE.matchAll(/Layer\.catchCause\(/g)].length).toBeGreaterThanOrEqual(1)
  })

  test("nothing on this path renames, moves, deletes or truncates the file", () => {
    // ⚠️ The quarantine name from `notes/reports/decisions-v0.2.0.md` §2 is `<name>.damaged-<ts>.db`,
    // so the token to forbid is `.damaged-`, NOT the word "damaged" — which is legitimate English in
    // the corrupt summary the user reads. The first draft forbade the word and went red against its
    // own user-facing sentence.
    for (const forbidden of ["renameSync", "rename(", "unlink", "rmSync", "copyFile", "truncate", ".damaged"])
      expect(CODE).not.toContain(forbidden)
  })

  test("there is exactly ONE way to get a Database.Service", () => {
    // No unguarded escape hatch survives in the module: the pre-fix composition lives in this test.
    expect([...CODE.matchAll(/Layer\.effect\(Service,/g)]).toHaveLength(2) // the build, and `refuse`
    expect(CODE).not.toContain("openUnclassified")
    expect(CODE.match(/export (const|function) layerFromPath/)).not.toBeNull()
  })
})
