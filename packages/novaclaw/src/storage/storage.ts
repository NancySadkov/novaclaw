import { LayerNode } from "@novaclaw/core/effect/layer-node"
import path from "path"
import { Global } from "@novaclaw/core/global"
import { FSUtil } from "@novaclaw/core/fs-util"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { Cause, Effect, Exit, Layer, Option, RcMap, Schema, Context, TxReentrantLock } from "effect"
import { NonNegativeInt } from "@novaclaw/core/schema"
import { Log } from "@novaclaw/schema/log"
import { Git } from "@/git"
import { Pressure } from "./pressure"

type Migration = (dir: string, fs: FSUtil.Interface, git: Git.Interface) => Effect.Effect<void, FSUtil.Error>

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("NotFoundError", {
  message: Schema.String,
}) {
  static isInstance(input: unknown): input is NotFoundError {
    return input instanceof NotFoundError
  }
}

export type Error = FSUtil.Error | NotFoundError

const RootFile = Schema.Struct({
  path: Schema.optional(
    Schema.Struct({
      root: Schema.optional(Schema.String),
    }),
  ),
})

const SessionFile = Schema.Struct({
  id: Schema.String,
})

const MessageFile = Schema.Struct({
  id: Schema.String,
})

const DiffFile = Schema.Struct({
  additions: NonNegativeInt,
  deletions: NonNegativeInt,
})

const SummaryFile = Schema.Struct({
  id: Schema.String,
  projectID: Schema.String,
  summary: Schema.Struct({ diffs: Schema.Array(DiffFile) }),
})

const decodeRoot = Schema.decodeUnknownOption(RootFile)
const decodeSession = Schema.decodeUnknownOption(SessionFile)
const decodeMessage = Schema.decodeUnknownOption(MessageFile)
const decodeSummary = Schema.decodeUnknownOption(SummaryFile)

export interface Interface {
  readonly remove: (key: string[]) => Effect.Effect<void, FSUtil.Error>
  readonly read: <T>(key: string[]) => Effect.Effect<T, Error>
  readonly update: <T>(key: string[], fn: (draft: T) => void) => Effect.Effect<T, Error>
  readonly write: <T>(key: string[], content: T) => Effect.Effect<void, FSUtil.Error>
  readonly list: (prefix: string[]) => Effect.Effect<string[][], FSUtil.Error>
  /**
   * How much memory and disk this host has left, against the `resource_pressure` thresholds.
   *
   * Storage owns it because Storage is what runs out (`todo/resource-pressure.md`), and because the
   * consumers this feeds — the operator's Storage row, the `<env>` headroom line every model reads
   * before planning a download, and the scheduler's admission point — must all be quoting ONE number
   * (ruling 6). Never throws: a host it cannot measure returns `known: false` with a reason, never a
   * fabricated 0.
   */
  readonly pressure: () => Effect.Effect<Pressure.Report>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/Storage") {}

function file(dir: string, key: string[]) {
  return path.join(dir, ...key) + ".json"
}

function missing(err: unknown) {
  if (!err || typeof err !== "object") return false
  if ("code" in err && err.code === "ENOENT") return true
  if ("reason" in err && err.reason && typeof err.reason === "object" && "_tag" in err.reason) {
    return err.reason._tag === "NotFound"
  }
  return false
}

function parseMigration(text: string) {
  const value = Number.parseInt(text, 10)
  return Number.isNaN(value) ? 0 : value
}

const MIGRATIONS: Migration[] = [
  Effect.fn("Storage.migration.1")(function* (dir: string, fs: FSUtil.Interface, git: Git.Interface) {
    const project = path.resolve(dir, "../project")
    if (!(yield* fs.isDir(project))) return
    const projectDirs = yield* fs.glob("*", {
      cwd: project,
      include: "all",
    })
    for (const projectDir of projectDirs) {
      const full = path.join(project, projectDir)
      if (!(yield* fs.isDir(full))) continue
      yield* Log.event("storage.project.migrate", { "storage.legacy_project": projectDir })
      let projectID = projectDir
      let worktree = "/"

      if (projectID !== "global") {
        for (const msgFile of yield* fs.glob("storage/session/message/*/*.json", {
          cwd: full,
          absolute: true,
        })) {
          const json = decodeRoot(yield* fs.readJson(msgFile), { onExcessProperty: "preserve" })
          const root = Option.isSome(json) ? json.value.path?.root : undefined
          if (!root) continue
          worktree = root
          break
        }
        if (!worktree) continue
        if (!(yield* fs.isDir(worktree))) continue
        const result = yield* git.run(["rev-list", "--max-parents=0", "--all"], {
          cwd: worktree,
        })
        const [id] = result
          .text()
          .split("\n")
          .filter(Boolean)
          .map((x) => x.trim())
          .toSorted()
        if (!id) continue
        projectID = id

        yield* fs.writeWithDirs(
          path.join(dir, "project", projectID + ".json"),
          JSON.stringify(
            {
              id,
              vcs: "git",
              worktree,
              time: {
                created: Date.now(),
                initialized: Date.now(),
              },
            },
            null,
            2,
          ),
        )

        yield* Log.event("storage.session.migrate", { "storage.project": projectID })
        for (const sessionFile of yield* fs.glob("storage/session/info/*.json", {
          cwd: full,
          absolute: true,
        })) {
          const dest = path.join(dir, "session", projectID, path.basename(sessionFile))
          yield* Log.event("storage.session.copy", {
            "storage.source": sessionFile,
            "storage.destination": dest,
          })
          const session = yield* fs.readJson(sessionFile)
          const info = decodeSession(session, { onExcessProperty: "preserve" })
          yield* fs.writeWithDirs(dest, JSON.stringify(session, null, 2))
          if (Option.isNone(info)) continue
          yield* Log.event("storage.message.migrate", { "storage.session": info.value.id })
          for (const msgFile of yield* fs.glob(`storage/session/message/${info.value.id}/*.json`, {
            cwd: full,
            absolute: true,
          })) {
            const next = path.join(dir, "message", info.value.id, path.basename(msgFile))
            yield* Log.event("storage.message.copy", {
              "storage.source": msgFile,
              "storage.destination": next,
            })
            const message = yield* fs.readJson(msgFile)
            const item = decodeMessage(message, { onExcessProperty: "preserve" })
            yield* fs.writeWithDirs(next, JSON.stringify(message, null, 2))
            if (Option.isNone(item)) continue

            yield* Log.event("storage.part.migrate", { "storage.message": item.value.id })
            for (const partFile of yield* fs.glob(`storage/session/part/${info.value.id}/${item.value.id}/*.json`, {
              cwd: full,
              absolute: true,
            })) {
              const out = path.join(dir, "part", item.value.id, path.basename(partFile))
              const part = yield* fs.readJson(partFile)
              yield* Log.event("storage.part.copy", {
                "storage.source": partFile,
                "storage.destination": out,
              })
              yield* fs.writeWithDirs(out, JSON.stringify(part, null, 2))
            }
          }
        }
      }
    }
  }),
  Effect.fn("Storage.migration.2")(function* (dir: string, fs: FSUtil.Interface) {
    for (const item of yield* fs.glob("session/*/*.json", {
      cwd: dir,
      absolute: true,
    })) {
      const raw = yield* fs.readJson(item)
      const session = decodeSummary(raw, { onExcessProperty: "preserve" })
      if (Option.isNone(session)) continue
      const diffs = session.value.summary.diffs
      yield* fs.writeWithDirs(
        path.join(dir, "session_diff", session.value.id + ".json"),
        JSON.stringify(diffs, null, 2),
      )
      yield* fs.writeWithDirs(
        path.join(dir, "session", session.value.projectID, session.value.id + ".json"),
        JSON.stringify(
          {
            ...(raw as Record<string, unknown>),
            summary: {
              additions: diffs.reduce((sum, x) => sum + x.additions, 0),
              deletions: diffs.reduce((sum, x) => sum + x.deletions, 0),
            },
          },
          null,
          2,
        ),
      )
    }
  }),
]

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const git = yield* Git.Service
    const settings = yield* SettingsConfigStore.Service
    const locks = yield* RcMap.make({
      lookup: () => TxReentrantLock.make(),
      idleTimeToLive: 0,
    })
    const state = yield* Effect.cached(
      Effect.gen(function* () {
        const dir = path.join(Global.Path.data, "storage")
        const marker = path.join(dir, "migration")
        const migration = yield* fs.readFileString(marker).pipe(
          Effect.map(parseMigration),
          Effect.catchIf(missing, () => Effect.succeed(0)),
          Effect.orElseSucceed(() => 0),
        )
        for (let i = migration; i < MIGRATIONS.length; i++) {
          yield* Log.event("storage.migration.run", { "storage.index": i })
          const step = MIGRATIONS[i]!
          const exit = yield* Effect.exit(step(dir, fs, git))
          if (Exit.isFailure(exit)) {
            yield* Log.event("storage.migration.run.failed", {
              "storage.index": i,
              "storage.cause": Cause.pretty(exit.cause),
            })
            break
          }
          yield* fs.writeWithDirs(marker, String(i + 1))
        }
        return { dir }
      }),
    )

    const fail = (target: string): Effect.Effect<never, NotFoundError> =>
      Effect.fail(new NotFoundError({ message: `Resource not found: ${target}` }))

    const wrap = <A>(target: string, body: Effect.Effect<A, FSUtil.Error>) =>
      body.pipe(Effect.catchIf(missing, () => fail(target)))

    const writeJson = Effect.fnUntraced(function* (target: string, content: unknown) {
      yield* fs.writeWithDirs(target, JSON.stringify(content, null, 2))
    })

    const withResolved = <A, E>(
      key: string[],
      fn: (target: string, rw: TxReentrantLock.TxReentrantLock) => Effect.Effect<A, E>,
    ): Effect.Effect<A, E | FSUtil.Error> =>
      Effect.scoped(
        Effect.gen(function* () {
          const target = file((yield* state).dir, key)
          return yield* fn(target, yield* RcMap.get(locks, target))
        }),
      )

    const remove: Interface["remove"] = Effect.fn("Storage.remove")(function* (key: string[]) {
      yield* withResolved(key, (target, rw) =>
        TxReentrantLock.withWriteLock(rw, fs.remove(target).pipe(Effect.catchIf(missing, () => Effect.void))),
      )
    })

    const read: Interface["read"] = <T>(key: string[]) =>
      Effect.gen(function* () {
        const value = yield* withResolved(key, (target, rw) =>
          TxReentrantLock.withReadLock(rw, wrap(target, fs.readJson(target))),
        )
        return value as T
      })

    const update: Interface["update"] = <T>(key: string[], fn: (draft: T) => void) =>
      Effect.gen(function* () {
        const value = yield* withResolved(key, (target, rw) =>
          TxReentrantLock.withWriteLock(
            rw,
            Effect.gen(function* () {
              const content = yield* wrap(target, fs.readJson(target))
              fn(content as T)
              yield* writeJson(target, content)
              return content
            }),
          ),
        )
        return value as T
      })

    const write: Interface["write"] = (key: string[], content: unknown) =>
      Effect.gen(function* () {
        yield* withResolved(key, (target, rw) => TxReentrantLock.withWriteLock(rw, writeJson(target, content)))
      })

    const list: Interface["list"] = Effect.fn("Storage.list")(function* (prefix: string[]) {
      const dir = (yield* state).dir
      const cwd = path.join(dir, ...prefix)
      const result = yield* fs
        .glob("**/*", {
          cwd,
          include: "file",
        })
        .pipe(Effect.catch(() => Effect.succeed<string[]>([])))
      return result
        .map((x) => [...prefix, ...x.slice(0, -5).split(path.sep)])
        .toSorted((a, b) => a.join("/").localeCompare(b.join("/")))
    })

    const pressure: Interface["pressure"] = Effect.fn("Storage.pressure")(function* () {
      // ⚠️ Ruling 3 — read the value through to its STORE, at the point of use. Not `Config.entries()`:
      // that array is computed once at the Config layer's construction and frozen for the life of the
      // location, which is the very "restart to apply" defect ruling 3 deletes. `SettingsConfigStore`
      // is live SQLite, so raising a floor takes effect on the next probe. A floor you must reboot to
      // change is a floor that gets overridden by force instead — and the moment it matters is a moment
      // when restarting the instance is the last thing anyone should be asked to do.
      const stored = yield* settings.all()
      const thresholds = Pressure.resolveThresholds(stored[Pressure.CONFIG_KEY])
      const memory = yield* Effect.promise(() => Pressure.memory())
      // Plural on purpose: data/config/cache/state can sit on DIFFERENT volumes unless `--home`
      // collapses them, so the volume with the least room is the one that decides.
      const disks = instancePaths().map((target) => Pressure.disk(target))
      return Pressure.report({ memory, disks, thresholds })
    })

    return Service.of({
      remove,
      read,
      update,
      write,
      list,
      pressure,
    })
  }),
)

/** The instance directories, deduplicated — resolved lazily because `Global.Path` is a lazy getter. */
function instancePaths(): string[] {
  return [...new Set([Global.Path.data, Global.Path.config, Global.Path.cache, Global.Path.state])]
}

export const defaultLayer = layer.pipe(
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Git.defaultLayer),
  Layer.provide(SettingsConfigStore.defaultLayer),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Git.node, SettingsConfigStore.node],
})

export * as Storage from "./storage"
