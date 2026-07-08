import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { httpClient } from "@novaclaw/core/effect/app-node-platform"
import { serviceUse } from "@novaclaw/core/effect/service-use"
import path from "path"
import { pathToFileURL } from "url"
import os from "os"
import { mergeDeep } from "remeda"
import { Global } from "@novaclaw/core/global"
import fsNode from "fs/promises"
import { Flag } from "@novaclaw/core/flag/flag"
import { Auth } from "../auth"
import { Env } from "../env"
import { applyEdits, modify } from "jsonc-parser"
import { InstallationLocal, InstallationVersion } from "@novaclaw/core/installation/version"
import { existsSync } from "fs"
import { Account } from "@/account/account"
import { isRecord } from "@/util/record"
import type { ConsoleState } from "@novaclaw/core/config/console-state"
import { FSUtil } from "@novaclaw/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { Context, Duration, Effect, Exit, Fiber, Layer, Option, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { EffectFlock } from "@novaclaw/core/util/effect-flock"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { Config as ConfigV2 } from "@novaclaw/core/config"
import { ConfigPermission } from "@novaclaw/core/config/permission"
import type { DeepMutable } from "@novaclaw/core/schema"
import { InvalidError, RemoteAuthError } from "@novaclaw/core/config/error"
import { ConfigPluginSpec } from "@novaclaw/core/config/plugin-spec"
import { ConfigAgent } from "./agent"
import { ConfigCommand } from "./command"
import { ConfigManaged } from "./managed"
import { ConfigParse } from "./parse"
import { ConfigPaths } from "./paths"
import { ConfigPlugin } from "./plugin"
import { ConfigVariable } from "./variable"
import { Npm } from "@novaclaw/core/npm"
import { withTransientReadRetry } from "@/util/effect-http-client"

// The `.well-known/novaclaw` payload shape: an inline `config` and/or a pointer to a `remote_config`.
const WellKnown = Schema.Struct({
  config: Schema.optional(Schema.Json),
  remote_config: Schema.optional(Schema.Json),
})

// Custom merge function that concatenates array fields instead of replacing them
// Keep remeda's deep conditional merge type out of hot config-loading paths; TS profiling showed it dominates here.
function mergeConfig(target: Info, source: Info): Info {
  return mergeDeep(target, source) as Info
}

function mergeConfigConcatArrays(target: Info, source: Info): Info {
  const merged = mergeConfig(target, source)
  if (target.instructions && source.instructions) {
    merged.instructions = Array.from(new Set([...target.instructions, ...source.instructions]))
  }
  // V2 `permissions` is an ordered Ruleset array (V1 spelled it as a per-key dict that mergeDeep
  // merged key-by-key). mergeDeep REPLACES arrays, which would silently drop earlier sources' rules,
  // so concat instead — general (target) first, more-specific (source) appended. This reproduces the
  // core V2 model (config/plugin/agent.ts flatMaps documents in the same general→specific order), so
  // the shared Permission.evaluate sees an identically-ordered ruleset. Rule objects aren't dedupable.
  if (target.permissions && source.permissions) {
    merged.permissions = [...target.permissions, ...source.permissions]
  }
  // V2 `skills` is a flat array (V1 spelled it `{paths,urls}`); concat + dedup like instructions.
  if (target.skills && source.skills) {
    merged.skills = Array.from(new Set([...target.skills, ...source.skills]))
  }
  return merged
}

function normalizeLoadedConfig(data: unknown) {
  if (!isRecord(data)) return data
  const copy = { ...data }
  const hadLegacy = "theme" in copy || "keybinds" in copy || "tui" in copy || "lsp" in copy
  if (!hadLegacy) return copy
  delete copy.theme
  delete copy.keybinds
  delete copy.tui
  delete copy.lsp
  return copy
}

// Validate one already-parsed config source as V2 `Config.Info` and return it as a plain record. Every
// source is authored directly as V2 now (the whole-config V1→V2 migrator was retired in F1-config).
// Reject unknown top-level keys — a typo'd `permision`/`modell` silently ignored would be a real
// footgun. `ConfigParse.schema` can't do this for `Config.Info` because its extra-key guard only fires
// for plain-object schemas, not a Schema.Class.
function loadAsV2(parsed: unknown, source: string): Info {
  if (isRecord(parsed)) {
    const known = new Set(Object.keys(ConfigV2.Info.fields))
    const extra = Object.keys(parsed).filter((key) => !known.has(key))
    if (extra.length) {
      throw new InvalidError({
        path: source,
        issues: [
          {
            code: "unrecognized_keys",
            keys: extra,
            path: [],
            message: `Unrecognized key${extra.length === 1 ? "" : "s"}: ${extra.join(", ")}`,
          },
        ],
      })
    }
  }
  ConfigParse.schema(ConfigV2.Info, parsed, source) // validate a natively-authored V2 source
  return parsed as Info
}

async function substituteWellKnownRemoteConfig(input: {
  value: unknown
  dir: string
  source: string
  env: Record<string, string>
}) {
  if (!isRecord(input.value) || typeof input.value.url !== "string") return undefined

  const url = await ConfigVariable.substitute({
    text: input.value.url,
    type: "virtual",
    dir: input.dir,
    source: input.source,
    env: input.env,
  })
  const headers = isRecord(input.value.headers)
    ? Object.fromEntries(
        await Promise.all(
          Object.entries(input.value.headers)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string")
            .map(async ([key, value]) => [
              key,
              await ConfigVariable.substitute({
                text: value,
                type: "virtual",
                dir: input.dir,
                source: input.source,
                env: input.env,
              }),
            ]),
        ),
      )
    : undefined

  return { url, headers }
}

async function resolveLoadedPlugins(config: Info, filepath: string) {
  if (!config.plugins) return config
  for (let i = 0; i < config.plugins.length; i++) {
    // Normalize path-like plugin specs while we still know which config file declared them.
    // This prevents `./plugin.ts` from being reinterpreted relative to some later merge location.
    // Resolve in the V1 `Spec` domain the resolver understands, then convert back to a V2 entry.
    config.plugins[i] = specToEntry(await ConfigPlugin.resolvePluginSpec(entryToSpec(config.plugins[i]), filepath))
  }
  return config
}

// The service authors + serves V2 `Config.Info` shapes. Internally it MUTATES a merged accumulator
// (mergeDeep + field assignments), so the working type is a deep-mutable V2 Info. Every config source —
// jsonc files AND markdown-agent frontmatter — is authored directly as V2 (the V1 config migrator was
// retired in F1-config; no on-read migration remains).
export type Info = DeepMutable<typeof ConfigV2.Info.Type> & {
  // plugin_origins is derived state, not a persisted config field. It keeps each winning plugin spec together
  // with the file and scope it came from so later runtime code can make location-sensitive decisions.
  // Kept in the resolver `Spec` shape (a tuple/string) that the plugin loader (`plugin/index.ts`) consumes;
  // the persisted `plugins` (V2 entries) is derived from it.
  plugin_origins?: ConfigPlugin.Origin[]
}

// V2 plugin entry shape (mirror of core `ConfigPlugin.Plugin`, kept local to avoid the name clash with
// this package's `ConfigPlugin` origin helpers).
type PluginEntry = string | { package: string; options?: Record<string, unknown> }

function specToEntry(spec: ConfigPluginSpec.Spec): PluginEntry {
  return Array.isArray(spec) ? { package: spec[0], ...(spec[1] ? { options: spec[1] } : {}) } : spec
}

function entryToSpec(entry: PluginEntry): ConfigPluginSpec.Spec {
  if (typeof entry === "string") return entry
  return entry.options ? [entry.package, entry.options] : entry.package
}

// Dir-discovered agents (`{agent,agents,mode,modes}/**/*.md`) already parse as canonical V2
// `ConfigAgent.Info`; strip undefined fields (JSON round-trip) so they deep-merge cleanly into the V2
// `result.agents` record instead of overwriting siblings with `undefined`.
function dirAgents(record: Awaited<ReturnType<typeof ConfigAgent.load>>): NonNullable<Info["agents"]> {
  return JSON.parse(JSON.stringify(record))
}

type State = {
  config: Info
  directories: string[]
  deps: Fiber.Fiber<void>[]
  consoleState: ConsoleState
}

export interface Interface {
  readonly get: () => Effect.Effect<Info>
  readonly getGlobal: () => Effect.Effect<Info>
  readonly getConsoleState: () => Effect.Effect<ConsoleState>
  readonly update: (config: Info) => Effect.Effect<void>
  readonly updateGlobal: (config: Info) => Effect.Effect<{ info: Info; changed: boolean }>
  readonly invalidate: () => Effect.Effect<void>
  readonly directories: () => Effect.Effect<string[]>
  readonly waitForDependencies: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/Config") {}

export const use = serviceUse(Service)

function globalConfigFile() {
  const candidates = ["novaclaw.jsonc", "novaclaw.json", "config.json"].map((file) =>
    path.join(Global.Path.config, file),
  )
  for (const file of candidates) {
    if (existsSync(file)) return file
  }
  return candidates[0]
}

function patchJsonc(input: string, patch: unknown, path: string[] = []): string {
  if (!isRecord(patch)) {
    const edits = modify(input, path, patch, {
      formattingOptions: {
        insertSpaces: true,
        tabSize: 2,
      },
    })
    return applyEdits(input, edits)
  }

  return Object.entries(patch).reduce((result, [key, value]) => patchJsonc(result, value, [...path, key]), input)
}

function writable(info: Info) {
  const { plugin_origins: _plugin_origins, ...next } = info
  return next
}

function writableGlobal(info: Info) {
  const next = writable(info)
  // When a user changes config from a value back to default in the Desktop app, we don't want to leave a blank `"shell": "",` key
  if ("shell" in next && next.shell === "") return { ...next, shell: undefined }
  return next
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const authSvc = yield* Auth.Service
    const accountSvc = yield* Account.Service
    const env = yield* Env.Service
    const npmSvc = yield* Npm.Service
    const http = yield* HttpClient.HttpClient

    const readConfigFile = (filepath: string) => fs.readFileStringSafe(filepath).pipe(Effect.orDie)

    const fetchRemoteJson = Effect.fnUntraced(function* <S extends Schema.Top>(
      url: string,
      headers: Record<string, string> | undefined,
      schema: S,
      loginOrigin: string,
    ) {
      const response = yield* HttpClient.filterStatusOk(withTransientReadRetry(http))
        .execute(
          HttpClientRequest.get(url).pipe(HttpClientRequest.acceptJson, HttpClientRequest.setHeaders(headers ?? {})),
        )
        .pipe(
          Effect.catch((error) => Effect.die(new Error(`failed to fetch remote config from ${url}: ${String(error)}`))),
        )
      const body = yield* response.text.pipe(
        Effect.catch((error) => Effect.die(new Error(`failed to read remote config from ${url}: ${String(error)}`))),
      )
      // An auth proxy can answer with an HTML login page at HTTP 200 (passes filterStatusOk); treat it as a re-auth error, not a decode failure.
      const contentType = (response.headers["content-type"] ?? "").toLowerCase()
      if (contentType.includes("html") || /^\s*<!doctype|^\s*<html/i.test(body)) {
        return yield* Effect.die(new RemoteAuthError({ url: loginOrigin, remote: url }))
      }
      return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(body).pipe(
        Effect.catch((error) => Effect.die(new Error(`failed to decode remote config from ${url}: ${String(error)}`))),
      )
    })

    const loadConfig = Effect.fnUntraced(function* (
      text: string,
      options: { path: string } | { dir: string; source: string },
      env?: Record<string, string>,
    ) {
      const source = "path" in options ? options.path : options.source
      const expanded = yield* Effect.promise(() =>
        ConfigVariable.substitute(
          "path" in options
            ? { text, type: "path", path: options.path, env }
            : { text, type: "virtual", ...options, env },
        ),
      )
      const parsed = normalizeLoadedConfig(ConfigParse.jsonc(expanded, source))
      const data = loadAsV2(parsed, source)
      if (!("path" in options)) return data

      yield* Effect.promise(() => resolveLoadedPlugins(data, options.path))
      if (!data.$schema) {
        data.$schema = "https://novaclaw.app/config.json"
        const updated = text.replace(/^\s*\{/, '{\n  "$schema": "https://novaclaw.app/config.json",')
        yield* fs.writeFileString(options.path, updated).pipe(Effect.catch(() => Effect.void))
      }
      return data
    })

    const loadFile = Effect.fnUntraced(function* (filepath: string, env?: Record<string, string>) {
      yield* Effect.logInfo("loading", { path: filepath })
      const text = yield* readConfigFile(filepath)
      if (!text) return {} as Info
      return yield* loadConfig(text, { path: filepath }, env)
    })

    const loadGlobal = Effect.fnUntraced(function* (env?: Record<string, string>) {
      let result: Info = {}
      // Seed the default global config with the schema for editor completion, but avoid writing when the user
      // explicitly routes config through env-provided paths or content.
      if (!Flag.NOVACLAW_CONFIG && !Flag.NOVACLAW_CONFIG_DIR && !Flag.NOVACLAW_CONFIG_CONTENT) {
        const file = globalConfigFile()
        if (!existsSync(file)) {
          yield* fs
            .writeWithDirs(file, JSON.stringify({ $schema: "https://novaclaw.app/config.json" }, null, 2))
            .pipe(Effect.catch(() => Effect.void))
        }
      }
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "config.json"), env))
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "novaclaw.json"), env))
      result = mergeConfig(result, yield* loadFile(path.join(Global.Path.config, "novaclaw.jsonc"), env))

      const legacy = path.join(Global.Path.config, "config")
      if (existsSync(legacy)) {
        yield* Effect.promise(() =>
          import(pathToFileURL(legacy).href, { with: { type: "toml" } })
            .then(async (mod) => {
              const { provider, model, ...rest } = mod.default
              if (provider && model) result.model = `${provider}/${model}`
              result["$schema"] = "https://novaclaw.app/config.json"
              result = mergeConfig(result, rest)
              await fsNode.writeFile(path.join(Global.Path.config, "config.json"), JSON.stringify(result, null, 2))
              await fsNode.unlink(legacy)
            })
            .catch(() => {}),
        )
      }

      return result
    })

    const [cachedGlobal, invalidateGlobal] = yield* Effect.cachedInvalidateWithTTL(
      loadGlobal().pipe(
        Effect.tapError((error) =>
          Effect.logError("failed to load global config, using defaults", { error: String(error) }),
        ),
        Effect.orElseSucceed((): Info => ({})),
      ),
      Duration.infinity,
    )

    const getGlobal = Effect.fn("Config.getGlobal")(function* () {
      return yield* cachedGlobal
    })

    const ensureGitignore = Effect.fn("Config.ensureGitignore")(function* (dir: string) {
      const gitignore = path.join(dir, ".gitignore")
      const hasIgnore = yield* fs.existsSafe(gitignore)
      if (!hasIgnore) {
        yield* fs
          .writeFileString(
            gitignore,
            ["node_modules", "package.json", "package-lock.json", "bun.lock", ".gitignore"].join("\n"),
          )
          .pipe(
            Effect.catchIf(
              (e) => e.reason._tag === "PermissionDenied",
              () => Effect.void,
            ),
          )
      }
    })

    const loadInstanceState = Effect.fn("Config.loadInstanceState")(
      function* (ctx: InstanceContext) {
        const auth = yield* authSvc.all().pipe(Effect.orDie)

        let result: Info = {}
        const authEnv: Record<string, string> = {}
        const consoleManagedProviders = new Set<string>()
        let activeOrgName: string | undefined

        const pluginScopeForSource = Effect.fnUntraced(function* (source: string) {
          if (source.startsWith("http://") || source.startsWith("https://")) return "global"
          if (source === "NOVACLAW_CONFIG_CONTENT") return "local"
          if (containsPath(source, ctx)) return "local"
          return "global"
        })

        const mergePluginOrigins = Effect.fnUntraced(function* (
          source: string,
          // Receives the V2 `plugins` entries from one config source (or already-normalized Specs from
          // the dir loader — plain file-URL strings, which are valid entries), before provenance for this
          // merge step is attached. Converted into the V1 `Spec` shape the origin dedup + downstream
          // plugin loader (`plugin/index.ts`) consume; `plugin_origins` stays Spec-shaped on purpose.
          list: PluginEntry[] | undefined,
          // Scope can be inferred from the source path, but some callers already know whether the config should
          // behave as global or local and can pass that explicitly.
          kind?: ConfigPlugin.Scope,
        ) {
          if (!list?.length) return
          const hit = kind ?? (yield* pluginScopeForSource(source))
          // Merge newly seen plugin origins with previously collected ones, then dedupe by plugin identity while
          // keeping the winning source/scope metadata for downstream installs, writes, and diagnostics.
          const plugins = ConfigPlugin.deduplicatePluginOrigins([
            ...(result.plugin_origins ?? []),
            ...list.map((entry) => ({ spec: entryToSpec(entry), source, scope: hit })),
          ])
          result.plugins = plugins.map((item) => specToEntry(item.spec))
          result.plugin_origins = plugins
        })

        const merge = (source: string, next: Info, kind?: ConfigPlugin.Scope) => {
          result = mergeConfigConcatArrays(result, next)
          return mergePluginOrigins(source, next.plugins, kind)
        }

        for (const [key, value] of Object.entries(auth)) {
          if (value.type === "wellknown") {
            const url = key.replace(/\/+$/, "")
            authEnv[value.key] = value.token
            const wellknownURL = `${url}/.well-known/novaclaw`
            yield* Effect.logDebug("fetching remote config", { url: wellknownURL })
            const wellknown = yield* fetchRemoteJson(wellknownURL, undefined, WellKnown, url)
            const remote = yield* Effect.promise(() =>
              substituteWellKnownRemoteConfig({
                value: wellknown.remote_config,
                dir: url,
                source: wellknownURL,
                env: authEnv,
              }),
            )
            const fetchedConfig = remote
              ? yield* Effect.gen(function* () {
                  yield* Effect.logDebug("fetching remote config", { url: remote.url })
                  const data = yield* fetchRemoteJson(remote.url, remote.headers, Schema.Json, url)
                  if (isRecord(data) && isRecord(data.config)) return data.config
                  if (isRecord(data)) return data
                  return yield* Effect.die(
                    new Error(`failed to decode remote config from ${remote.url}: expected object`),
                  )
                })
              : {}
            const remoteConfig = mergeConfig(isRecord(wellknown.config) ? wellknown.config : {}, fetchedConfig)
            if (!remoteConfig.$schema) remoteConfig.$schema = "https://novaclaw.app/config.json"
            const source = wellknownURL
            const next = yield* loadConfig(
              JSON.stringify(remoteConfig),
              {
                dir: path.dirname(source),
                source,
              },
              authEnv,
            )
            yield* merge(source, next, "global")
            yield* Effect.logDebug("loaded remote config from well-known", { url })
          }
        }

        const global = Object.keys(authEnv).length ? yield* loadGlobal(authEnv) : yield* getGlobal()
        yield* merge(Global.Path.config, global, "global")

        if (Flag.NOVACLAW_CONFIG) {
          yield* merge(Flag.NOVACLAW_CONFIG, yield* loadFile(Flag.NOVACLAW_CONFIG, authEnv))
          yield* Effect.logDebug("loaded custom config", { path: Flag.NOVACLAW_CONFIG })
        }

        if (!Flag.NOVACLAW_DISABLE_PROJECT_CONFIG) {
          for (const file of yield* ConfigPaths.files("novaclaw", ctx.directory, ctx.worktree).pipe(Effect.orDie)) {
            yield* merge(file, yield* loadFile(file, authEnv), "local")
          }
        }

        result.agents = result.agents || {}
        result.plugins = result.plugins || []

        const directories = yield* ConfigPaths.directories(ctx.directory, ctx.worktree)

        if (Flag.NOVACLAW_CONFIG_DIR) {
          yield* Effect.logDebug("loading config from NOVACLAW_CONFIG_DIR", { path: Flag.NOVACLAW_CONFIG_DIR })
        }

        const deps: Fiber.Fiber<void>[] = []

        for (const dir of directories) {
          if (dir.endsWith(".novaclaw") || dir === Flag.NOVACLAW_CONFIG_DIR) {
            for (const file of ["novaclaw.json", "novaclaw.jsonc"]) {
              const source = path.join(dir, file)
              yield* Effect.logDebug(`loading config from ${source}`)
              yield* merge(source, yield* loadFile(source, authEnv))
              result.agents ??= {}
              result.plugins ??= []
            }
          }

          yield* ensureGitignore(dir).pipe(Effect.orDie)

          // Opt-in only (Flag doc): `@novaclaw/plugin` is not on npm, so this
          // background install 404'd at every boot since the rename — pure noise
          // + startup egress. Type-only plugin imports never needed it.
          if (Flag.NOVACLAW_INSTALL_PLUGIN_TYPES) {
            const dep = yield* npmSvc
              .install(dir, {
                add: [
                  {
                    name: "@novaclaw/plugin",
                    version: InstallationLocal ? undefined : InstallationVersion,
                  },
                ],
              })
              .pipe(
                Effect.exit,
                Effect.tap((exit) =>
                  Exit.isFailure(exit)
                    ? Effect.logWarning("background dependency install failed", { dir, error: String(exit.cause) })
                    : Effect.void,
                ),
                Effect.asVoid,
                Effect.forkDetach,
              )
            deps.push(dep)
          }

          // ConfigCommand.load returns V1 command shapes that are identical to V2 ConfigCommand.Info.
          result.commands = mergeDeep(result.commands ?? {}, yield* Effect.promise(() => ConfigCommand.load(dir)))
          result.agents = mergeDeep(
            result.agents ?? {},
            dirAgents(yield* Effect.promise(() => ConfigAgent.load(dir))),
          )
          // loadMode already tags each agent `mode: "primary"`; migrateAgent preserves it.
          result.agents = mergeDeep(
            result.agents ?? {},
            dirAgents(yield* Effect.promise(() => ConfigAgent.loadMode(dir))),
          )
          // Auto-discovered plugins under `.novaclaw/plugin(s)` are already local files, so ConfigPlugin.load
          // returns normalized Specs (plain file-URL strings) and we only need to attach origin metadata here.
          const list = yield* Effect.promise(() => ConfigPlugin.load(dir))
          yield* mergePluginOrigins(dir, list.map(specToEntry))
        }

        if (process.env.NOVACLAW_CONFIG_CONTENT) {
          const source = "NOVACLAW_CONFIG_CONTENT"
          const next = yield* loadConfig(process.env.NOVACLAW_CONFIG_CONTENT, {
            dir: ctx.directory,
            source,
          })
          yield* merge(source, next, "local")
          yield* Effect.logDebug("loaded custom config from NOVACLAW_CONFIG_CONTENT")
        }

        const activeAccount = Option.getOrUndefined(
          yield* accountSvc.active().pipe(Effect.catch(() => Effect.succeed(Option.none()))),
        )
        if (activeAccount?.active_org_id) {
          const accountID = activeAccount.id
          const orgID = activeAccount.active_org_id
          const url = activeAccount.url
          yield* Effect.gen(function* () {
            const [configOpt, tokenOpt] = yield* Effect.all(
              [accountSvc.config(accountID, orgID), accountSvc.token(accountID)],
              { concurrency: 2 },
            )
            if (Option.isSome(tokenOpt)) {
              process.env["NOVACLAW_CONSOLE_TOKEN"] = tokenOpt.value
              yield* env.set("NOVACLAW_CONSOLE_TOKEN", tokenOpt.value)
            }

            if (Option.isSome(configOpt)) {
              const source = `${url}/api/config`
              const next = yield* loadConfig(JSON.stringify(configOpt.value), {
                dir: path.dirname(source),
                source,
              })
              for (const providerID of Object.keys(next.providers ?? {})) {
                consoleManagedProviders.add(providerID)
              }
              yield* merge(source, next, "global")
            }
          }).pipe(
            Effect.withSpan("Config.loadActiveOrgConfig"),
            Effect.catch((err) =>
              Effect.logDebug("failed to fetch remote account config", {
                error: err instanceof Error ? err.message : String(err),
              }),
            ),
          )
        }

        const managedDir = ConfigManaged.managedConfigDir()
        if (existsSync(managedDir)) {
          for (const file of ["novaclaw.json", "novaclaw.jsonc"]) {
            const source = path.join(managedDir, file)
            yield* merge(source, yield* loadFile(source), "global")
          }
        }

        // macOS managed preferences (.mobileconfig deployed via MDM) override everything
        const managed = yield* Effect.promise(() => ConfigManaged.readManagedPreferences())
        if (managed) {
          result = mergeConfigConcatArrays(
            result,
            yield* loadConfig(managed.text, {
              dir: path.dirname(managed.source),
              source: managed.source,
            }),
          )
        }

        // F1d: the V1 `mode`→`agent` and `tools`→`permission` fold-ups are gone — `migrate()` performs
        // both per-source (V2 `agents`/`permissions`) as each source is loaded, and neither `mode` nor
        // `tools` exists on a V2 result.

        if (Flag.NOVACLAW_PERMISSION) {
          try {
            // A V1-shaped permission dict on the env; migrate it to a V2 Ruleset and append — the env is
            // the most-specific source, so its rules come last (see mergeConfigConcatArrays ordering).
            const rules = ConfigPermission.ruleset(JSON.parse(Flag.NOVACLAW_PERMISSION))
            if (rules?.length) result.permissions = [...(result.permissions ?? []), ...rules]
          } catch (err) {
            yield* Effect.logWarning("NOVACLAW_PERMISSION contains invalid JSON, skipping", { err })
          }
        }

        if (!result.username) {
          try {
            result.username = os.userInfo().username || "user"
          } catch (err) {
            yield* Effect.logWarning("failed to read system username, using fallback", { err })
            result.username = "user"
          }
        }

        if (Flag.NOVACLAW_DISABLE_AUTOCOMPACT) {
          result.compaction = { ...result.compaction, auto: false }
        }
        if (Flag.NOVACLAW_DISABLE_PRUNE) {
          result.compaction = { ...result.compaction, prune: false }
        }

        return {
          config: result,
          directories,
          deps,
          consoleState: {
            consoleManagedProviders: Array.from(consoleManagedProviders),
            activeOrgName,
            switchableOrgCount: 0,
          },
        }
      },
      Effect.provideService(FSUtil.Service, fs),
    )

    const state = yield* InstanceState.make<State>(
      Effect.fn("Config.state")(function* (ctx) {
        return yield* loadInstanceState(ctx).pipe(Effect.orDie)
      }),
    )

    const get = Effect.fn("Config.get")(function* () {
      return yield* InstanceState.use(state, (s) => s.config)
    })

    const directories = Effect.fn("Config.directories")(function* () {
      return yield* InstanceState.use(state, (s) => s.directories)
    })

    const getConsoleState = Effect.fn("Config.getConsoleState")(function* () {
      return yield* InstanceState.use(state, (s) => s.consoleState)
    })

    const waitForDependencies = Effect.fn("Config.waitForDependencies")(function* () {
      yield* InstanceState.useEffect(state, (s) =>
        Effect.forEach(s.deps, Fiber.join, { concurrency: "unbounded" }).pipe(Effect.asVoid),
      )
    })

    const update = Effect.fn("Config.update")(function* (config: Info) {
      const dir = yield* InstanceState.directory
      const file = path.join(dir, "config.json")
      const existing = yield* loadFile(file)
      yield* fs
        .writeFileString(file, JSON.stringify(mergeDeep(writable(existing), writable(config)), null, 2))
        .pipe(Effect.orDie)
    })

    const invalidate = Effect.fn("Config.invalidate")(function* () {
      yield* invalidateGlobal
    })

    const updateGlobal = Effect.fn("Config.updateGlobal")(function* (config: Info) {
      const file = globalConfigFile()
      const before = (yield* readConfigFile(file)) ?? "{}"
      const patch = writableGlobal(config)

      let next: Info
      let changed: boolean
      const parsedBefore = ConfigParse.jsonc(before, file)
      // A plain `.json` file is rewritten wholesale; a `.jsonc` is patched in place so comments and
      // formatting survive. Every source is authored as V2 now, so patching V2 keys always stays V2.
      if (!file.endsWith(".jsonc")) {
        const existing = loadAsV2(parsedBefore, file)
        const merged = mergeDeep(writable(existing), patch)
        const serialized = JSON.stringify(merged, null, 2)
        changed = serialized !== before
        if (changed) yield* fs.writeFileString(file, serialized).pipe(Effect.orDie)
        next = merged
      } else {
        const updated = patchJsonc(before, patch)
        next = loadAsV2(ConfigParse.jsonc(updated, file), file)
        changed = updated !== before
        if (changed) yield* fs.writeFileString(file, updated).pipe(Effect.orDie)
      }

      if (changed) yield* invalidate()
      return { info: next, changed }
    })

    return Service.of({
      get,
      getGlobal,
      getConsoleState,
      update,
      updateGlobal,
      invalidate,
      directories,
      waitForDependencies,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Account.defaultLayer),
  Layer.provide(Npm.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [FSUtil.node, Auth.node, Account.node, Env.node, Npm.node, httpClient],
})

export * as Config from "./config"
