import { Database } from "bun:sqlite"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { identity } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import * as Client from "effect/unstable/sql/SqlClient"
import type { Connection } from "effect/unstable/sql/SqlConnection"
import { classifySqliteError, SqlError } from "effect/unstable/sql/SqlError"
import * as Statement from "effect/unstable/sql/Statement"
import { Sqlite } from "./sqlite"

/**
 * **The bun leg. Its sibling is `sqlite.node.ts`, and they are ~80 lines the same on purpose.**
 *
 * 🔴 **Why they were NOT collapsed into a shared core plus a driver adapter (, decided
 * 2026-09-01).** The extraction is easy to write and impossible to verify here: `node:sqlite` **does
 * not exist in bun** — `import("node:sqlite")` answers *"No such built-in module"* — so
 * `sqlite.node.ts` cannot be loaded, let alone exercised, by anything `bun test` runs. That leg only
 * executes inside the desktop server, which is an Electron `utilityProcess` running NODE. A shared
 * module refactored under a green bun gate would therefore be verified on exactly one of its two
 * callers, and the half that broke would surface as a packaged-app failure with no test naming it.
 * The transaction-permit block is the part that makes this unacceptable rather than merely
 * unpleasant: `semaphore`/`acquirer`/`transactionAcquirer` is correctness-critical, and a
 * *silently* wrong permit is a corrupt database, not a red test.
 *
 * ⚠️ **The two divergences that look like drift, MEASURED 2026-09-01:**
 *
 * 1. `?? []` on `.all()`/`.values()` here and not in the node leg is **required**, not sloppiness.
 *    Bun's `statement.values()` returns **`null`** for a statement that yields no result set (an
 *    `INSERT`); `node:sqlite`'s `all()` returns `[]` for the same statement. Adding the coalesce to
 *    node would be harmless but untrue of that driver; removing it here returns `null` where the
 *    `SqliteConnection` contract promises an array.
 * 2. The WAL guard now matches the node leg (see `nativeLayer`), which it did not before.
 *
 * If this ever is collapsed, the prerequisite is a way to run `sqlite.node.ts` under `node` in the
 * gate — not a bigger bun suite.
 */

const ATTR_DB_SYSTEM_NAME = "db.system.name"

const TypeId = "~@novaclaw/core/database/SqliteBun" as const
type TypeId = typeof TypeId

interface SqliteClient extends Client.SqlClient {
  readonly [TypeId]: TypeId
  readonly config: Config
  readonly export: Effect.Effect<Uint8Array, SqlError>
  readonly loadExtension: (path: string) => Effect.Effect<void, SqlError>
  readonly updateValues: never
}

interface Config {
  readonly filename: string
  readonly readonly?: boolean
  readonly create?: boolean
  readonly readwrite?: boolean
  readonly disableWAL?: boolean
  readonly spanAttributes?: Record<string, unknown>
  readonly transformResultNames?: (str: string) => string
  readonly transformQueryNames?: (str: string) => string
}

interface SqliteConnection extends Connection {
  readonly export: Effect.Effect<Uint8Array, SqlError>
  readonly loadExtension: (path: string) => Effect.Effect<void, SqlError>
}

const make = (options: Config) =>
  Effect.gen(function* () {
    const native = (yield* Sqlite.Native) as Database

    const compiler = Statement.makeCompilerSqlite(options.transformQueryNames)
    const transformRows = options.transformResultNames
      ? Statement.defaultTransforms(options.transformResultNames).array
      : undefined

    const run = (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.withFiber<Array<Record<string, unknown>>, SqlError>((fiber) => {
        const statement = native.query(query)
        // @ts-ignore bun-types is missing the safeIntegers method tracked as Bun issue 26627
        statement.safeIntegers(Context.get(fiber.context, Client.SafeIntegers))
        try {
          return Effect.succeed((statement.all(...(params as any)) ?? []) as Array<Record<string, unknown>>)
        } catch (cause) {
          return Effect.fail(
            new SqlError({
              reason: classifySqliteError(cause, { message: "Failed to execute statement", operation: "execute" }),
            }),
          )
        }
      })

    const runValues = (query: string, params: ReadonlyArray<unknown> = []) =>
      Effect.withFiber<Array<unknown[]>, SqlError>((fiber) => {
        const statement = native.query(query)
        // @ts-ignore bun-types is missing the safeIntegers method tracked as Bun issue 26627
        statement.safeIntegers(Context.get(fiber.context, Client.SafeIntegers))
        try {
          return Effect.succeed((statement.values(...(params as any)) ?? []) as Array<unknown[]>)
        } catch (cause) {
          return Effect.fail(
            new SqlError({
              reason: classifySqliteError(cause, { message: "Failed to execute statement", operation: "execute" }),
            }),
          )
        }
      })

    const connection = identity<SqliteConnection>({
      execute(query, params, transformRows) {
        return transformRows ? Effect.map(run(query, params), transformRows) : run(query, params)
      },
      executeRaw(query, params) {
        return run(query, params)
      },
      executeValues(query, params) {
        return runValues(query, params)
      },
      executeUnprepared(query, params, transformRows) {
        return this.execute(query, params, transformRows)
      },
      executeStream() {
        return Stream.die("executeStream not implemented")
      },
      export: Effect.try({
        try: () => native.serialize(),
        catch: (cause) =>
          new SqlError({
            reason: classifySqliteError(cause, { message: "Failed to export database", operation: "export" }),
          }),
      }),
      loadExtension: (path) =>
        Effect.try({
          try: () => native.loadExtension(path),
          catch: (cause) =>
            new SqlError({
              reason: classifySqliteError(cause, { message: "Failed to load extension", operation: "loadExtension" }),
            }),
        }),
    })

    const semaphore = yield* Semaphore.make(1)
    const acquirer = semaphore.withPermits(1)(Effect.succeed(connection))
    const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
      const fiber = Fiber.getCurrent()!
      const scope = Context.getUnsafe(fiber.context, Scope.Scope)
      return Effect.as(
        Effect.tap(restore(semaphore.take(1)), () => Scope.addFinalizer(scope, semaphore.release(1))),
        connection,
      )
    })

    const client = Object.assign(
      (yield* Client.make({
        acquirer,
        compiler,
        transactionAcquirer,
        spanAttributes: [
          ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
          [ATTR_DB_SYSTEM_NAME, "sqlite"],
        ],
        transformRows,
      })) as SqliteClient,
      {
        [TypeId]: TypeId,
        config: options,
        export: Effect.flatMap(acquirer, (_) => _.export),
        loadExtension: (path: string) => Effect.flatMap(acquirer, (_) => _.loadExtension(path)),
      },
    )

    return client
  })

/** One-shot SYNCHRONOUS read for boot-time snapshot consumers (the offline chokepoint reads the
 *  settings store at layer init, before any Effect layer exists). Opens read-only, never creates,
 *  closes immediately; undefined on ANY failure (missing db/table = pre-first-boot). Exported
 *  through the `#sqlite` runtime map so the bun/node driver split stays in one place. */
export function readRowsSync(filename: string, query: string): Array<Record<string, unknown>> | undefined {
  try {
    const db = new Database(filename, { readonly: true, create: false })
    try {
      return db.query(query).all() as Array<Record<string, unknown>>
    } finally {
      db.close()
    }
  } catch {
    return undefined
  }
}

const nativeLayer = (config: Config) =>
  Layer.effect(
    Sqlite.Native,
    Effect.gen(function* () {
      const native = new Database(config.filename, {
        readonly: config.readonly,
        readwrite: config.readwrite ?? true,
        create: config.create ?? true,
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => native.close()))
      // ⚠️ The `readonly` half of this guard was missing here while `sqlite.node.ts:172` had it, and
      // the asymmetry was not benign — it was merely UNREACHED. Measured 2026-09-01: setting
      // `journal_mode = WAL` on a genuinely read-only handle throws *"attempt to write a readonly
      // database"* on BOTH drivers. It has never fired here only because the `readwrite: … ?? true`
      // above keeps the handle writable unless a caller passes `readwrite: false` as well, and no
      // production caller passes `readonly` to this layer at all today. The first one that does
      // would have crashed on bun and worked on node, which is the worst shape a difference between
      // these two files can take.
      if (config.disableWAL !== true && config.readonly !== true) native.run("PRAGMA journal_mode = WAL;")
      return native
    }),
  )

const sqliteLayer = (config: Config) => Layer.effect(Client.SqlClient, make(config))

export const layer = (config: Config) => {
  const native = nativeLayer(config)
  return Layer.merge(native, sqliteLayer(config).pipe(Layer.provide(native))).pipe(Layer.provide(Reactivity.layer))
}
