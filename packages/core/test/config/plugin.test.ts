import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Logger } from "effect"
import { AgentV2 } from "@novaclaw/core/agent"
import { Config } from "@novaclaw/core/config"
import { ConfigExternalPlugin } from "@novaclaw/core/config/plugin/external"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Global } from "@novaclaw/core/global"
import { PluginV2 } from "@novaclaw/core/plugin"
import { PluginHost } from "@novaclaw/core/plugin/host"
import { AbsolutePath } from "@novaclaw/core/schema"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "../plugin/fixture"

const it = testEffect(PluginTestLayer)

/** The INSTANCE config dir the loader is allowed to read (`plugin/{directory,effect}-plugin.ts`). */
const CONFIG_DIR = path.resolve(import.meta.dir, "fixtures")
/** Stands in for `<project>/.novaclaw` — a directory `Config.entries()` lists and the loader must NOT read. */
const PROJECT_DIR = path.resolve(import.meta.dir, "fixtures-project")
/** Two broken plugins and a healthy one behind them, all in one config dir's `plugin/`. */
const BROKEN_CONFIG_DIR = path.resolve(import.meta.dir, "fixtures-broken")

/** A `Global.Service` whose config dir is `dir`; every other path is the real one and unused here. */
const globalAt = (dir: string) => Global.Service.of(Global.make({ config: dir }))

/**
 * `Config.entries()` as the real `Config.layer` builds it: the instance config dir FIRST, then every
 * `.novaclaw` the walk-up found between the session's folder and its VCS root. The loader is handed
 * this on purpose even though it no longer reads it — see the project-directory test.
 */
const entriesOf = (...dirs: string[]) =>
  Config.Service.of({
    entries: () =>
      Effect.succeed(dirs.map((dir) => new Config.Directory({ type: "directory", path: AbsolutePath.make(dir) }))),
  })

/** Collect every WARN emitted while `effect` runs. */
/**
 * ⚠️ Sibling of `collectWarnings`, and a separate function rather than a parameter: the warning
 * collector's level filter is load-bearing in the test below it (a broken plugin must WARN, not
 * merely log), so widening it in place would have quietly weakened that assertion.
 */
const collectInfo = () => {
  const records: unknown[][] = []
  const collector = Logger.make((options: Logger.Options<unknown>) => {
    if (options.logLevel !== "Info") return
    records.push(Array.isArray(options.message) ? [...options.message] : [options.message])
  })
  return { records, layer: Logger.layer([collector]) }
}

const collectWarnings = () => {
  const records: unknown[][] = []
  const collector = Logger.make((options: Logger.Options<unknown>) => {
    if (options.logLevel !== "Warn") return
    records.push(Array.isArray(options.message) ? [...options.message] : [options.message])
  })
  return { records, layer: Logger.layer([collector]) }
}

describe("ConfigExternalPlugin", () => {
  it.live("loads plugin files from the instance config directory, in both plugin shapes", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const agents = yield* AgentV2.Service
      const fs = yield* FSUtil.Service
      const host = yield* PluginHost.make(plugins)

      yield* ConfigExternalPlugin.Plugin.effect(host).pipe(
        Effect.provideService(PluginV2.Service, plugins),
        Effect.provideService(FSUtil.Service, fs),
        Effect.provideService(Global.Service, globalAt(CONFIG_DIR)),
      )

      expect(yield* waitForAgent(agents, "directory")).toMatchObject({
        description: "Loaded from plugin directory",
        mode: "subagent",
      })
      expect(yield* waitForAgent(agents, "effect-directory")).toMatchObject({
        description: "Loaded from plugin directory as an Effect plugin",
        mode: "subagent",
      })
    }),
  )

  /**
   * 🔴 **The security regression test, and the reason the surviving glob is defensible at all.**
   *
   * Ruling 5 spared this loader because a plugin file is "the user's own code at the user's own
   * privilege, unreachable by an agent, a registry or a peer". That was FALSE as built until
   * 2026-08-19: the loader globbed every `entry.type === "directory"` of `Config.entries()`, and
   * that set is the instance config dir PLUS every `.novaclaw` the walk-up finds between the
   * session's folder and its VCS root — so `git clone` of a hostile repo, or a file an agent wrote
   * into the project it was pointed at, was arbitrary in-process code execution. Module scope runs
   * on `import()`, before any NovaClaw API is consulted, so nothing downstream could gate it.
   *
   * ⚠️ The fixture is proven CAPABLE of producing the hole before the absence is asserted — the
   * glob below finds the project plugin, and the entries handed to the loader list its directory.
   * Without both, "the agent never appeared" would also pass against a loader that globs nothing.
   * The healthy config-dir agent is the third leg: it proves the loader ran to completion.
   */
  it.live("never loads a plugin from a project directory, even though Config.entries() lists it", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const agents = yield* AgentV2.Service
      const fs = yield* FSUtil.Service
      const host = yield* PluginHost.make(plugins)

      // Vacuity guard 1: the project directory really does hold a plugin this loader's own pattern
      // matches. If the fixture ever stops matching, this fails here rather than passing silently.
      const wouldMatch = yield* fs.glob(ConfigExternalPlugin.PLUGIN_GLOB, {
        cwd: PROJECT_DIR,
        absolute: true,
        include: "file",
        dot: true,
        symlink: true,
      })
      expect(wouldMatch.map((file) => path.basename(file))).toEqual(["project-plugin.ts"])

      yield* ConfigExternalPlugin.Plugin.effect(host).pipe(
        Effect.provideService(PluginV2.Service, plugins),
        Effect.provideService(FSUtil.Service, fs),
        Effect.provideService(Global.Service, globalAt(CONFIG_DIR)),
        // Vacuity guard 2: the loader is handed the project directory exactly the way the walk-up
        // would hand it over. It ignores this service today — that is the fix — so a revert that
        // reads `entries()` again finds the project plugin here and turns this test red.
        Effect.provideService(Config.Service, entriesOf(CONFIG_DIR, PROJECT_DIR)),
      )

      // The loader ran to completion: its own config dir loaded.
      expect(yield* waitForAgent(agents, "directory")).toMatchObject({ mode: "subagent" })
      expect(yield* agents.get(AgentV2.ID.make("project-directory"))).toBeUndefined()
    }),
  )

  /**
   * 🔴 **A third-party plugin's declaration must SURVIVE the decode and be reported.**
   *
   * `PluginModule` is an Effect `Schema.Struct`, which keeps only what it names — so a plugin's
   * `capabilities` was dropped on the way IN until the schema declared it, and every plugin would
   * have been reported as declaring nothing. A field lost at decode reads exactly like a field
   * nobody set, which is why this asserts the VALUE and not merely that a log arrived.
   *
   * ⚠️ It also pins the three states apart. `<undeclared>` (said nothing) and `<none>` (said it
   * needs nothing) are different answers, and an unknown name is surfaced rather than swallowed —
   * a typo that vanishes leaves a declaration reading as complete.
   */
  it.live("reports what an external plugin DECLARED, including names it does not recognise", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const fs = yield* FSUtil.Service
      const host = yield* PluginHost.make(plugins)
      const { records, layer } = collectInfo()

      yield* ConfigExternalPlugin.Plugin.effect(host).pipe(
        Effect.provide(layer),
        Effect.provideService(PluginV2.Service, plugins),
        Effect.provideService(FSUtil.Service, fs),
        Effect.provideService(Global.Service, globalAt(CONFIG_DIR)),
      )

      // The loader now settles discovery before returning, so this observes the completed load rather
      // than relying on a race with a detached fiber.
      const agents = yield* AgentV2.Service
      yield* waitForAgent(agents, "effect-directory")

      const loaded = records.filter(
        (record) => (record[0] as { event?: string } | undefined)?.event === "plugin.external.loaded",
      )
      const byId = new Map(
        loaded.map((record) => [
          (record[2] as Record<string, string>)["plugin.id"],
          record[2] as Record<string, string>,
        ]),
      )

      // The declaring fixture: its known name survived the decode, and its typo is NAMED.
      const declaring = byId.get("effect-directory-plugin")
      expect(declaring?.["plugin.capabilities"]).toBe("config,netwrok")
      expect(declaring?.["plugin.capabilities.unknown"]).toBe("netwrok")

      // The silent fixture: "said nothing" must not read as "needs nothing".
      const silent = [...byId.values()].find((row) => row["plugin.id"] !== "effect-directory-plugin")
      expect(silent?.["plugin.capabilities"]).toBe("<undeclared>")
      expect(silent?.["plugin.capabilities.unknown"]).toBe("<none>")
    }),
  )

  // ⚠️ Ruling 2 (a fault is never described falsely). `ignoreCause` alone made a user's broken
  // plugin fail INVISIBLY once the V1 arm — the only thing that ever surfaced a failed load — was
  // deleted. The two fixtures cover both fault SHAPES: `a-throws-on-import.ts` throws out of
  // `import()` (a defect before `tryPromise`), `b-wrong-shape.ts` fails schema decode (an ordinary
  // error). Both must reach the log, and neither may stop the good plugin behind them.
  it.live("warns — never silently drops — when an external plugin fails to load", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const agents = yield* AgentV2.Service
      const fs = yield* FSUtil.Service
      const host = yield* PluginHost.make(plugins)
      const { records, layer } = collectWarnings()

      yield* ConfigExternalPlugin.Plugin.effect(host).pipe(
        Effect.provide(layer),
        Effect.provideService(PluginV2.Service, plugins),
        Effect.provideService(FSUtil.Service, fs),
        Effect.provideService(Global.Service, globalAt(BROKEN_CONFIG_DIR)),
      )

      // The good plugin landing is the loader's own "all three files were processed" signal.
      expect(yield* waitForAgent(agents, "healthy")).toMatchObject({
        description: "Loaded after broken plugins",
      })

      const reported = records.filter(
        (record) => (record[0] as { event?: string } | undefined)?.event === "plugin.external.load.failed",
      )
      expect(reported).toHaveLength(2)
      expect(
        reported.map((record) => path.basename((record[2] as { "plugin.package": string })["plugin.package"])).sort(),
      ).toEqual(["a-throws-on-import.ts", "b-wrong-shape.ts"])
      for (const record of reported) {
        expect(record).toEqual([
          { event: "plugin.external.load.failed" },
          "external plugin failed to load and is UNAVAILABLE — every other plugin still loaded",
          { "plugin.package": expect.any(String), "plugin.cause": expect.any(String) },
        ])
      }
    }),
  )

  // `--pure` / `NOVACLAW_PURE` is advertised in every CLI --help as "run without external plugins".
  // It used to gate the deleted V1 loader; it now gates THIS one, which is the only remaining door
  // third-party code comes through. Negative-controlled by the first test, which loads exactly this
  // directory when the flag is absent.
  it.live("loads nothing at all under NOVACLAW_PURE", () =>
    Effect.gen(function* () {
      const plugins = yield* PluginV2.Service
      const agents = yield* AgentV2.Service
      const fs = yield* FSUtil.Service
      const host = yield* PluginHost.make(plugins)

      const previous = process.env.NOVACLAW_PURE
      process.env.NOVACLAW_PURE = "1"
      try {
        yield* ConfigExternalPlugin.Plugin.effect(host).pipe(
          Effect.provideService(PluginV2.Service, plugins),
          Effect.provideService(FSUtil.Service, fs),
          Effect.provideService(Global.Service, globalAt(CONFIG_DIR)),
        )
        // The synchronous loader has no detached work to drain under pure mode.
        yield* Effect.sleep("300 millis")
      } finally {
        if (previous === undefined) delete process.env.NOVACLAW_PURE
        else process.env.NOVACLAW_PURE = previous
      }

      expect(yield* agents.get(AgentV2.ID.make("directory"))).toBeUndefined()
      expect(yield* agents.get(AgentV2.ID.make("effect-directory"))).toBeUndefined()
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
