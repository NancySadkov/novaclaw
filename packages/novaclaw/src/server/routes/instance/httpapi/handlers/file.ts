import * as InstanceState from "@/effect/instance-state"
import { FileSystem } from "@novaclaw/core/filesystem"
import { LocationServiceMap } from "@novaclaw/core/location-services"
import { ServerLocationServiceMap } from "@/location-service-map"
import { Ripgrep } from "@novaclaw/core/ripgrep"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Location } from "@novaclaw/core/location"
import { AbsolutePath, RelativePath } from "@novaclaw/core/schema"
import { Trash } from "@novaclaw/core/trash"
import { Vcs } from "@/project/vcs"
import { Effect, Layer, Option } from "effect"
import fs from "fs/promises"
import ignore from "ignore"
import path from "path"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { FilePreviewTooLargeError, InvalidRequestError } from "../errors"
import { Log } from "@novaclaw/schema/log"
import { MAX_FILE_PREVIEW_BYTES } from "../groups/file"

export const fileHandlers = HttpApiBuilder.group(InstanceHttpApi, "file", (handlers) =>
  Effect.gen(function* () {
    const ripgrep = yield* Ripgrep.Service
    const locations = yield* LocationServiceMap.Service
    const vcs = yield* Vcs.Service

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
      yield* Log.event("server.file.find", {
        "server.query": ctx.query.query,
        // `type` is absent when the caller did not constrain the search — a real state, named
        // rather than sent as `undefined`, which renders as the literal string on the line.
        "server.type": type ?? "(any)",
        // The handler defaults an absent directory downstream; NAME the absence rather than send
        // `undefined`, which renders as the literal string "undefined" on the line.
        "server.directory": directory ?? "(instance root)",
        "server.limit": limit,
        "server.results": found.length,
        "server.duration": Math.round(performance.now() - started),
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
      const stat = yield* FSUtil.Service.use((fs) => fs.stat(file)).pipe(Effect.orDie)
      if (stat.type === "File" && Number(stat.size) > MAX_FILE_PREVIEW_BYTES) {
        return yield* new FilePreviewTooLargeError({
          bytes: Number(stat.size),
          limit: MAX_FILE_PREVIEW_BYTES,
          message: `File is too large to preview (${Number(stat.size)} bytes; limit ${MAX_FILE_PREVIEW_BYTES} bytes)`,
        })
      }
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

    /**
     * 🔴 **This used to be `return []` — a stub answering "the working tree is clean" to a contract
     * that publishes "the git status of all files in the project".**
     *
     * A caller reading `/doc` could not tell a clean tree from a route nobody wrote, which is the
     * failure ruling 2 forbids one surface up from where it usually bites: a subsystem that cannot
     * answer must name itself rather than render empty. There is no shape of "unimplemented" in the
     * declared `File[]` success schema, so the only honest closes were to delete the route or to
     * make it true. Deleting it needs the generated SDK regenerated in the same change
     * (`packages/sdk/js/src/v2/gen/sdk.gen.ts` is tracked and carries this endpoint), so it is true.
     *
     * ⚠️ It DELEGATES rather than shelling out again. `GET /vcs/status` already serves this answer
     * from `Vcs.Service`; a second implementation would be a second thing to be wrong, and two
     * routes could then disagree about one working tree. The only difference kept is the field
     * naming this group froze (`path`/`added`/`removed` against `file`/`additions`/`deletions`).
     *
     * ⚠️ Delegation also inherits `Vcs.status`'s own resolution behaviour — `git status … -- .` runs
     * in the routed directory while `statUntracked` uses the worktree, so a request routed at a
     * SUBDIRECTORY of a repository is scoped to that subtree and reports repository-root-relative
     * paths, unlike `/file` and `/file/content`, whose paths are relative to the routed directory.
     * That belongs to `Vcs`, is filed against it, and is deliberately not forked here: one site to
     * fix, and both routes move together when it is fixed.
     */
    const status = Effect.fn("FileHttpApi.status")(function* () {
      return (yield* vcs.status()).map((item) => ({
        path: item.file,
        added: item.additions,
        removed: item.deletions,
        status: item.status,
      }))
    })

    const mutationError = (action: string, error: unknown) =>
      new InvalidRequestError({
        message: `Could not ${action}: ${error instanceof Error ? error.message : String(error)}`,
      })

    // The write half (FS-1b/M4). Every mutating endpoint resolves against the routed directory and
    // re-asserts containment — the ONLY thing keeping a mutation inside the browsed root; keep the
    // guard on any endpoint added here.
    //
    // 🔴 **`FSUtil.contains` alone was not that guard, and the gap needed no `..` at all** (Codex
    // review NC-SEC-018). It compares two STRINGS, so `escape/settings.json` resolves lexically under
    // the root whether or not `escape` is a directory symlink — or, on Windows, a junction, which any
    // user can create — pointing somewhere else entirely. A cloned repository ships the link; an
    // ordinary Files write, mkdir, rename or Trash then mutates unrelated user data, and Trash even
    // records the external absolute path in the global store. `containsCanonical` resolves the target
    // (or its nearest existing ancestor, which is what makes a not-yet-created file answerable) and
    // compares the real locations.
    //
    // ⚠️ The LEXICAL check stays as the first arm rather than being replaced. It needs no syscall, it
    // is what rejects `../../..` before anything touches the disk, and keeping both means the
    // canonical arm is a narrowing — a path has to pass both, so no legitimate path that worked
    // before can be newly admitted by this change.
    //
    // ⚠️ The path RETURNED is still the lexical one. A link that canonicalizes back inside the root
    // is legitimate, and writing through it is what the user asked for; canonicalizing the returned
    // path would silently redirect those writes and change what `rename` reports to the client.
    // Only the decision is canonical.
    //
    // ⚠️ A TOCTOU window remains: an ancestor swapped between this check and the mutation still wins.
    // Closing it needs handle-relative operations Node does not offer here. Stated rather than
    // papered over — what is closed is the case that needs no race, which is the one a repository
    // can arrange in advance.
    const resolveContained = Effect.fnUntraced(function* (relative: string) {
      const directory = (yield* InstanceState.context).directory
      const file = path.resolve(directory, relative)
      if (!FSUtil.contains(directory, file) || !FSUtil.containsCanonical(directory, file))
        return yield* new InvalidRequestError({ message: "That path is outside this folder" })
      return file
    })

    const write = Effect.fn("FileHttpApi.write")(function* (ctx: { payload: { path: string; content: string } }) {
      const file = yield* resolveContained(ctx.payload.path)
      yield* Effect.tryPromise(async () => {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, ctx.payload.content, "utf8")
      }).pipe(Effect.mapError((error) => mutationError("write that file", error)))
      return { ok: true as const }
    })

    const mkdir = Effect.fn("FileHttpApi.mkdir")(function* (ctx: { payload: { path: string; exclusive?: boolean } }) {
      const dir = yield* resolveContained(ctx.payload.path)
      yield* Effect.tryPromise(() => fs.mkdir(dir, { recursive: !ctx.payload.exclusive })).pipe(
        Effect.mapError((error) => mutationError("create that folder", error)),
      )
      return { ok: true as const }
    })

    const rename = Effect.fn("FileHttpApi.rename")(function* (ctx: { payload: { path: string; name: string } }) {
      const source = yield* resolveContained(ctx.payload.path)
      const name = ctx.payload.name.trim()
      if (!name || name === "." || name === ".." || /[\\/\0]/.test(name))
        return yield* new InvalidRequestError({ message: "The new name must be one file or folder name" })
      const target = yield* resolveContained(path.join(path.dirname(ctx.payload.path), name))
      const occupied = yield* FSUtil.Service.use((fs) => fs.existsSafe(target))
      if (occupied) return yield* new InvalidRequestError({ message: "A file or folder with that name already exists" })
      yield* Effect.tryPromise(() => fs.rename(source, target)).pipe(
        Effect.mapError((error) => mutationError("rename that item", error)),
      )
      return { path: target }
    })

    const trash = Effect.fn("FileHttpApi.trash")(function* (ctx: { payload: { path: string } }) {
      const target = yield* resolveContained(ctx.payload.path)
      return yield* Effect.tryPromise(() => Trash.trashPath(target)).pipe(
        Effect.mapError((error) => mutationError("move that item to Trash", error)),
      )
    })

    // The trash store is GLOBAL (one store, entries from any root) — `directory` is only for routing.
    const trashList = Effect.fn("FileHttpApi.trashList")(function* () {
      return yield* Effect.tryPromise(() => Trash.listTrash()).pipe(Effect.orDie)
    })

    const trashRestore = Effect.fn("FileHttpApi.trashRestore")(function* (ctx: { payload: { id: string } }) {
      const restoredPath = yield* Effect.tryPromise(() => Trash.restore(ctx.payload.id)).pipe(
        Effect.mapError((error) => mutationError("restore that item", error)),
      )
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
      .handle("rename", rename)
      .handle("trash", trash)
      .handle("trashList", trashList)
      .handle("trashRestore", trashRestore)
  }),
).pipe(Layer.provide(ServerLocationServiceMap.layer))
