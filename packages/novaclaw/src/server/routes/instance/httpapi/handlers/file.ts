import * as InstanceState from "@/effect/instance-state"
import { FileSystem } from "@novaclaw/core/filesystem"
import { LocationServiceMap } from "@novaclaw/core/location-services"
import { ServerLocationServiceMap } from "@/location-service-map"
import { Ripgrep } from "@novaclaw/core/ripgrep"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Location } from "@novaclaw/core/location"
import { AbsolutePath, RelativePath } from "@novaclaw/core/schema"
import { Trash } from "@novaclaw/core/trash"
import { Effect, Layer, Option } from "effect"
import fs from "fs/promises"
import ignore from "ignore"
import path from "path"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const fileHandlers = HttpApiBuilder.group(InstanceHttpApi, "file", (handlers) =>
  Effect.gen(function* () {
    const ripgrep = yield* Ripgrep.Service
    const locations = yield* LocationServiceMap.Service

    const filesystem = Effect.fnUntraced(function* <A, E, R>(effect: Effect.Effect<A, E, R>) {
      return yield* effect.pipe(
        Effect.provide(
          locations.get(Location.Ref.make({ directory: AbsolutePath.make((yield* InstanceState.context).directory) })),
        ),
      )
    })

    const findText = Effect.fn("FileHttpApi.findText")(function* (ctx: { query: { pattern: string } }) {
      return (yield* ripgrep
        .grep({ cwd: (yield* InstanceState.context).directory, pattern: ctx.query.pattern, limit: 10 })
        .pipe(Effect.orDie)).map((match) => ({
        path: { text: match.entry.path },
        lines: { text: match.text },
        line_number: match.line,
        absolute_offset: match.offset,
        submatches: match.submatches.map((submatch) => ({
          match: { text: submatch.text },
          start: submatch.start,
          end: submatch.end,
        })),
      }))
    })

    const findFile = Effect.fn("FileHttpApi.findFile")(function* (ctx: {
      query: { query: string; dirs?: "true" | "false"; type?: "file" | "directory"; limit?: number }
    }) {
      const directory = (yield* InstanceState.context).directory
      const limit = ctx.query.limit ?? 10
      const type = ctx.query.type ?? (ctx.query.dirs === "false" ? "file" : undefined)
      const started = performance.now()
      const found = yield* filesystem(FileSystem.Service.use((fs) => fs.find({ query: ctx.query.query, limit, type })))
      yield* Effect.logInfo("find file", {
        query: ctx.query.query,
        type,
        directory,
        limit,
        results: found.length,
        duration: Math.round(performance.now() - started),
      })
      return found.map((item) => item.path)
    })

    const list = Effect.fn("FileHttpApi.list")(function* (ctx: { query: { path: string } }) {
      const directory = (yield* InstanceState.context).directory
      return yield* filesystem(
        Effect.gen(function* () {
          const fs = yield* FileSystem.Service
          const raw = yield* FSUtil.Service
          const location = yield* Location.Service
          const ignored = ignore()
          const gitignore = yield* raw
            .readFileString(path.join(location.root, ".gitignore"))
            .pipe(Effect.catch(() => Effect.succeed("")))
          if (gitignore) ignored.add(gitignore)
          const ignorefile = yield* raw
            .readFileString(path.join(location.root, ".ignore"))
            .pipe(Effect.catch(() => Effect.succeed("")))
          if (ignorefile) ignored.add(ignorefile)
          return (yield* fs.list({ path: RelativePath.make(ctx.query.path) })).map((item) => ({
            name: path.basename(item.path),
            path: item.path,
            absolute: path.resolve(location.directory, item.path),
            type: item.type,
            ignored: ignored.ignores(
              path.relative(location.root, path.resolve(location.directory, item.path)) +
                (item.type === "directory" ? "/" : ""),
            ),
          }))
        }),
      )
    })

    const content = Effect.fn("FileHttpApi.content")(function* (ctx: { query: { path: string } }) {
      const directory = (yield* InstanceState.context).directory
      const file = path.resolve(directory, ctx.query.path)
      if (!FSUtil.contains(directory, file)) return yield* Effect.die(new Error("Path escapes the location"))
      if (!(yield* FSUtil.Service.use((fs) => fs.existsSafe(file)))) return { type: "missing" as const, content: "" }
      return yield* filesystem(
        FileSystem.Service.use((fs) => fs.read({ path: RelativePath.make(ctx.query.path) })),
      ).pipe(
        Effect.map((item) => {
          // Binary ⇔ contains NUL bytes. A fatal UTF-8 decode used to make the call, but one
          // stray Latin-1 byte then reclassified a whole shell rc / config file as "binary
          // application/octet-stream" in the Files preview — decode leniently instead
          // (replacement chars beat a refusal for NUL-free content).
          const text = item.content.includes(0)
            ? Option.none<string>()
            : Option.some(new TextDecoder("utf-8").decode(item.content))
          return { item, text }
        }),
        Effect.map(({ item, text }) =>
          Option.isSome(text)
            ? { type: "text" as const, content: text.value.trim() }
            : {
                type: "binary" as const,
                content: Buffer.from(item.content).toString("base64"),
                encoding: "base64" as const,
                mimeType: item.mime,
              },
        ),
      )
    })

    const status = Effect.fn("FileHttpApi.status")(function* () {
      return []
    })

    // The write half (FS-1b/M4). Every mutating endpoint resolves against the routed directory and
    // re-asserts FSUtil.contains — the ONLY thing preventing `path: "../../.."` writes outside the
    // browsed root; keep the guard on any endpoint added here.
    const resolveContained = Effect.fnUntraced(function* (relative: string) {
      const directory = (yield* InstanceState.context).directory
      const file = path.resolve(directory, relative)
      if (!FSUtil.contains(directory, file)) return yield* Effect.die(new Error("Path escapes the location"))
      return file
    })

    const write = Effect.fn("FileHttpApi.write")(function* (ctx: { payload: { path: string; content: string } }) {
      const file = yield* resolveContained(ctx.payload.path)
      yield* Effect.tryPromise(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, ctx.payload.content, "utf8")
      }).pipe(Effect.orDie)
      return { ok: true as const }
    })

    const mkdir = Effect.fn("FileHttpApi.mkdir")(function* (ctx: { payload: { path: string } }) {
      const dir = yield* resolveContained(ctx.payload.path)
      yield* Effect.tryPromise(() => fs.mkdir(dir, { recursive: true })).pipe(Effect.orDie)
      return { ok: true as const }
    })

    const trash = Effect.fn("FileHttpApi.trash")(function* (ctx: { payload: { path: string } }) {
      const target = yield* resolveContained(ctx.payload.path)
      return yield* Effect.tryPromise(() => Trash.trashPath(target)).pipe(Effect.orDie)
    })

    // The trash store is GLOBAL (one store, entries from any root) — `directory` is only for routing.
    const trashList = Effect.fn("FileHttpApi.trashList")(function* () {
      return yield* Effect.tryPromise(() => Trash.listTrash()).pipe(Effect.orDie)
    })

    const trashRestore = Effect.fn("FileHttpApi.trashRestore")(function* (ctx: { payload: { id: string } }) {
      const restoredPath = yield* Effect.tryPromise(() => Trash.restore(ctx.payload.id)).pipe(Effect.orDie)
      return { restoredPath }
    })

    return handlers
      .handle("findText", findText)
      .handle("findFile", findFile)
      .handle("list", list)
      .handle("content", content)
      .handle("status", status)
      .handle("write", write)
      .handle("mkdir", mkdir)
      .handle("trash", trash)
      .handle("trashList", trashList)
      .handle("trashRestore", trashRestore)
  }),
).pipe(Layer.provide(ServerLocationServiceMap.layer))
