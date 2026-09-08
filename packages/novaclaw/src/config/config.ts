import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { serviceUse } from "@novaclaw/core/effect/service-use"
import path from "path"
import os from "os"
import { mergeDeep } from "remeda"
import { Global } from "@novaclaw/core/global"
import { Flag } from "@novaclaw/core/flag/flag"
import { InstallationLocal, InstallationVersion } from "@novaclaw/core/installation/version"
import { existsSync } from "fs"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { CommandConfigStore } from "@novaclaw/core/command-config-store"
import { ConfigSeedStartup } from "@novaclaw/core/config-seed-startup"
import { ConfigStoreWrite } from "@novaclaw/core/config-store-write"
import { ReferenceConfigStore } from "@novaclaw/core/reference-config-store"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { SkillConfigStore } from "@novaclaw/core/skill-config-store"
import { isRecord } from "@/util/record"
import { FSUtil } from "@novaclaw/core/fs-util"
import { InstanceState } from "@/effect/instance-state"
import { Context, Duration, Effect, Exit, Fiber, Layer, Option } from "effect"
import { EffectFlock } from "@novaclaw/core/util/effect-flock"
import { containsPath, type InstanceContext } from "../project/instance-context"
import { Config as ConfigV2 } from "@novaclaw/core/config"
import { ConfigPermission } from "@novaclaw/core/config/permission"
import type { DeepMutable } from "@novaclaw/core/schema"
import { InvalidError } from "@novaclaw/core/config/error"
import { ConfigCommand } from "./command"
import { ConfigManaged } from "./managed"
import { ConfigParse } from "./parse"
import { ConfigPaths } from "./paths"
import { ConfigVariable } from "./variable"
import { Npm } from "@novaclaw/core/npm"
import { Log } from "@novaclaw/schema/log"

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

// The service authors + serves V2 `Config.Info` shapes. Internally it MUTATES a merged accumulator
// (mergeDeep + field assignments), so the working type is a deep-mutable V2 Info. Every config source —
// jsonc imports are authored directly as V2 (the V1 config migrator was retired in F1-config; no
// on-read migration remains). Agent identity is projected from the instance store only; project
// markdown is never an agent-config source.
// ⚠️ This used to carry a `plugin_origins` accumulator beside the V2 shape, plus a `Spec`↔entry
// conversion pair and a scope classifier, all so a merge could dedupe config-declared plugin
// specs by identity and remember which document won. Ruling 5 / step 17 deleted the `plugins[]`
// key they served, so the merged document is now exactly the V2 shape and nothing else. External
// plugins are discovered by `core/src/config/plugin/external.ts`'s filesystem walk at load time —
// they are never a config value, so they never take part in a merge.
export type Info = DeepMutable<typeof ConfigV2.Info.Type>

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
    const npmSvc = yield* Npm.Service

    // Config→SQLite step 9: the per-subsystem stores ARE the config source. Capture them once
    // so the Interface methods (R = never) can run store-requiring effects (overlay + seeds).
    const agentStore = yield* AgentConfigStore.Service
    const catalogStore = yield* CatalogStore.Service
    const commandStore = yield* CommandConfigStore.Service
    const referenceStore = yield* ReferenceConfigStore.Service
    const settingsStore = yield* SettingsConfigStore.Service
    const skillStore = yield* SkillConfigStore.Service
    const provideStores = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(AgentConfigStore.Service, agentStore),
        Effect.provideService(CatalogStore.Service, catalogStore),
        Effect.provideService(CommandConfigStore.Service, commandStore),
        Effect.provideService(ReferenceConfigStore.Service, referenceStore),
        Effect.provideService(SettingsConfigStore.Service, settingsStore),
        Effect.provideService(SkillConfigStore.Service, skillStore),
        Effect.provideService(FSUtil.Service, fs),
      )

    const readConfigFile = (filepath: string) => fs.readFileStringSafe(filepath).pipe(Effect.orDie)

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

      // 🔴 The `$schema` back-fill is IN MEMORY ONLY. It used to rewrite the file it had just read,
      // and the only path that reaches here with a `path` is the MACHINE-WIDE managed config
      // (`/etc/novaclaw`, `%ProgramData%\novaclaw`, `/Library/Application Support/novaclaw`) — a
      // policy artefact an administrator deploys, which AGENTS.md principle 11 names verbatim as a
      // place we may read and nothing more. The write was wrapped in `Effect.catch(() =>
      // Effect.void)`, so it no-opped exactly where permissions forbid it and succeeded on the
      // machines where the running account keeps write ACLs: invisible on the developer's box,
      // live on the deployed one, showing the admin's file as drifted under configuration
      // management. Nothing reads the bytes back — every consumer reads `data` — so the file never
      // needed to change.
      if (!data.$schema) data.$schema = "https://novaclaw.app/config.json"
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
        Effect.tapError((error) => Log.event("config.global.load.failed", { "config.cause": Log.fault(error) })),
        Effect.orElseSucceed((): Info => ({})),
      ),
      Duration.infinity,
    )

    const getGlobal = Effect.fn("Config.getGlobal")(function* () {
      return yield* cachedGlobal
    })

    /**
     * May NovaClaw itself create a file in this config directory?
     *
     * 🔴 AGENTS.md principle 11: our own writes land in exactly three places — a home instance dir,
     * the OS temp dir, or the session's working/project folder. A config directory is *discovered*
     * by an ancestor walk, so the set the walk yields is not automatically one of them: a
     * `.novaclaw` sitting above the session's folder (a sibling project's, or one in `Documents`)
     * is a place we may READ and never write.
     *
     * ⚠️ Stated as the roots we are ALLOWED to write, never as a property of the walk. The walk's
     * boundary is a separate fix in a separate module (`FSUtil.walkBoundary`); if it ever widens
     * again — a new source of config directories, a boundary sentinel nobody decoded — this list
     * still holds, because it does not depend on where the directory came from.
     *
     * The session's own folder is `containsPath` — the same predicate the rest of the instance uses
     * for "is this inside the project", including its skip for the `"/"` no-repository sentinel,
     * which names the whole volume rather than a project root. The instance dirs are screened
     * CANONICALLY: a `.novaclaw` that is a junction or symlink into someone else's tree must not
     * pass by spelling, and canonicalisation failing is answered with "no" — a write we cannot
     * place is a write we do not make.
     */
    const writableConfigDir = (dir: string, ctx: InstanceContext) => {
      if (containsPath(dir, ctx)) return true
      const instanceDirs = [
        Global.Path.config,
        path.join(Global.Path.home, ".novaclaw"),
        ...(Flag.NOVACLAW_CONFIG_DIR ? [Flag.NOVACLAW_CONFIG_DIR] : []),
      ]
      return instanceDirs.some((root) => {
        try {
          return FSUtil.containsCanonical(root, dir)
        } catch {
          return false
        }
      })
    }

    const ensureGitignore = Effect.fn("Config.ensureGitignore")(function* (dir: string, ctx: InstanceContext) {
      if (!writableConfigDir(dir, ctx)) return
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
        let result: Info = {}

        // Folding one document into the accumulator IS the whole merge now. It used to also thread
        // each document's plugin specs through an origin dedup that remembered the winning source
        // and whether it was global or local; ruling 5 / step 17 removed the key those specs came
        // from, and with it the only reason this had to be an Effect.
        const merge = (next: Info) => {
          result = mergeConfigConcatArrays(result, next)
        }

        // Runtime overlays may still carry the broad import/export schema, but agent identity and
        // authority are not ordinary mergeable settings. They are materialized only from the
        // instance store above, where the HTTP surface can inspect and repair them. This also keeps
        // an env or managed document from becoming a second, invisible profile source after boot.
        const mergeRuntimeOverlay = (next: Info) => {
          const settings = { ...next }
          delete settings.agents
          delete settings.default_agent
          merge(settings)
        }

        // Config→SQLite step 9: the store-backed document replaces every file-borne source —
        // the global candidates AND the project jsonc walk (settings are instance-wide by
        // design; only non-authority resources such as commands may vary by directory below).
        // Provider environment resolution happens at runtime in the catalog integration
        // transform, not here.
        const stored = yield* getGlobal()
        merge(stored)

        result.agents = result.agents || {}

        const directories = yield* ConfigPaths.directories(ctx.directory, ctx.worktree)

        if (Flag.NOVACLAW_CONFIG_DIR) {
          yield* Log.event("config.directory.load", { "config.directory": Flag.NOVACLAW_CONFIG_DIR })
        }

        const deps: Fiber.Fiber<void>[] = []

        for (const dir of directories) {
          yield* ensureGitignore(dir, ctx).pipe(Effect.orDie)

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
          //
          // ⚠️ Gated on the SAME answer as the gitignore above, because it is the same kind of act:
          // `npm install` writes `package.json`, a lockfile and `node_modules/` into `dir`. A
          // directory we may only read is not made writable by a different write arriving.
          if (Flag.NOVACLAW_INSTALL_PLUGIN_TYPES && writableConfigDir(dir, ctx)) {
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
                        "config.cause": Log.fault(exit.cause),
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
          // (No plugin walk here. `{plugin,plugins}/*.{ts,js}` under a config directory is still a
          // supported place to drop your own plugin, but it is LOADED by
          // `core/src/config/plugin/external.ts`, which does its own walk over the same directories.
          // This service used to walk them too, purely so the file URLs could be projected into the
          // now-deleted `plugins` config key — a listing, never a load.)
        }

        if (process.env.NOVACLAW_CONFIG_CONTENT) {
          const source = "NOVACLAW_CONFIG_CONTENT"
          const next = yield* loadConfig(process.env.NOVACLAW_CONFIG_CONTENT, {
            dir: ctx.directory,
            source,
          })
          mergeRuntimeOverlay(next)
          yield* Log.event("config.content.load", {})
        }

        const managedDir = ConfigManaged.managedConfigDir()
        if (existsSync(managedDir)) {
          for (const file of ["novaclaw.json", "novaclaw.jsonc"]) {
            const source = path.join(managedDir, file)
            mergeRuntimeOverlay(yield* loadFile(source))
          }
        }

        // macOS managed preferences (.mobileconfig deployed via MDM) override everything
        const managed = yield* Effect.promise(() => ConfigManaged.readManagedPreferences())
        if (managed) {
          mergeRuntimeOverlay(
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
            yield* Log.event("config.permission.parse.failed", { "config.cause": Log.fault(err) })
          }
        }

        if (!result.username) {
          try {
            result.username = os.userInfo().username || "user"
          } catch (err) {
            yield* Log.event("config.username.read.failed", { "config.cause": Log.fault(err) })
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
    // fully merged document (stores overlay + dir-discovered markdown + managed MDM + env).
    // `invalidate()` below clears only the process-global store view; nothing ever
    // replaced THIS. So `snapshots` — which its reader already re-read on every call,
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
  Layer.provide(Npm.defaultLayer),
  Layer.provide(AgentConfigStore.defaultLayer),
  Layer.provide(CatalogStore.defaultLayer),
  Layer.provide(CommandConfigStore.defaultLayer),
  Layer.provide(ReferenceConfigStore.defaultLayer),
  Layer.provide(SettingsConfigStore.defaultLayer),
  Layer.provide(SkillConfigStore.defaultLayer),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    FSUtil.node,
    Npm.node,
    AgentConfigStore.node,
    CatalogStore.node,
    CommandConfigStore.node,
    ReferenceConfigStore.node,
    SettingsConfigStore.node,
    SkillConfigStore.node,
  ],
})

export * as Config from "./config"
