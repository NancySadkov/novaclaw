import { describe, expect, test } from "bun:test"
import path from "path"
import { pathToFileURL } from "url"
import { Effect, Layer } from "effect"
import { FSUtil } from "@novaclaw/core/fs-util"
import { TestInstance } from "../fixture/fixture"
import { ProviderAuth } from "@/provider/auth"

import { Plugin } from "@/plugin"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { Auth } from "@/auth"
import { EventV2Bridge } from "@/event-v2-bridge"
import { TestConfig } from "../fixture/config"
import { testEffect } from "../lib/effect"
import { CrossSpawnSpawner } from "@novaclaw/core/cross-spawn-spawner"
import { ProviderV2 } from "@novaclaw/core/provider"

const it = testEffect(Layer.mergeAll(CrossSpawnSpawner.defaultLayer, FSUtil.defaultLayer))

function layer(directory: string, plugins: string[]) {
  return ProviderAuth.layer.pipe(
    Layer.provide(Auth.defaultLayer),
    Layer.provide(
      Plugin.layer.pipe(
        Layer.provide(EventV2Bridge.defaultLayer),
        Layer.provide(RuntimeFlags.layer()),
        Layer.provide(
          TestConfig.layer({
            get: () =>
              Effect.succeed({
                plugin: plugins,
                plugin_origins: plugins.map((plugin) => ({
                  spec: plugin,
                  source: path.join(directory, "novaclaw.json"),
                  scope: "local" as const,
                })),
              }),
            directories: () => Effect.succeed([directory]),
          }),
        ),
      ),
    ),
  )
}

describe("plugin.auth-override", () => {
  it.instance(
    "user plugin registers provider auth",
    () =>
      Effect.gen(function* () {
        const tmp = yield* TestInstance
        const fs = yield* FSUtil.Service
        const pluginDir = path.join(tmp.directory, ".novaclaw", "plugin")

        yield* fs.writeWithDirs(
          path.join(pluginDir, "custom-provider-auth.ts"),
          [
            "export default {",
            '  id: "demo.custom-provider-auth",',
            "  server: async () => ({",
            "    auth: {",
            '      provider: "my-provider",',
            "      methods: [",
            '        { type: "api", label: "Test Override Auth" },',
            "      ],",
            "      loader: async () => ({ access: 'test-token' }),",
            "    },",
            "  }),",
            "}",
            "",
          ].join("\n"),
        )

        const plugin = pathToFileURL(path.join(pluginDir, "custom-provider-auth.ts")).href
        const methods = yield* ProviderAuth.use.methods().pipe(Effect.provide(layer(tmp.directory, [plugin])))

        const provider = methods[ProviderV2.ID.make("my-provider")]
        expect(provider).toBeDefined()
        expect(provider.length).toBe(1)
        expect(provider[0].label).toBe("Test Override Auth")
      }),
    { git: true },
    30000,
  )
})

const file = path.join(import.meta.dir, "../../src/plugin/index.ts")

describe("plugin.config-hook-error-isolation", () => {
  test("config hooks are individually error-isolated in the layer factory", async () => {
    const src = await Bun.file(file).text()

    // Each hook's config call is wrapped in Effect.tryPromise with error logging + Effect.ignore
    expect(src).toContain("plugin config hook failed")

    const pattern =
      /for\s*\(const hook of hooks\)\s*\{[\s\S]*?Effect\.tryPromise[\s\S]*?\.config\?\.\([\s\S]*?plugin config hook failed[\s\S]*?Effect\.ignore/
    expect(pattern.test(src)).toBe(true)
  })
})
