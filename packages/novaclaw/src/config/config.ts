import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { httpClient } from "@novaclaw/core/effect/app-node-platform"
import { serviceUse } from "@novaclaw/core/effect/service-use"
import path from "path"
import os from "os"
import { mergeDeep } from "remeda"
import { Global } from "@novaclaw/core/global"
import { Flag } from "@novaclaw/core/flag/flag"
import { Auth } from "../auth"
import { InstallationLocal, InstallationVersion } from "@novaclaw/core/installation/version"
import { existsSync } from "fs"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { CommandConfigStore } from "@novaclaw/core/command-config-store"
import { ConfigSeedStartup } from "@novaclaw/core/config-seed-startup"
import { ConfigStoreWrite } from "@novaclaw/core/config-store-write"
import { PluginConfigStore } from "@novaclaw/core/plugin-config-store"
import { ReferenceConfigStore } from "@novaclaw/core/reference-config-store"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { SkillConfigStore } from "@novaclaw/core/skill-config-store"
import { isRecord } from "@/util/record"
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
import { errorFormat } from "@/util/error"
import { Log } from "@novaclaw/schema/log"

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
  // plugin_origins is derived state, not a persisted config field, and it never reaches the wire — the
  // `/config` handlers decode through `ConfigV2.Info`, which has no such key. It exists so the merge can
  // dedupe by plugin identity while remembering which config file won and at which scope; `plugins` (the
  // persisted V2 entries the loader actually reads) is its projection. Kept in the resolver `Spec` shape
  // because that is what `ConfigPlugin.deduplicatePluginOrigins` operates on. (It used to be read directly
  // by the V1 loader, `plugin/index.ts`; that arm is deleted — this is now purely a merge accumulator.)
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
}

// Config→SQLite step 9: `update`/`updateGlobal` are gone — every write routes through
// `ConfigStoreWrite.apply` (the HTTP handlers call it directly), and there is no jsonc file
// to patch. `invalidate` remains so a store write can refresh the cached global view.
export interface Interface {
  readonly get: () => Effect.Effect<Info>
  readonly getGlobal: () => Effect.Effect<Info>
  readonly invalidate: () => Effect.Effect<void>
  readonly directories: () => Effect.Effect<string[]>
  readonly waitForDependencies: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/Config") {}

export const use = serviceUse(Service)

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const authSvc = yield* Auth.Service
    const npmSvc = yield* Npm.Service
    const http = yield* HttpClient.HttpClient

    // Config→SQLite step 9: the per-subsystem stores ARE the config source. Capture them once
    // so the Interface methods (R = never) can run store-requiring effects (overlay + seeds).
    const agentStore = yield* AgentConfigStore.Service
    const catalogStore = yield* CatalogStore.Service
    const commandStore = yield* CommandConfigStore.Service
    const pluginStore = yield* PluginConfigStore.Service
    const referenceStore = yield* ReferenceConfigStore.Service
    const settingsStore = yield* SettingsConfigStore.Service
    const skillStore = yield* SkillConfigStore.Service
    const provideStores = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(AgentConfigStore.Service, agentStore),
        Effect.provideService(CatalogStore.Service, catalogStore),
        Effect.provideService(CommandConfigStore.Service, commandStore),
        Effect.provideService(PluginConfigStore.Service, pluginStore),
        Effect.provideService(ReferenceConfigStore.Service, referenceStore),
        Effect.provideService(SettingsConfigStore.Service, settingsStore),
        Effect.provideService(SkillConfigStore.Service, skillStore),
        Effect.provideService(FSUtil.Service, fs),
      )

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
      yield* Log.event("config.file.load", { path: filepath })
      const text = yield* readConfigFile(filepath)
      if (!text) return {} as Info
      return yield* loadConfig(text, { path: filepath }, env)
    })

    // Config→SQLite step 9: the global view IS the store overlay — ONE V2 document assembled
    // from the per-subsystem SQLite stores (`ConfigStoreWrite.overlay` over an empty base = the
    // export document). The first read runs the idempotent first-boot IMPORT (isEmpty-gated
    // seeds over global dir + launch dir + NOVACLAW_CONFIG_CONTENT), so a fresh install picks
    // up existing jsonc on ANY entry point (serve, run, debug config, providers) — after that,
    // no jsonc file is ever read for resolution.
    const loadStores = Effect.fnUntraced(function* () {
      // Global.Path statics read at CALL time (the historical loadGlobal contract) — the
      // server's startup seed separately honors NOVACLAW_CONFIG_DIR via Global.Service.
      yield* provideStores(ConfigSeedStartup.seedAll(Global.Path.config, Global.Path.home))
      const doc = yield* provideStores(ConfigStoreWrite.overlay({}))
      return loadAsV2(doc, "sqlite-stores")
    })

    const [cachedGlobal, invalidateGlobal] = yield* Effect.cachedInvalidateWithTTL(
      loadStores().pipe(
        Effect.tapError((error) => Log.event("config.global.load.failed", { "config.cause": String(error) })),
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
          // merge step is attached. Converted into the resolver `Spec` shape the origin dedup consumes;
          // `plugin_origins` stays Spec-shaped on purpose and `result.plugins` is projected back from it.
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
            yield* Log.event("config.remote.fetch", { "config.url": wellknownURL })
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
                  yield* Log.event("config.remote.fetch", { "config.url": remote.url })
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
            yield* Log.event("config.remote.load.ok", { "config.url": url })
          }
        }

        // Config→SQLite step 9: the store-backed document replaces every file-borne source —
        // the global candidates AND the project jsonc walk (settings are instance-wide by
        // design; per-directory divergence lives in the D2 markdown/dir resources below).
        // `authEnv` still feeds the REMOTE sources' variable substitution above; store values
        // are served as imported (provider env resolution happens at runtime in the catalog
        // integration transform, not here).
        const stored = yield* getGlobal()
        yield* merge("sqlite-stores", stored, "global")

        result.agents = result.agents || {}
        result.plugins = result.plugins || []

        const directories = yield* ConfigPaths.directories(ctx.directory, ctx.worktree)

        if (Flag.NOVACLAW_CONFIG_DIR) {
          yield* Log.event("config.directory.load", { "config.directory": Flag.NOVACLAW_CONFIG_DIR })
        }

        const deps: Fiber.Fiber<void>[] = []

        for (const dir of directories) {
          yield* ensureGitignore(dir).pipe(Effect.orDie)

          // Opt-in only (Flag doc): `@novaclaw/plugin` is not on npm, so this
          // background install 404'd at every boot since the rename — pure noise
          // + startup egress. Type-only plugin imports never needed it.
          //
          // ⚠️ FIRE-AND-FORGET, deliberately — nothing joins these fibers in production, and that
          // is the decision, not an oversight. The V1 plugin loader used to `waitForDependencies()`
          // before importing plugin files, because a plugin could import `@novaclaw/plugin` at
          // runtime; the loader that replaced it lives in core
          // (`core/src/config/plugin/external.ts`) and forks its own work. What this install writes
          // is EDITOR ergonomics for someone authoring a plugin file — no code path in the process
          // reads it — so joining it would only trade startup latency (first-class, per todo.md)
          // for a 404 we already log below. Re-open this ONLY if `@novaclaw/plugin` becomes a
          // runtime import target that must resolve before external plugins load; then the join
          // belongs at the external loader, not at boot.
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
                    ? Log.event("config.dependency.install.failed", {
                        "config.directory": dir,
                        "config.cause": String(exit.cause),
                      })
                    : Effect.void,
                ),
                Effect.asVoid,
                Effect.forkDetach,
              )
            deps.push(dep)
          }

          // ConfigCommand.load returns V1 command shapes that are identical to V2 ConfigCommand.Info.
          result.commands = mergeDeep(result.commands ?? {}, yield* Effect.promise(() => ConfigCommand.load(dir)))
          result.agents = mergeDeep(result.agents ?? {}, dirAgents(yield* Effect.promise(() => ConfigAgent.load(dir))))
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
          yield* Log.event("config.content.load", {})
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
            yield* Log.event("config.permission.parse.failed", { "config.cause": errorFormat(err) })
          }
        }

        if (!result.username) {
          try {
            result.username = os.userInfo().username || "user"
          } catch (err) {
            yield* Log.event("config.username.read.failed", { "config.cause": errorFormat(err) })
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
        }
      },
      Effect.provideService(FSUtil.Service, fs),
    )

    // ─── v0.2.0-prep B7 tier-3 / ruling 3 — *a settings change is not a reboot* ───────────────────
    //
    // ⚠️ THIS is the cache the four "still needs a restart" keys were actually stuck behind, and it
    // is one level below where the tier-2 note looked for them. Every novaclaw service reads its
    // config through `Config.get()`, which is this per-instance-directory `InstanceState` holding the
    // fully merged document (stores overlay + dir-discovered markdown + managed MDM + remote
    // well-known + env). `invalidate()` below clears only the process-global store view; nothing ever
    // replaced THIS. So `snapshots` — which `snapshot/index.ts:170` already re-reads on every call,
    // i.e. a key that looked read-through — was stale anyway, because the document it reads from was.
    //
    // `makeRematerializable` rather than `make` is a declaration with teeth: re-running this
    // initializer closes the superseded entry's scope, and this one owns nothing it would destroy
    // (the only fibers it forks are `forkDetach`ed by design, so they are not scope-owned). `MCP.state`
    // deliberately does not carry that marker — see `effect/instance-state.ts`.
    const state = yield* InstanceState.makeRematerializable<State>(
      Effect.fn("Config.state")(function* (ctx) {
        return yield* loadInstanceState(ctx).pipe(Effect.orDie)
      }),
    )

    // Registered for the life of THIS layer's scope, so a torn-down instance graph deregisters and a
    // stale closure never fans out on a later write. Fired from `ConfigStoreWrite.apply` — the one
    // place a config write commits — and FIRST among the reload domains, because `format/index.ts`
    // and `mcp/index.ts` reconcile against the document this rebuilds.
    //
    // ⚠️ The global view is invalidated BEFORE the rematerialise, not after: `loadInstanceState`
    // merges `getGlobal()` into the document it builds, and that view is
    // `Effect.cachedInvalidateWithTTL(…, Duration.infinity)`. Rebuilding first would fold the
    // pre-write stores back in and leave the document looking refreshed while carrying the old value
    // — a reload that reports success for a change that is not live, which is the ruling-2 shape this
    // whole tier exists to remove.
    yield* ConfigStoreWrite.registerReload("instance_config", () =>
      Effect.gen(function* () {
        yield* invalidateGlobal
        yield* InstanceState.rematerializeAll(state)
      }),
    )

    const get = Effect.fn("Config.get")(function* () {
      return yield* InstanceState.use(state, (s) => s.config)
    })

    const directories = Effect.fn("Config.directories")(function* () {
      return yield* InstanceState.use(state, (s) => s.directories)
    })

    // The ONLY handle on the detached `NOVACLAW_INSTALL_PLUGIN_TYPES` install fibers (see the fork
    // site above for why nothing joins them on the boot path). Kept because a detached fiber with
    // no join point cannot be observed at all — this is what makes the flag's behaviour assertable
    // — not because a caller is pending.
    const waitForDependencies = Effect.fn("Config.waitForDependencies")(function* () {
      yield* InstanceState.useEffect(state, (s) =>
        Effect.forEach(s.deps, Fiber.join, { concurrency: "unbounded" }).pipe(Effect.asVoid),
      )
    })

    const invalidate = Effect.fn("Config.invalidate")(function* () {
      yield* invalidateGlobal
    })

    return Service.of({
      get,
      getGlobal,
      invalidate,
      directories,
      waitForDependencies,
    })
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Auth.defaultLayer),
  Layer.provide(Npm.defaultLayer),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(AgentConfigStore.defaultLayer),
  Layer.provide(CatalogStore.defaultLayer),
  Layer.provide(CommandConfigStore.defaultLayer),
  Layer.provide(PluginConfigStore.defaultLayer),
  Layer.provide(ReferenceConfigStore.defaultLayer),
  Layer.provide(SettingsConfigStore.defaultLayer),
  Layer.provide(SkillConfigStore.defaultLayer),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    FSUtil.node,
    Auth.node,
    Npm.node,
    httpClient,
    AgentConfigStore.node,
    CatalogStore.node,
    CommandConfigStore.node,
    PluginConfigStore.node,
    ReferenceConfigStore.node,
    SettingsConfigStore.node,
    SkillConfigStore.node,
  ],
})

export * as Config from "./config"
