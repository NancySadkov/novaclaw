import { NodeFileSystem } from "@effect/platform-node"
import { basename, dirname, isAbsolute, join, parse, relative, resolve as pathResolve, sep } from "path"
import { homedir } from "os"
import { realpathSync } from "fs"
import * as NFS from "fs/promises"
import { lookup } from "mime-types"
import { Context, Effect, FileSystem, Layer, Schema } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { Glob } from "./util/glob"
import { serviceUse } from "./effect/service-use"
import { makeGlobalNode } from "./effect/app-node"
import { filesystem } from "./effect/app-node-platform"

export namespace FSUtil {
  export class FileSystemError extends Schema.TaggedErrorClass<FileSystemError>()("FileSystemError", {
    method: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  }) {
    override get message() {
      const detail = this.cause instanceof Error ? this.cause.message : this.cause && String(this.cause)
      return `Filesystem operation failed: ${this.method}${detail ? `: ${detail}` : ""}`
    }
  }

  export type Error = PlatformError | FileSystemError

  export interface DirEntry {
    readonly name: string
    readonly type: "file" | "directory" | "symlink" | "other"
  }

  export interface Interface extends FileSystem.FileSystem {
    readonly isDir: (path: string) => Effect.Effect<boolean>
    readonly isFile: (path: string) => Effect.Effect<boolean>
    readonly existsSafe: (path: string) => Effect.Effect<boolean>
    readonly readFileStringSafe: (path: string) => Effect.Effect<string | undefined, Error>
    readonly readJson: (path: string) => Effect.Effect<unknown, Error>
    readonly writeJson: (path: string, data: unknown, mode?: number) => Effect.Effect<void, Error>
    readonly ensureDir: (path: string) => Effect.Effect<void, Error>
    readonly writeWithDirs: (path: string, content: string | Uint8Array, mode?: number) => Effect.Effect<void, Error>
    readonly readDirectoryEntries: (path: string) => Effect.Effect<DirEntry[], Error>
    readonly findUp: (target: string, start: string, stop?: string) => Effect.Effect<string[], Error>
    readonly up: (options: { targets: string[]; start: string; stop?: string }) => Effect.Effect<string[], Error>
    readonly globUp: (pattern: string, start: string, stop?: string) => Effect.Effect<string[], Error>
    readonly glob: (pattern: string, options?: Glob.Options) => Effect.Effect<string[], Error>
    readonly globMatch: (pattern: string, filepath: string) => boolean
  }

  export class Service extends Context.Service<Service, Interface>()("@novaclaw/FileSystem") {}

  export const use = serviceUse(Service)

  export const layer = Layer.effect(
    Service,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem

      const existsSafe = Effect.fn("FileSystem.existsSafe")(function* (path: string) {
        return yield* fs.exists(path).pipe(Effect.orElseSucceed(() => false))
      })

      const readFileStringSafe = Effect.fn("FileSystem.readFileStringSafe")(function* (path: string) {
        return yield* fs
          .readFileString(path)
          .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
      })

      const isDir = Effect.fn("FileSystem.isDir")(function* (path: string) {
        const info = yield* fs.stat(path).pipe(Effect.catch(() => Effect.void))
        return info?.type === "Directory"
      })

      const isFile = Effect.fn("FileSystem.isFile")(function* (path: string) {
        const info = yield* fs.stat(path).pipe(Effect.catch(() => Effect.void))
        return info?.type === "File"
      })

      const readDirectoryEntries = Effect.fn("FileSystem.readDirectoryEntries")(function* (dirPath: string) {
        return yield* Effect.tryPromise({
          try: async () => {
            const entries = await NFS.readdir(dirPath, { withFileTypes: true })
            return entries.map(
              (e): DirEntry => ({
                name: e.name,
                type: e.isDirectory() ? "directory" : e.isSymbolicLink() ? "symlink" : e.isFile() ? "file" : "other",
              }),
            )
          },
          catch: (cause) => new FileSystemError({ method: "readDirectoryEntries", cause }),
        })
      })

      const readJson = Effect.fn("FileSystem.readJson")(function* (path: string) {
        const text = yield* fs.readFileString(path)
        return yield* Effect.try({
          try: () => JSON.parse(text),
          catch: (cause) => new FileSystemError({ method: "readJson", cause }),
        })
      })

      const writeJson = Effect.fn("FileSystem.writeJson")(function* (path: string, data: unknown, mode?: number) {
        const content = JSON.stringify(data, null, 2)
        yield* fs.writeFileString(path, content)
        if (mode) yield* fs.chmod(path, mode)
      })

      const ensureDir = Effect.fn("FileSystem.ensureDir")(function* (path: string) {
        yield* fs.makeDirectory(path, { recursive: true })
      })

      const writeWithDirs = Effect.fn("FileSystem.writeWithDirs")(function* (
        path: string,
        content: string | Uint8Array,
        mode?: number,
      ) {
        const write = typeof content === "string" ? fs.writeFileString(path, content) : fs.writeFile(path, content)

        yield* write.pipe(
          Effect.catchIf(
            (e) => e.reason._tag === "NotFound",
            () =>
              Effect.gen(function* () {
                yield* fs.makeDirectory(dirname(path), { recursive: true })
                yield* write
              }),
          ),
        )
        if (mode) yield* fs.chmod(path, mode)
      })

      const glob = Effect.fn("FileSystem.glob")(function* (pattern: string, options?: Glob.Options) {
        return yield* Effect.tryPromise({
          try: () => Glob.scan(pattern, options),
          catch: (cause) => new FileSystemError({ method: "glob", cause }),
        })
      })

      const findUp = Effect.fn("FileSystem.findUp")(function* (target: string, start: string, stop?: string) {
        const result: string[] = []
        const limit = boundaryFor(start, stop)
        let current = start
        while (true) {
          const search = join(current, target)
          if (yield* fs.exists(search)) result.push(search)
          if (limit !== undefined && samePath(limit, current)) break
          const parent = dirname(current)
          if (parent === current) break
          current = parent
        }
        return result
      })

      const up = Effect.fn("FileSystem.up")(function* (options: { targets: string[]; start: string; stop?: string }) {
        const result: string[] = []
        const limit = boundaryFor(options.start, options.stop)
        let current = options.start
        while (true) {
          for (const target of options.targets) {
            const search = join(current, target)
            if (yield* fs.exists(search)) result.push(search)
          }
          if (limit !== undefined && samePath(limit, current)) break
          const parent = dirname(current)
          if (parent === current) break
          current = parent
        }
        return result
      })

      const globUp = Effect.fn("FileSystem.globUp")(function* (pattern: string, start: string, stop?: string) {
        const result: string[] = []
        const limit = boundaryFor(start, stop)
        let current = start
        while (true) {
          const matches = yield* glob(pattern, { cwd: current, absolute: true, include: "file", dot: true }).pipe(
            Effect.catch(() => Effect.succeed([] as string[])),
          )
          result.push(...matches)
          if (limit !== undefined && samePath(limit, current)) break
          const parent = dirname(current)
          if (parent === current) break
          current = parent
        }
        return result
      })

      return Service.of({
        ...fs,
        existsSafe,
        readFileStringSafe,
        isDir,
        isFile,
        readDirectoryEntries,
        readJson,
        writeJson,
        ensureDir,
        writeWithDirs,
        findUp,
        up,
        globUp,
        glob,
        globMatch: Glob.match,
      })
    }),
  )

  export const defaultLayer = layer.pipe(Layer.provide(NodeFileSystem.layer))
  export const node = makeGlobalNode({ service: Service, layer: layer, deps: [filesystem] })

  // Pure helpers that don't need Effect (path manipulation, sync operations)
  export function mimeType(p: string): string {
    return lookup(p) || "application/octet-stream"
  }

  export function normalizePath(p: string): string {
    if (process.platform !== "win32") return p
    const resolved = pathResolve(windowsPath(p))
    try {
      return realpathSync.native(resolved)
    } catch {
      return resolved
    }
  }

  export function normalizePathPattern(p: string): string {
    if (process.platform !== "win32") return p
    if (p === "*") return p
    const match = p.match(/^(.*)[\\/]\*$/)
    if (!match) return normalizePath(p)
    const dir = /^[A-Za-z]:$/.test(match[1]) ? match[1] + "\\" : match[1]
    return join(normalizePath(dir), "*")
  }

  export function resolve(p: string): string {
    const resolved = pathResolve(windowsPath(p))
    try {
      return normalizePath(realpathSync(resolved))
    } catch (e: any) {
      if (e?.code === "ENOENT") return normalizePath(resolved)
      throw e
    }
  }

  export function windowsPath(p: string): string {
    if (process.platform !== "win32") return p
    return p
      .replace(/^\/([a-zA-Z]):(?:[\\/]|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
      .replace(/^\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
      .replace(/^\/cygdrive\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
      .replace(/^\/mnt\/([a-zA-Z])(?:\/|$)/, (_, drive) => `${drive.toUpperCase()}:/`)
  }

  // Declared as functions, not consts: the walks above are written earlier in the file and would
  // otherwise reference a binding in its temporal dead zone if a layer were ever built during
  // module evaluation.
  /**
   * Two paths naming the same place. Exported because `===` is the comparison that made the walks
   * above fail open: it misses a trailing separator, a case difference on win32 and an unnormalised
   * segment, and the *permissive* branch is what a missed match produces. The second copy of these
   * walks (`novaclaw/src/util/filesystem.ts`) needs the same test, and duplicating it there is how
   * the two copies drifted in the first place.
   */
  export function samePath(left: string, right: string) {
    return relative(pathResolve(windowsPath(left)), pathResolve(windowsPath(right))) === ""
  }

  /** `C:\`, `\\server\share\`, `/` — a "boundary" that would trust an entire volume. */
  export function isVolumeRoot(candidate: string): boolean {
    const resolved = pathResolve(windowsPath(candidate))
    return relative(resolved, parse(resolved).root) === ""
  }

  /**
   * The boundary an ancestor walk may actually stop at, given the one it was ASKED to stop at.
   *
   * 🔴 **A walk's `stop` is a safety parameter that fails OPEN.** The three walks above terminate
   * on `stop === current`, so a value that never equals an ancestor is not a boundary at all and
   * the walk covers every directory up to the drive root: `"/"` — the sentinel a location outside
   * any repository carries — matches nothing on Windows, and a genuine volume root (`Project.resolve`
   * returns `path.parse(input).root` when there is no repository) matches only after the walk has
   * already visited the whole volume. Both spellings mean *there is no project root*, and both were
   * read as *stop at the root of the disk*.
   *
   * This is `ProjectFileResolve.trustedBoundary`'s rule, moved onto the primitive so that no caller
   * has to remember it: a boundary that would trust a whole volume falls back to the user's HOME,
   * and a boundary that is not an ancestor of the start folder is clamped to the start folder — a
   * directory outside home is then bounded by itself rather than by nothing.
   *
   * ⚠️ **Home is the floor because of what is ABOVE it.** Walking past home reaches `C:\Users` or
   * `/`, where one stray directory would be read into every session on the machine.
   *
   * ⚠️ **Lexical, like `bounded()` in `project-file.ts`** — this runs on every config load and every
   * skill scan, and a `realpath` per level is not free. Callers that must screen a *write* against a
   * symlinked ancestor use `containsCanonical` at the write itself; a walk boundary decides only how
   * far to look.
   */
  export function walkBoundary(start: string, stop: string): string {
    const from = pathResolve(windowsPath(start))
    const requested = pathResolve(windowsPath(stop))
    const floor = isVolumeRoot(requested) ? homedir() : requested
    return contains(floor, from) ? floor : from
  }

  /**
   * `undefined` — a walk with no `stop` at all — is the ONE unbounded case, and it is deliberate:
   * repository discovery (`.git`) legitimately walks past home, reads a fixed filename, and writes
   * nothing. Every other caller states a boundary and gets it enforced.
   */
  function boundaryFor(start: string, stop: string | undefined) {
    return stop === undefined ? undefined : walkBoundary(start, stop)
  }

  /**
   * The canonical on-disk path for `p`: `realpath` where it exists, and where it does not, the
   * `realpath` of its **nearest existing ancestor** with the remaining segments appended.
   *
   * 🔴 **This is the difference between a containment check and a spelling check.** `contains()` one
   * line below is LEXICAL — it compares two strings — so `path.resolve(root, "escape/settings.json")`
   * looks internal whether or not `escape` is a directory symlink or a Windows junction pointing
   * somewhere else entirely. A repository someone cloned can ship that link, and then an apparently
   * project-confined write lands outside the browsed root (Codex review NC-SEC-018). Screening the
   * CANONICAL path screens the file; screening the lexical one screens a spelling of it.
   *
   * ⚠️ **`resolve()` above is not a substitute, and the difference is exactly the interesting case.**
   * It calls `realpathSync` on the whole path and, on `ENOENT`, falls back to the *lexical* string —
   * so for a target that does not exist yet, which is what `write` and `mkdir` are for, it hands back
   * the very path the attack is spelled in. Walking up to the nearest ancestor that DOES exist is
   * what makes a prospective target answerable.
   *
   * ⚠️ `realpathSync.native` rather than the JS implementation: on Windows the JS one keeps a mapped
   * or `subst` drive as `Y:\key.txt` while the native one collapses it to the real volume path.
   * Both measured — `location-mutation.ts` carries the same note, from the same live bypass.
   *
   * ⚠️ **It cannot close a TOCTOU window** and does not claim to. An ancestor swapped between this
   * call and the mutation still wins; only handle-relative operations would fix that. What this
   * removes is the case needing no race at all — a link that is simply *there* when the request
   * arrives.
   */
  export function canonical(p: string): string {
    const absolute = pathResolve(windowsPath(p))
    let anchor = absolute
    const trailing: string[] = []
    for (;;) {
      try {
        const root = realpathSync.native(anchor)
        return trailing.length === 0 ? root : join(root, ...trailing.reverse())
      } catch (e: any) {
        // ENOTDIR as well as ENOENT: an ancestor that is a FILE reports the former, and it is just
        // as much a "keep walking up" answer as a missing one.
        if (e?.code !== "ENOENT" && e?.code !== "ENOTDIR") throw e
      }
      const parent = dirname(anchor)
      // Reached the volume root without finding anything real — nothing to canonicalize against.
      if (parent === anchor) return absolute
      trailing.push(basename(anchor))
      anchor = parent
    }
  }

  /**
   * Does `child` resolve to a real location inside `parent`? The canonical form of BOTH sides,
   * compared with `contains`.
   *
   * ⚠️ Both sides, not just the child. A root reached through a symlink (a `/tmp` that is really
   * `/private/tmp`, a junctioned project folder) canonicalizes too, and comparing a canonical child
   * against a lexical parent would reject every legitimate path under it.
   */
  export function containsCanonical(parent: string, child: string) {
    return contains(canonical(parent), canonical(child))
  }

  export function overlaps(a: string, b: string) {
    return contains(a, b) || contains(b, a)
  }

  export function contains(parent: string, child: string) {
    const result = relative(parent, child)
    return result === "" || (!isAbsolute(result) && result !== ".." && !result.startsWith(`..${sep}`))
  }
}
