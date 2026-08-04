import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Logger, Schema } from "effect"
import { AgentV2 } from "@novaclaw/core/agent"
import { Config } from "@novaclaw/core/config"
import { ConfigExternalPlugin } from "@novaclaw/core/config/plugin/external"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Location } from "@novaclaw/core/location"
import { Npm } from "@novaclaw/core/npm"
import { PluginV2 } from "@novaclaw/core/plugin"
import { PluginConfigStore, type PluginConfigEntry } from "@novaclaw/core/plugin-config-store"
import { PluginHost } from "@novaclaw/core/plugin/host"
import { AbsolutePath } from "@novaclaw/core/schema"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"

const it = testEffect(PluginTestLayer)
const decode = Schema.decodeUnknownSync(Config.Info)

// Config→SQLite steps 5 + 8c: the loader reads config-borne plugin specs from the instance-wide
// store (pre-populated here with the ABSOLUTE paths the import seeds would have resolved;
// documents are never read — entries only feed the D2 `{plugin,plugins}/*` directory walk).
const fixture = (name: string) => path.resolve(import.meta.dir, "../plugin/fixtures", name)
const memoryStore = () => {
  const entries = new Map<string, PluginConfigEntry>()
  return PluginConfigStore.Service.of({
    plugins: () => Effect.sync(() => [...entries.values()]),
    setPlugin: (entry) =>
      Effect.sync(() => {
        entries.set(entry.package, entry)
      }),
    removePlugin: (pkg) =>
      Effect.sync(() => {
        entries.delete(pkg)
      }),
    isEmpty: () => Effect.sync(() => entries.size === 0),
  })
}

/** Collect every WARN emitted while `effect` runs — including from fibers it forks. */
const collectWarnings = () => {
  const records: unknown[][] = []
  const collector = Logger.make((options: Logger.Options<unknown>) => {
    if (options.logLevel !== "Warn") return
    records.push(Array.isArray(options.message) ? [...options.message] : [options.message])
  })
  return { records, layer: Logger.layer([collector]) }
}

describe("ConfigExternalPlugin", () => {
  it.live("resolves and loads a configured Promise plugin with options", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const agents = yield* AgentV2.Service
      const fs = yield* FSUtil.Service
      const location = yield* Location.Service
      const npm = yield* Npm.Service
      const host = yield* PluginHost.make(plugins)
      const store = memoryStore()
      yield* store.setPlugin({
        package: fixture("config-promise-plugin.ts"),
        options: { description: "Loaded from config" },
      })

      yield* ConfigExternalPlugin.Plugin.effect(host).pipe(
        Effect.provideService(PluginV2.Service, plugins),
        Effect.provideService(FSUtil.Service, fs),
        Effect.provideService(Location.Service, location),
        Effect.provideService(Npm.Service, npm),
        Effect.provideService(PluginConfigStore.Service, store),
        Effect.provideService(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) })),
      )

      expect(yield* waitForAgent(agents, "configured")).toMatchObject({
        description: "Loaded from config",
        mode: "subagent",
      })
    }),
  )

  it.live("loads a configured Effect plugin with options", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const agents = yield* AgentV2.Service
      const fs = yield* FSUtil.Service
      const location = yield* Location.Service
      const npm = yield* Npm.Service
      const host = yield* PluginHost.make(plugins)

      yield* ConfigExternalPlugin.Plugin.effect(host).pipe(
        Effect.provideService(PluginV2.Service, plugins),
        Effect.provideService(FSUtil.Service, fs),
        Effect.provideService(Location.Service, location),
        Effect.provideService(Npm.Service, npm),
        Effect.provideService(
          PluginConfigStore.Service,
          yield* Effect.gen(function* () {
            const store = memoryStore()
            yield* store.setPlugin({
              package: fixture("config-effect-plugin.ts"),
              options: { description: "Effect plugin from config" },
            })
            return store
          }),
        ),
        Effect.provideService(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) })),
      )

      expect(yield* waitForAgent(agents, "effect-configured")).toMatchObject({
        description: "Effect plugin from config",
        mode: "subagent",
      })
    }),
  )

  it.live("ignores invalid plugins and continues loading", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const agents = yield* AgentV2.Service
      const fs = yield* FSUtil.Service
      const location = yield* Location.Service
      const npm = yield* Npm.Service
      const host = yield* PluginHost.make(plugins)

      yield* ConfigExternalPlugin.Plugin.effect(host).pipe(
        Effect.provideService(PluginV2.Service, plugins),
        Effect.provideService(FSUtil.Service, fs),
        Effect.provideService(Location.Service, location),
        Effect.provideService(Npm.Service, npm),
        Effect.provideService(
          PluginConfigStore.Service,
          yield* Effect.gen(function* () {
            const store = memoryStore()
            yield* store.setPlugin({ package: fixture("missing-plugin.ts") })
            yield* store.setPlugin({ package: fixture("invalid-plugin.ts") })
            yield* store.setPlugin({
              package: fixture("config-promise-plugin.ts"),
              options: { description: "Loaded after invalid plugins" },
            })
            return store
          }),
        ),
        Effect.provideService(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) })),
      )

      expect(yield* waitForAgent(agents, "configured")).toMatchObject({
        description: "Loaded after invalid plugins",
      })
    }),
  )

  // ⚠️ Ruling 2 (a fault is never described falsely). `ignoreCause` alone made a user's broken
  // plugin fail INVISIBLY once the V1 arm — the only thing that ever surfaced a failed load — was
  // deleted. The two fixtures cover both fault SHAPES: `missing-plugin.ts` throws out of `import()`
  // (a defect before `tryPromise`), `invalid-plugin.ts` fails schema decode (an ordinary error).
  // Both must reach the log, and neither may stop the good plugin behind them.
  it.live("warns — never silently drops — when an external plugin fails to load", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const agents = yield* AgentV2.Service
      const fs = yield* FSUtil.Service
      const location = yield* Location.Service
      const npm = yield* Npm.Service
      const host = yield* PluginHost.make(plugins)
      const { records, layer } = collectWarnings()

      yield* ConfigExternalPlugin.Plugin.effect(host).pipe(
        Effect.provide(layer),
        Effect.provideService(PluginV2.Service, plugins),
        Effect.provideService(FSUtil.Service, fs),
        Effect.provideService(Location.Service, location),
        Effect.provideService(Npm.Service, npm),
        Effect.provideService(
          PluginConfigStore.Service,
          yield* Effect.gen(function* () {
            const store = memoryStore()
            yield* store.setPlugin({ package: fixture("missing-plugin.ts") })
            yield* store.setPlugin({ package: fixture("invalid-plugin.ts") })
            yield* store.setPlugin({
              package: fixture("config-promise-plugin.ts"),
              options: { description: "Loaded after broken plugins" },
            })
            return store
          }),
        ),
        Effect.provideService(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) })),
      )

      // The good plugin landing is the loader's own "all three refs were processed" signal.
      expect(yield* waitForAgent(agents, "configured")).toMatchObject({
        description: "Loaded after broken plugins",
      })

      const reported = records.filter(
        (record) => (record[0] as { event?: string } | undefined)?.event === "plugin.external.load.failed",
      )
      expect(reported).toHaveLength(2)
      expect(reported.map((record) => (record[2] as { "plugin.package": string })["plugin.package"]).sort()).toEqual(
        [fixture("invalid-plugin.ts"), fixture("missing-plugin.ts")].sort(),
      )
      for (const record of reported) {
        expect(record).toEqual([
          { event: "plugin.external.load.failed" },
          "external plugin failed to load and is UNAVAILABLE — every other plugin still loaded",
          { "plugin.package": expect.any(String), "plugin.cause": expect.any(String) },
        ])
      }
    }),
  )

  it.live("installs and resolves npm plugin packages", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const agents = yield* AgentV2.Service
      const fs = yield* FSUtil.Service
      const location = yield* Location.Service
      const host = yield* PluginHost.make(plugins)
      let installed: string | undefined
      const npm = Npm.Service.of({
        add: (spec) =>
          Effect.sync(() => {
            installed = spec
            return {
              directory: import.meta.dir,
              entrypoint: path.join(import.meta.dir, "../plugin/fixtures/config-promise-plugin.ts"),
            }
          }),
        install: () => Effect.void,
        which: () => Effect.succeed(undefined),
      })

      yield* ConfigExternalPlugin.Plugin.effect(host).pipe(
        Effect.provideService(PluginV2.Service, plugins),
        Effect.provideService(FSUtil.Service, fs),
        Effect.provideService(Location.Service, location),
        Effect.provideService(Npm.Service, npm),
        Effect.provideService(
          PluginConfigStore.Service,
          yield* Effect.gen(function* () {
            const store = memoryStore()
            yield* store.setPlugin({ package: "example-plugin@1.0.0", options: { description: "Installed from npm" } })
            return store
          }),
        ),
        Effect.provideService(Config.Service, Config.Service.of({ entries: () => Effect.succeed([]) })),
      )

      expect(yield* waitForAgent(agents, "configured")).toMatchObject({
        description: "Installed from npm",
      })
      expect(installed).toBe("example-plugin@1.0.0")
    }),
  )

  it.live("loads plugin files from config directories", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const agents = yield* AgentV2.Service
      const fs = yield* FSUtil.Service
      const location = yield* Location.Service
      const npm = yield* Npm.Service
      const host = yield* PluginHost.make(plugins)

      yield* ConfigExternalPlugin.Plugin.effect(host).pipe(
        Effect.provideService(PluginV2.Service, plugins),
        Effect.provideService(FSUtil.Service, fs),
        Effect.provideService(Location.Service, location),
        Effect.provideService(Npm.Service, npm),
        Effect.provideService(PluginConfigStore.Service, memoryStore()),
        Effect.provideService(
          Config.Service,
          Config.Service.of({
            entries: () =>
              Effect.succeed([
                new Config.Directory({
                  type: "directory",
                  path: AbsolutePath.make(path.join(import.meta.dir, "fixtures")),
                }),
              ]),
          }),
        ),
      )

      expect(yield* waitForAgent(agents, "directory")).toMatchObject({
        description: "Loaded from plugin directory",
        mode: "subagent",
      })
    }),
  )

  // `--pure` / `NOVACLAW_PURE` is advertised in every CLI --help as "run without external plugins".
  // It used to gate the deleted V1 loader; it now gates THIS one, which is the only remaining door
  // third-party code comes through. Negative-controlled by the two tests above, which load exactly
  // these two sources (store entry + config-directory walk) when the flag is absent.
  it.live("loads nothing at all under NOVACLAW_PURE", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const agents = yield* AgentV2.Service
      const fs = yield* FSUtil.Service
      const location = yield* Location.Service
      const npm = yield* Npm.Service
      const host = yield* PluginHost.make(plugins)

      const previous = process.env.NOVACLAW_PURE
      process.env.NOVACLAW_PURE = "1"
      try {
        yield* ConfigExternalPlugin.Plugin.effect(host).pipe(
          Effect.provideService(PluginV2.Service, plugins),
          Effect.provideService(FSUtil.Service, fs),
          Effect.provideService(Location.Service, location),
          Effect.provideService(Npm.Service, npm),
          Effect.provideService(
            PluginConfigStore.Service,
            yield* Effect.gen(function* () {
              const store = memoryStore()
              yield* store.setPlugin({ package: fixture("config-promise-plugin.ts") })
              return store
            }),
          ),
          Effect.provideService(
            Config.Service,
            Config.Service.of({
              entries: () =>
                Effect.succeed([
                  new Config.Directory({
                    type: "directory",
                    path: AbsolutePath.make(path.join(import.meta.dir, "fixtures")),
                  }),
                ]),
            }),
          ),
        )
        // The loader forks its work; give it the same budget waitForAgent would have spent.
        yield* Effect.sleep("300 millis")
      } finally {
        if (previous === undefined) delete process.env.NOVACLAW_PURE
        else process.env.NOVACLAW_PURE = previous
      }

      expect(yield* agents.get(AgentV2.ID.make("configured"))).toBeUndefined()
      expect(yield* agents.get(AgentV2.ID.make("directory"))).toBeUndefined()
    }),
  )
})

const waitForAgent = Effect.fnUntraced(function* (agents: AgentV2.Interface, id: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const agent = yield* agents.get(AgentV2.ID.make(id))
    if (agent) return agent
    yield* Effect.sleep("10 millis")
  }
  return yield* Effect.die(`Timed out waiting for agent ${id}`)
})
