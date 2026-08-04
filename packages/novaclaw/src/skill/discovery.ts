import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { httpClient, path } from "@novaclaw/core/effect/app-node-platform"
import { NodePath } from "@effect/platform-node"
import { Effect, Layer, Path, Schema, Context } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { withTransientReadRetry } from "@/util/effect-http-client"
import { Download } from "@novaclaw/core/download"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Global } from "@novaclaw/core/global"
import { Log } from "@novaclaw/schema/log"

const skillConcurrency = 4
const fileConcurrency = 8

class IndexSkill extends Schema.Class<IndexSkill>("IndexSkill")({
  name: Schema.String,
  files: Schema.Array(Schema.String),
  version: Schema.optional(Schema.String),
}) {}

class Index extends Schema.Class<Index>("Index")({
  skills: Schema.Array(IndexSkill),
}) {}

export interface Interface {
  readonly pull: (url: string) => Effect.Effect<string[]>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/SkillDiscovery") {}

export const layer: Layer.Layer<Service, never, FSUtil.Service | Path.Path | HttpClient.HttpClient> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const path = yield* Path.Path
    const client = yield* HttpClient.HttpClient
    const http = HttpClient.filterStatusOk(withTransientReadRetry(client))
    const cache = path.join(Global.Path.cache, "skills")

    const download = Effect.fn("Discovery.download")(function* (url: string, dest: string) {
      return yield* Download.toFile({ url, destination: dest, integrity: { transportOnly: true } }).pipe(
        Effect.provideService(FSUtil.Service, fs),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.as(true),
        Effect.catch((err) =>
          Log.event("skill.discovery.download.failed", {
            "skill.url": url,
            "skill.error": err instanceof Error ? err.message : String(err),
          }).pipe(Effect.as(false)),
        ),
      )
    })

    const pull = Effect.fn("Discovery.pull")(function* (url: string) {
      const base = url.endsWith("/") ? url : `${url}/`
      const index = new URL("index.json", base).href
      const host = base.slice(0, -1)

      yield* Log.event("skill.index.fetch", { "skill.url": index })

      const data = yield* HttpClientRequest.get(index).pipe(
        HttpClientRequest.acceptJson,
        http.execute,
        Effect.flatMap(HttpClientResponse.schemaBodyJson(Index)),
        Effect.catch((err) =>
          Log.event("skill.index.fetch.failed", {
            "skill.url": index,
            "skill.error": err instanceof Error ? err.message : String(err),
          }).pipe(Effect.as(null)),
        ),
      )

      if (!data) return []

      const missing = data.skills.filter((skill) => !skill.files.includes("SKILL.md"))
      yield* Effect.forEach(
        missing,
        (skill) => Log.event("skill.index.entry.invalid", { "skill.url": index, "skill.name": skill.name }),
        { discard: true },
      )
      const list = data.skills.filter((skill) => skill.files.includes("SKILL.md"))

      const dirs = yield* Effect.forEach(
        list,
        (skill) =>
          Effect.gen(function* () {
            const root = path.join(cache, skill.name)
            const versionFile = path.join(root, ".novaclaw-version")
            const version = skill.version
            const current =
              version === undefined
                ? undefined
                : yield* fs.readFileStringSafe(versionFile).pipe(Effect.catch(() => Effect.succeed(undefined)))

            if (version === undefined || current === version) {
              yield* Effect.forEach(
                skill.files,
                (file) => download(new URL(file, `${host}/${skill.name}/`).href, path.join(root, file)),
                { concurrency: fileConcurrency, discard: true },
              )
            } else {
              const token = crypto.randomUUID()
              const staging = `${root}.tmp-${token}`
              const backup = `${root}.old-${token}`
              yield* Effect.gen(function* () {
                const downloaded = yield* Effect.forEach(
                  skill.files,
                  (file) => download(new URL(file, `${host}/${skill.name}/`).href, path.join(staging, file)),
                  { concurrency: fileConcurrency },
                )
                if (!downloaded.every(Boolean)) return
                if (!(yield* fs.exists(path.join(staging, "SKILL.md")).pipe(Effect.orDie))) return
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
                    "skill.error": error instanceof Error ? error.message : String(error),
                  }),
                ),
                Effect.ensuring(fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)),
              )
            }
            return (yield* fs.exists(path.join(root, "SKILL.md")).pipe(Effect.orDie)) ? root : null
          }),
        { concurrency: skillConcurrency },
      )

      return dirs.filter((dir): dir is string => dir !== null)
    })

    return Service.of({ pull })
  }),
)

export const defaultLayer: Layer.Layer<Service> = layer.pipe(
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(NodePath.layer),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [FSUtil.node, path, httpClient] })

export * as Discovery from "./discovery"
