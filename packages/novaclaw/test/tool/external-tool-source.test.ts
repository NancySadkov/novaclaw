// F1a SLICE 1 gate: the V2 `ExternalToolSource` aggregator discovers a config-dir
// `{tool}/echo.ts` custom tool via the V2-native `Config.Service`, and a real
// `ToolRegistry.materialize()` both advertises it and settles a call through it —
// i.e. a custom-tool turn can run on the V2 engine (no `hasCustom` fallback needed).
import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { AbsolutePath } from "@novaclaw/core/schema"
import { Config } from "@novaclaw/core/config"
import { Location } from "@novaclaw/core/location"
import { Project } from "@novaclaw/core/project"
import { PermissionV2 } from "@novaclaw/core/permission"
import { ExternalToolSource } from "@novaclaw/core/tool/external-tool-source"
import { PluginTools } from "@novaclaw/core/tool/plugin-tools"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { ApplicationTools } from "@novaclaw/core/tool/application-tools"
import { ToolOutputStore } from "@novaclaw/core/tool-output-store"
import { AgentV2 } from "@novaclaw/core/agent"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionMessage } from "@novaclaw/core/session/message"
import { tool } from "@novaclaw/plugin"
import { makeCustom, makePluginRegistered } from "@/tool/external-tool-source"
import { tmpdir } from "../fixture/fixture"

// A minimal config-dir plugin tool (JSON-Schema args, string return) — the shape a
// user drops into `<config>/tool/echo.ts`. `export default` → the tool is named for
// the file (`echo`).
const TOOL_FILE = `export default {
  description: "Echo the input text",
  args: { text: { type: "string" } },
  execute: async (args) => "echo:" + args.text,
}
`

describe("AggregateExternalToolSource — config-dir custom tools (F1a SLICE 1)", () => {
  test("discovers a config-dir tool and runs it through ToolRegistry.materialize", async () => {
    await using tmp = await tmpdir<void>({
      init: async (dir) => {
        await Bun.write(path.join(dir, "tool", "echo.ts"), TOOL_FILE)
      },
    })
    const root = AbsolutePath.make(tmp.path)

    // The three V2-native services the aggregator reads: config dirs to scan, the
    // location directory threaded to the tool, and the per-call permission gate.
    const configMock = Layer.succeed(
      Config.Service,
      Config.Service.of({ entries: () => Effect.succeed([new Config.Directory({ type: "directory", path: root })]) }),
    )
    const locationMock = Layer.mock(Location.Service, {
      directory: root,
      root,
      origin: Project.ID.make("prj_slice1"),
    })
    const permissionMock = Layer.mock(PermissionV2.Service, { assert: () => Effect.void })
    const base = Layer.mergeAll(configMock, locationMock, permissionMock)

    // Build a REAL ToolRegistry whose external source is the aggregator's config-dir
    // discovery (`makeCustom`), backed by the real ApplicationTools + ToolOutputStore.
    const externalLayer = Layer.effect(ExternalToolSource.Service, makeCustom).pipe(Layer.provide(base))
    const registryLayer = ToolRegistry.layer.pipe(
      Layer.provide(externalLayer),
      Layer.provide(ApplicationTools.layer),
      Layer.provide(ToolOutputStore.defaultLayer),
      Layer.provide(base),
    )

    const program = Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const materialized = yield* service.materialize()
      expect(materialized.definitions.map((definition) => definition.name)).toContain("echo")

      const settlement = yield* materialized.settle({
        sessionID: SessionV2.ID.make("ses_slice1"),
        agent: AgentV2.ID.make("build"),
        assistantMessageID: SessionMessage.ID.make("msg_slice1"),
        call: { type: "tool-call", id: "call-echo", name: "echo", input: { text: "hi" } },
      })
      expect(settlement.result).toEqual({ type: "text", value: "echo:hi" })
    })

    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(registryLayer)))
  })

  // F1a plugin-tool parity gate: a tool REGISTERED through the V2 `PluginTools`
  // store (what `ctx.tool.register` writes) is advertised by a real
  // `ToolRegistry.materialize()` and settles a call — i.e. a plugin-tool turn runs
  // on the V2 engine, so the `hasPluginTools` legacy fallback is retired.
  test("serves a V2-plugin-registered tool through ToolRegistry.materialize", async () => {
    await using tmp = await tmpdir<void>({ init: async () => {} })
    const root = AbsolutePath.make(tmp.path)

    const locationMock = Layer.mock(Location.Service, {
      directory: root,
      root,
      origin: Project.ID.make("prj_plugintools"),
    })
    const permissionMock = Layer.mock(PermissionV2.Service, { assert: () => Effect.void })
    const base = Layer.mergeAll(locationMock, permissionMock, PluginTools.layer)

    const externalLayer = Layer.effect(ExternalToolSource.Service, makePluginRegistered).pipe(Layer.provide(base))
    const registryLayer = ToolRegistry.layer.pipe(
      Layer.provide(externalLayer),
      Layer.provide(ApplicationTools.layer),
      Layer.provide(ToolOutputStore.defaultLayer),
      Layer.provide(base),
    )

    const program = Effect.gen(function* () {
      const store = yield* PluginTools.Service
      yield* store.register(
        "shout",
        tool({
          description: "Shout the input text",
          args: { text: tool.schema.string() },
          execute: async (args) => "SHOUT:" + args.text.toUpperCase(),
        }),
      )

      const service = yield* ToolRegistry.Service
      const materialized = yield* service.materialize()
      expect(materialized.definitions.map((definition) => definition.name)).toContain("shout")

      const settlement = yield* materialized.settle({
        sessionID: SessionV2.ID.make("ses_plugintools"),
        agent: AgentV2.ID.make("build"),
        assistantMessageID: SessionMessage.ID.make("msg_plugintools"),
        call: { type: "tool-call", id: "call-shout", name: "shout", input: { text: "hi" } },
      })
      expect(settlement.result).toEqual({ type: "text", value: "SHOUT:HI" })
    })

    // `base` (incl. the PluginTools store layer) appears in BOTH the registry graph
    // and the program's own environment — same layer reference, so Effect memoizes
    // it to ONE store instance; the program's `register` is visible to the registry.
    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(registryLayer, base))))
  })
})
