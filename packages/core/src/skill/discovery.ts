export * as SkillDiscovery from "./discovery"

import path from "path"
import { Context, Effect, Layer, Schedule, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { Download } from "../download"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { Hash } from "../util/hash"
import { Log } from "@novaclaw/schema/log"
import { makeGlobalNode } from "../effect/app-node"
import { httpClient } from "../effect/app-node-platform"
import { AbsolutePath } from "../schema"

const skillConcurrency = 4
const fileConcurrency = 8

/**
 * ─── VOLUME bounds (audit 2026-08-11, `notes/reports/skill-pull-bounds-2026-08-11.md`) ──────────
 *
 * 🔴 `pull`'s PATH posture was already strong — origin-pinned, double `FSUtil.contains`, a
 * post-decode traversal re-check, a staged replace. What it had none of was a bound on VOLUME: no
 * per-file cap, no file or skill count, no bound on `index.json`, and `transportOnly` pins no digest.
 * `webfetch` refuses at 5 MiB and this refused at nothing.
 *
 * ⚠️ These are ROBUSTNESS bounds, not a closed door — a skill source is user-configured, so the
 * threat is a mis-set URL or a source that grows, not an attacker. The numbers are chosen to be
 * obviously generous for real skills (a SKILL.md and a few assets) and obviously small next to a
 * disk; the point is that SOME number exists, not that these are measured.
 *
 * ⚠️ Every one of them is a REFUSAL that names itself in the log, never a silent truncation. A
 * truncated skill file is a corrupt skill that looks installed, which is worse than one that failed.
 */
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_INDEX_BYTES = 1024 * 1024
const MAX_SKILLS_PER_SOURCE = 500
const MAX_FILES_PER_SKILL = 200

/**
 * The cache directory one URL skill source owns, named by a digest of its base.
 *
 * 🔴 **`Hash.fast`, not `Bun.hash`.** This is a plain global node in the shared graph, reached
 * whenever a skill source has `type: "url"` — and the desktop server is an Electron
 * `utilityProcess`, which is NODE. `Bun` is undefined there, so the bare global threw a
 * `ReferenceError` out of `pull`; nothing catches it at the call site, so `SkillV2.load` died and
 * `list()` failed for EVERY source, taking the whole skill index down rather than one source. The
 * tree's other Bun globals are either guarded (`session/runner/task-constraint.ts`) or in drivers
 * that declare themselves Bun-only; this one qualified itself as neither.
 *
 * ⚠️ `util/hash.ts` exists for exactly this and has no runtime dependency. Changing the digest
 * relocates every existing source's cache directory ONCE — the next `pull` re-populates it, which is
 * the same work a new source does, so it costs a download and nothing else.
 *
 * ⚠️ Exported so the no-Bun host can be EXERCISED rather than asserted about: a test that only reads
 * the call site would pass against a digest that still needed a runtime this one does not have.
 */
export function sourceRootFor(cache: string, base: string): string {
  return path.resolve(cache, "skills", Hash.fast(base).slice(0, 16))
}

function isSafeSegment(value: string) {
  return (
    value.length > 0 &&
    value !== "." &&
    value !== ".." &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !value.includes("\0")
  )
}

function isSafeRelativePath(value: string) {
  const segments = value.split("/")
  return (
    value.length > 0 &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.includes("?") &&
    !value.includes("#") &&
    !URL.canParse(value) &&
    !path.posix.isAbsolute(value) &&
    !path.win32.isAbsolute(value) &&
    segments.every((segment) => {
      try {
        const decoded = decodeURIComponent(segment)
        return (
          decoded.length > 0 &&
          decoded !== "." &&
          decoded !== ".." &&
          !decoded.includes("/") &&
          !decoded.includes("\\") &&
          !decoded.includes("\0")
        )
      } catch {
        return false
      }
    })
  )
}

class IndexSkill extends Schema.Class<IndexSkill>("SkillDiscovery.IndexSkill")({
  name: Schema.String,
  version: Schema.optional(Schema.String),
  files: Schema.Array(Schema.String),
}) {}

class Index extends Schema.Class<Index>("SkillDiscovery.Index")({
  skills: Schema.Array(IndexSkill),
}) {}

export interface Interface {
  readonly pull: (url: string) => Effect.Effect<AbsolutePath[]>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/SkillDiscovery") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    const client = yield* HttpClient.HttpClient
    const http = client.pipe(
      HttpClient.retryTransient({
        retryOn: "errors-and-responses",
        times: 2,
        schedule: Schedule.exponential(200).pipe(Schedule.jittered),
      }),
      HttpClient.filterStatusOk,
    )

    const download = Effect.fn("SkillDiscovery.download")(function* (url: string, destination: string) {
      return yield* Download.toFile({
        url,
        destination,
        integrity: { transportOnly: true },
        maxBytes: MAX_FILE_BYTES,
      }).pipe(
        Effect.provideService(FSUtil.Service, fs),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.as(true),
        Effect.catch((error) =>
          Log.event("skill.discovery.download.failed", {
            "skill.url": url,
            "skill.error": Log.fault(error),
          }).pipe(Effect.as(false)),
        ),
      )
    })

    return Service.of({
      pull: Effect.fn("SkillDiscovery.pull")(function* (url) {
        const base = url.endsWith("/") ? url : `${url}/`
        const source = new URL(base)
        const index = new URL("index.json", source).href
        yield* Log.event("skill.index.fetch", { "skill.url": index })
        const data = yield* HttpClientRequest.get(index).pipe(
          HttpClientRequest.acceptJson,
          http.execute,
          // ⚠️ Read as TEXT with a cap before decoding. `schemaBodyJson` buffers the whole body to
          // parse it, so a bounded index has to be bounded before the parser sees it — checking the
          // decoded object's size would already have held the bytes in memory.
          Effect.flatMap((response) =>
            response.text.pipe(
              Effect.flatMap((body) =>
                // ⚠️ BYTES, not `String.length`: this bounds a REMOTE index, and the message below
                // reported the code-unit count as a byte count — a false number in its own refusal.
                Buffer.byteLength(body, "utf8") > MAX_INDEX_BYTES
                  ? Effect.fail(
                      new Error(
                        `index is ${Buffer.byteLength(body, "utf8")} bytes, over the ${MAX_INDEX_BYTES} byte limit`,
                      ),
                    )
                  : Effect.try({
                      try: () => JSON.parse(body) as unknown,
                      catch: (error) => new Error(`index is not JSON: ${String(error).slice(0, 120)}`),
                    }),
              ),
              Effect.flatMap((json) => Schema.decodeUnknownEffect(Index)(json)),
            ),
          ),
          Effect.catch((error) =>
            Log.event("skill.index.fetch.failed", {
              "skill.url": index,
              "skill.error": Log.fault(error),
            }).pipe(Effect.as(undefined)),
          ),
        )
        if (!data) return []
        // A source declaring more skills than this is refused WHOLE rather than truncated: taking the
        // first N would install a silently partial source and report success, and there is no reading
        // of "the first 500 in index order" that a user asked for.
        if (data.skills.length > MAX_SKILLS_PER_SOURCE) {
          yield* Log.event("skill.index.fetch.failed", {
            "skill.url": index,
            "skill.error": Log.fault(
              new Error(`index declares ${data.skills.length} skills, over the ${MAX_SKILLS_PER_SOURCE} limit`),
            ),
          })
          return []
        }

        const sourceRoot = sourceRootFor(global.cache, base)
        /**
         * 🔴 Every rejection below used to be a bare `return []`, so a source that tried to escape
         * its own cache directory was refused in COMPLETE SILENCE. The containment held, but the
         * operator had no way to learn that a skill source had attempted it — and "the attack was
         * blocked" and "the source had no such entry" looked identical from outside.
         *
         * Collected rather than logged inline because this callback is synchronous; the names are
         * emitted immediately after, one `skill.index.entry.invalid` each.
         */
        const rejected: string[] = []
        const roots = yield* Effect.forEach(
          data.skills.flatMap((skill) => {
            if (!isSafeSegment(skill.name)) {
              rejected.push(skill.name)
              return []
            }
            if (!skill.files.includes("SKILL.md") && !skill.files.includes(`${skill.name}.md`)) {
              rejected.push(skill.name)
              return []
            }
            // Dropped like every other malformed-skill case here — one oversized entry must not take
            // the rest of a legitimate source down with it.
            if (skill.files.length > MAX_FILES_PER_SKILL) {
              rejected.push(skill.name)
              return []
            }

            const root = path.resolve(sourceRoot, skill.name)
            if (!FSUtil.contains(sourceRoot, root) || root === sourceRoot) {
              rejected.push(skill.name)
              return []
            }

            const skillUrl = new URL(`${encodeURIComponent(skill.name)}/`, source)
            const versionFile = path.join(root, ".novaclaw-version")
            const files = skill.files.map((file) => {
              if (!isSafeRelativePath(file)) return undefined
              let resource: URL
              try {
                resource = new URL(file, skillUrl)
              } catch {
                return undefined
              }
              if (resource.origin !== source.origin) return undefined

              const destination = path.resolve(root, file)
              if (!FSUtil.contains(root, destination) || destination === root) return undefined
              return {
                url: resource.href,
                destination,
                file,
              }
            })
            if (files.some((file) => file === undefined)) {
              return []
            }
            return [{ skill, root, versionFile, files: files as { url: string; destination: string; file: string }[] }]
          }),
          ({ skill, root, versionFile, files }) =>
            Effect.gen(function* () {
              const version = skill.version
              const current =
                version === undefined
                  ? undefined
                  : yield* fs.readFileStringSafe(versionFile).pipe(Effect.catch(() => Effect.succeed(undefined)))
              if (version === undefined || current === version) {
                yield* Effect.forEach(files, (file) => download(file.url, file.destination), {
                  concurrency: fileConcurrency,
                  discard: true,
                })
              } else {
                const token = crypto.randomUUID()
                const staging = `${root}.tmp-${token}`
                const backup = `${root}.old-${token}`
                yield* Effect.gen(function* () {
                  const downloaded = yield* Effect.forEach(
                    files,
                    (file) => download(file.url, path.resolve(staging, file.file)),
                    { concurrency: fileConcurrency },
                  )
                  if (!downloaded.every(Boolean)) return
                  const exists =
                    (yield* fs.exists(path.join(staging, "SKILL.md")).pipe(Effect.orDie)) ||
                    (yield* fs.exists(path.join(staging, `${skill.name}.md`)).pipe(Effect.orDie))
                  if (!exists) return
                  yield* fs.writeFileString(path.join(staging, ".novaclaw-version"), version)
                  yield* Effect.uninterruptible(
                    Effect.gen(function* () {
                      const cached = yield* fs.exists(root).pipe(Effect.orDie)
                      if (cached) yield* fs.rename(root, backup)
                      yield* fs.rename(staging, root).pipe(
                        Effect.catch((error) =>
                          Effect.gen(function* () {
                            if (cached) yield* fs.rename(backup, root).pipe(Effect.ignore)
                            return yield* Effect.fail(error)
                          }),
                        ),
                      )
                      if (cached) yield* fs.remove(backup, { recursive: true, force: true }).pipe(Effect.ignore)
                    }),
                  )
                }).pipe(
                  Effect.catch((error) =>
                    Log.event("skill.discovery.refresh.failed", {
                      "skill.name": skill.name,
                      "skill.error": Log.fault(error),
                    }),
                  ),
                  Effect.ensuring(fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)),
                )
              }
              const exists =
                (yield* fs.exists(path.join(root, "SKILL.md")).pipe(Effect.orDie)) ||
                (yield* fs.exists(path.join(root, `${skill.name}.md`)).pipe(Effect.orDie))
              return exists ? [AbsolutePath.make(root)] : []
            }),
          { concurrency: skillConcurrency },
        ).pipe(Effect.map((directories) => directories.flat()))
        // Named AFTER the walk: the flatMap above runs to completion while the array is built, so
        // `rejected` is already whole here. One line per dropped entry, so a refused traversal is
        // something the operator can actually see in the log.
        yield* Effect.forEach(
          rejected,
          (name) => Log.event("skill.index.entry.invalid", { "skill.url": index, "skill.name": name }),
          { discard: true },
        )
        return roots
      }),
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Global.defaultLayer),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [httpClient, FSUtil.node, Global.node] })
