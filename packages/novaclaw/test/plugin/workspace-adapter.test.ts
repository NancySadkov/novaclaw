import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { CrossSpawnSpawner } from "@novaclaw/core/cross-spawn-spawner"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Global } from "@novaclaw/core/global"
import { AgentConfigStore } from "@novaclaw/core/agent-config-store"
import { CatalogStore } from "@novaclaw/core/catalog-store"
import { CommandConfigStore } from "@novaclaw/core/command-config-store"
import { PluginConfigStore } from "@novaclaw/core/plugin-config-store"
import { ReferenceConfigStore } from "@novaclaw/core/reference-config-store"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import { SkillConfigStore } from "@novaclaw/core/skill-config-store"
import { Ripgrep } from "@novaclaw/core/ripgrep"
import { EffectFlock } from "@novaclaw/core/util/effect-flock"
import path from "path"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Config } from "../../src/config/config"
import { Env } from "../../src/env"
import { RuntimeFlags } from "../../src/effect/runtime-flags"
import { Workspace } from "../../src/control-plane/workspace"
import { Plugin } from "../../src/plugin/index"
import { InstanceState } from "../../src/effect/instance-state"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { workspaceLayerWithRuntimeFlags } from "../fixture/workspace"
import { testEffect } from "../lib/effect"
import { AccountTest } from "../fake/account"
import { AuthTest } from "../fake/auth"
import { NpmTest } from "../fake/npm"

const configLayer = Config.layer.pipe(
  Layer.provide(EffectFlock.defaultLayer),
  Layer.provide(FSUtil.defaultLayer),
  Layer.provide(Env.defaultLayer),
  Layer.provide(AuthTest.empty),
  Layer.provide(AccountTest.empty),
  Layer.provide(NpmTest.noop),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(Global.layer),
  Layer.provide(AgentConfigStore.defaultLayer),
  Layer.provide(CatalogStore.defaultLayer),
  Layer.provide(CommandConfigStore.defaultLayer),
  Layer.provide(PluginConfigStore.defaultLayer),
  Layer.provide(ReferenceConfigStore.defaultLayer),
  Layer.provide(SettingsConfigStore.defaultLayer),
  Layer.provide(SkillConfigStore.defaultLayer),
)
const pluginLayer = Plugin.layer.pipe(
  Layer.provide(EventV2Bridge.defaultLayer),
  Layer.provide(configLayer),
  Layer.provide(RuntimeFlags.layer({ disableDefaultPlugins: true })),
)
// This suite used to re-assemble `Workspace.layer` by hand — a second copy of the fixture's provide
// list that differed only in its RuntimeFlags overrides, and that had to be patched separately every
// time `Workspace.layer` grew a requirement. It now shares the ONE mirror. Its `InstanceStore` +
// noop-bootstrap provides went with it: `Workspace.layer` never required InstanceStore (see the note
// in test/fixture/workspace.ts), and `it.instance` provides its own store via `withTmpdirInstance`,
// which already wires a no-op bootstrap.
const workspaceLayer = workspaceLayerWithRuntimeFlags({ experimentalWorkspaces: true })
const it = testEffect(
  Layer.mergeAll(pluginLayer, workspaceLayer, CrossSpawnSpawner.defaultLayer).pipe(Layer.provide(Ripgrep.defaultLayer)),
)

afterEach(async () => {
  await disposeAllInstances()
})

describe("plugin.workspace", () => {
  it.instance("plugin can install a workspace adapter", () =>
    Effect.gen(function* () {
      const dir = (yield* TestInstance).directory
      const type = `plug-${Math.random().toString(36).slice(2)}`
      // Config→SQLite step 9: project config FILES are no longer a runtime plugin source —
      // deliver the plugin via the D2 `.novaclaw/{plugin,plugins}/*` directory walk.
      const file = path.join(dir, ".novaclaw", "plugin", "plugin.ts")
      const mark = path.join(dir, "created.json")
      const space = path.join(dir, "space")
      yield* Effect.promise(() =>
        Bun.write(
          file,
          [
            "export default async ({ experimental_workspace }) => {",
            `  experimental_workspace.register(${JSON.stringify(type)}, {`,
            '    name: "plug",',
            '    description: "plugin workspace adapter",',
            "    configure(input) {",
            `      return { ...input, name: "plug", branch: "plug/main", directory: ${JSON.stringify(space)} }`,
            "    },",
            "    async create(input) {",
            `      await Bun.write(${JSON.stringify(mark)}, JSON.stringify(input))`,
            "    },",
            "    async remove() {},",
            "    target(input) {",
            '      return { type: "local", directory: input.directory }',
            "    },",
            "  })",
            "  return {}",
            "}",
            "",
          ].join("\n"),
        ),
      )

      const plugin = yield* Plugin.Service
      yield* plugin.init()
      const workspace = yield* Workspace.Service
      const ctx = yield* InstanceState.context
      const info = yield* workspace.create({
        type,
        branch: null,
        extra: { key: "value" },
        origin: ctx.origin,
      })

      expect(info.type).toBe(type)
      expect(info.name).toBe("plug")
      expect(info.branch).toBe("plug/main")
      expect(info.directory).toBe(space)
      expect(info.extra).toEqual({ key: "value" })
      expect(JSON.parse(yield* Effect.promise(() => Bun.file(mark).text()))).toMatchObject({
        type,
        name: "plug",
        branch: "plug/main",
        directory: space,
        extra: { key: "value" },
      })
    }),
  )
})
