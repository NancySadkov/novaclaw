// The V2 `ExternalToolSource` aggregator, post-ruling-5.
//
// Ruling 5 ("outside code never runs in-process — MCP is the out-of-process seam")
// deleted the config-dir `{tool,tools}/*.{js,ts}` walk that used to `import()` user
// files straight into the kernel process. These tests pin what replaced it:
//   1. such a file is NOT imported and NOT advertised — proven by a module-level
//      side effect that never fires — and the boot names it in a WARNING instead of
//      ignoring the directory silently (ruling 2);
//   2. the surviving two rungs still resolve deterministically: MCP is seeded first,
//      a V2-plugin registration overwrites it, so **plugin > MCP**;
//   3. each surviving rung still materializes and settles a real call through a real
//      `ToolRegistry`.
import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer, Logger, References } from "effect"
import { AbsolutePath } from "@novaclaw/core/schema"
import { Config } from "@novaclaw/core/config"
import { Location } from "@novaclaw/core/location"
import { Project } from "@novaclaw/core/project"
import { PermissionV2 } from "@novaclaw/core/permission"
// Value import, not `import type`: this file asserts model-facing bytes, and an MCP answer now
// carries the untrusted-content frame. Referencing `McpExternal.FRAME` keeps the wording defined
// once (`packages/core/src/tool/mcp-external.ts`) instead of copied into a second package's test.
import { McpExternal } from "@novaclaw/core/tool/mcp-external"
import { PluginTools } from "@novaclaw/core/tool/plugin-tools"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { Tool } from "@novaclaw/core/tool/tool"
import { ApplicationTools } from "@novaclaw/core/tool/application-tools"
import { ToolOutputStore } from "@novaclaw/core/tool-output-store"
import { AgentV2 } from "@novaclaw/core/agent"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionMessage } from "@novaclaw/core/session/message"
import { tool } from "@novaclaw/plugin/tool"
import { MCP } from "@/mcp"
import { AggregateExternalToolSource } from "@/tool/external-tool-source"
import { tmpdir } from "../fixture/fixture"

// The shape a user used to drop into `<config>/tool/echo.ts`. The `writeFileSync` at
// MODULE scope is the negative control: importing this file — which is exactly what
// ruling 5 forbids — leaves `IMPORTED.marker` on disk. The marker's absence is the
// proof that no third-party code ran in our process, independent of whether the tool
// happened to show up in the registry.
const TOOL_FILE = `import fs from "fs"
import path from "path"
fs.writeFileSync(path.join(import.meta.dir, "IMPORTED.marker"), "imported")
export default {
  description: "Echo the input text",
  args: { text: { type: "string" } },
  execute: async (args) => "echo:" + args.text,
}
`

/** Collect every record at one wire level while the effect (layer build included) runs. */
const collectLogs = (level: "Debug" | "Warn") => {
  const records: unknown[][] = []
  const collector = Logger.make((options: Logger.Options<unknown>) => {
    if (options.logLevel !== level) return
    records.push(Array.isArray(options.message) ? [...options.message] : [options.message])
  })
  return { records, layer: Logger.layer([collector]) }
}

const collectWarnings = () => collectLogs("Warn")

/** A stand-in for one connected MCP server's tool, in the AI-SDK shape `MCP.tools()` yields. */
const mcpTool = (text: string): McpExternal.AiSdkTool => ({
  description: "an MCP tool",
  inputSchema: { jsonSchema: { type: "object", properties: {}, required: [] } },
  execute: async () => ({ content: [{ type: "text", text }] }),
})

/** The five services the aggregate layer reads: config dirs, location, permission, MCP, plugin store. */
const testBase = (
  root: ReturnType<typeof AbsolutePath.make>,
  origin: string,
  mcpTools: Record<string, McpExternal.AiSdkTool>,
) =>
  Layer.mergeAll(
    Layer.succeed(
      Config.Service,
      Config.Service.of({ entries: () => Effect.succeed([new Config.Directory({ type: "directory", path: root })]) }),
    ),
    Layer.mock(Location.Service, { directory: root, root, origin: Project.ID.make(origin) }),
    Layer.mock(PermissionV2.Service, { assert: () => Effect.void }),
    Layer.mock(MCP.Service, { tools: () => Effect.succeed(mcpTools) }),
    PluginTools.layer,
  )

/** The real aggregate layer (`AggregateExternalToolSource.layer`) behind a real `ToolRegistry`. */
const registryOver = (base: ReturnType<typeof testBase>) =>
  ToolRegistry.layer.pipe(
    Layer.provide(AggregateExternalToolSource.layer.pipe(Layer.provide(base))),
    Layer.provide(ApplicationTools.layer),
    Layer.provide(ToolOutputStore.defaultLayer),
    Layer.provide(base),
  )

const settleCall = (name: string, input: Record<string, unknown>, tag: string) =>
  Effect.gen(function* () {
    const service = yield* ToolRegistry.Service
    const materialized = yield* service.materialize([], undefined, new Set([name]))
    const settlement = yield* materialized.settle({
      sessionID: SessionV2.ID.make(`ses_${tag}`),
      agent: AgentV2.ID.make("build"),
      assistantMessageID: SessionMessage.ID.make(`msg_${tag}`),
      call: { type: "tool-call", id: `call-${tag}`, name, input },
    })
    return settlement
  })

describe("AggregateExternalToolSource", () => {
  // RULING 5 gate. A config-dir tool file is inert: not imported, not advertised —
  // and the user is TOLD, by directory and by filename, rather than left with a
  // directory that silently does nothing (ruling 2).
  test("does not load a config-dir tool file, and warns by name that it was skipped", async () => {
    await using tmp = await tmpdir<void>({
      init: async (dir) => {
        await Bun.write(path.join(dir, "tool", "echo.ts"), TOOL_FILE)
      },
    })
    const root = AbsolutePath.make(tmp.path)
    const marker = path.join(tmp.path, "tool", "IMPORTED.marker")

    const base = testBase(root, "prj_ruling5", {})
    const { records, layer: loggerLayer } = collectWarnings()

    const program = Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      const materialized = yield* service.materialize()
      expect(materialized.definitions.map((definition) => definition.name)).not.toContain("echo")
    })

    await Effect.runPromise(
      program.pipe(Effect.scoped, Effect.provide(registryOver(base)), Effect.provide(loggerLayer)),
    )

    // The module-level side effect never ran => the file was never imported.
    expect(await Bun.file(marker).exists()).toBe(false)

    // ...and the skip is stated out loud, naming the directory, the file, and MCP.
    expect(records).toEqual([
      [
        { event: "tool.config.load.skipped" },
        "NOT LOADED: config-dir tool files were ignored. NovaClaw no longer runs third-party tool code inside its own process, so these files are NOT providing any tool to your sessions. MCP is the supported out-of-process tool seam: re-expose them as an MCP server and connect it with `novaclaw mcp add`. Delete the directory to silence this warning.",
        { "tool.directory": tmp.path, "tool.files": "tool/echo.ts", "tool.count": 1 },
      ],
    ])
  })

  // No config dir, no warning — the honest surface must not cry wolf.
  test("stays silent when no config-dir tool files exist", async () => {
    await using tmp = await tmpdir<void>({ init: async () => {} })
    const root = AbsolutePath.make(tmp.path)

    const base = testBase(root, "prj_quiet", {})
    const { records, layer: loggerLayer } = collectWarnings()

    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* ToolRegistry.Service
        yield* service.materialize()
      }).pipe(Effect.scoped, Effect.provide(registryOver(base)), Effect.provide(loggerLayer)),
    )

    expect(records).toEqual([])
  })

  test("degrades an unreadable config-dir scan to a keyed debug record", async () => {
    await using tmp = await tmpdir<void>({ init: async () => {} })
    const blocked = AbsolutePath.make(tmp.path)
    const configLayer = Layer.succeed(
      Config.Service,
      Config.Service.of({
        entries: () => Effect.succeed([new Config.Directory({ type: "directory", path: blocked })]),
      }),
    )
    const { records, layer: loggerLayer } = collectLogs("Debug")

    await Effect.runPromise(
      AggregateExternalToolSource.warnRetiredConfigDirTools(() => {
        throw new Error("scan denied")
      }).pipe(
        Effect.provideService(References.MinimumLogLevel, "Debug"),
        Effect.provide(configLayer),
        Effect.provide(loggerLayer),
      ),
    )

    expect(records).toHaveLength(1)
    expect(records[0]).toEqual([
      { event: "tool.config.scan.failed" },
      "could not scan config dir for retired tool files",
      { "tool.directory": blocked, "tool.error": expect.any(String) },
    ])
  })

  // The MCP rung — the seam ruling 5 keeps — is deferred, discoverable, and still executes.
  test("serves an MCP tool through ToolRegistry.materialize", async () => {
    await using tmp = await tmpdir<void>({ init: async () => {} })
    const root = AbsolutePath.make(tmp.path)

    const base = testBase(root, "prj_mcp", { searxng_search: mcpTool("MCP:results") })

    const settlement = await Effect.runPromise(
      settleCall("searxng_search", {}, "mcp").pipe(Effect.scoped, Effect.provide(registryOver(base))),
    )
    expect(settlement.result).toEqual({ type: "text", value: McpExternal.FRAME + "MCP:results" })
  })

  test("keeps external schemas out of the resident array and unlocks settlement only after discovery", async () => {
    await using tmp = await tmpdir<void>({ init: async () => {} })
    const root = AbsolutePath.make(tmp.path)
    const base = testBase(root, "prj_deferred", { github_create_issue: mcpTool("created") })

    const program = Effect.gen(function* () {
      const service = yield* ToolRegistry.Service
      yield* service.register({
        tool_call: ToolRegistry.withDeferredDispatcher(
          Tool.makeExternal({
            description: "test dispatcher",
            inputSchema: { type: "object" },
            execute: (raw, context) => {
              const input = raw as { name: string; input: Record<string, unknown> }
              if (!context.invokeDeferred) return Effect.fail(new Tool.Failure({ message: "dispatcher unavailable" }))
              return context.invokeDeferred(input.name, input.input).pipe(
                Effect.map((output) => ({
                  structured: output.structured,
                  content: output.content.flatMap((part) => (part.type === "text" ? [part] : [])),
                })),
              )
            },
          }),
        ),
      })
      const before = yield* service.materialize()
      const after = yield* service.materialize([], undefined, new Set(["github_create_issue"]))
      expect(before.deferred.map((source) => source.definition.name)).toEqual(["github_create_issue"])
      expect(JSON.stringify(after.definitions)).toBe(JSON.stringify(before.definitions))

      const input = {
        sessionID: SessionV2.ID.make("ses_deferred"),
        agent: AgentV2.ID.make("build"),
        assistantMessageID: SessionMessage.ID.make("msg_deferred"),
        call: {
          type: "tool-call" as const,
          id: "call-deferred",
          name: "tool_call",
          input: { name: "github_create_issue", input: {} },
        },
      }
      expect((yield* before.settle(input)).result).toMatchObject({
        type: "error",
        value: expect.stringContaining("Call tool_search"),
      })
      expect((yield* after.settle(input)).result).toEqual({ type: "text", value: McpExternal.FRAME + "created" })
    })

    await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(registryOver(base))))
  })

  // PRECEDENCE PIN. Two rungs remain and they must not be ambiguous: the aggregate
  // seeds MCP first and lets a plugin registration overwrite it, so plugin > MCP.
  test("resolves a plugin/MCP name collision in favour of the plugin tool", async () => {
    await using tmp = await tmpdir<void>({ init: async () => {} })
    const root = AbsolutePath.make(tmp.path)

    const base = testBase(root, "prj_collide", { shout: mcpTool("MCP:shout") })

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

      // Both rungs offer `shout`; exactly one deferred registration survives the merge.
      const service = yield* ToolRegistry.Service
      const materialized = yield* service.materialize()
      expect(materialized.definitions).toEqual([])
      expect(materialized.deferred.filter((source) => source.definition.name === "shout").length).toBe(1)

      return yield* settleCall("shout", { text: "hi" }, "collide")
    })

    const settlement = await Effect.runPromise(
      program.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(registryOver(base), base))),
    )
    // The PLUGIN body ran, not the MCP one — deterministically, on every run.
    expect(settlement.result).toEqual({ type: "text", value: "SHOUT:HI" })
  })

  // The plugin rung on its own (F1a plugin-tool parity): a tool REGISTERED through
  // the V2 `PluginTools` store is deferred and settles after transcript discovery.
  test("serves a V2-plugin-registered tool through ToolRegistry.materialize", async () => {
    await using tmp = await tmpdir<void>({ init: async () => {} })
    const root = AbsolutePath.make(tmp.path)

    const base = testBase(root, "prj_plugintools", {})

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
      expect(materialized.definitions.map((definition) => definition.name)).not.toContain("shout")
      expect(materialized.deferred.map((source) => source.definition.name)).toContain("shout")

      return yield* settleCall("shout", { text: "hi" }, "plugintools")
    })

    // `base` (incl. the PluginTools store layer) appears in BOTH the registry graph
    // and the program's own environment — same layer reference, so Effect memoizes
    // it to ONE store instance; the program's `register` is visible to the registry.
    const settlement = await Effect.runPromise(
      program.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(registryOver(base), base))),
    )
    expect(settlement.result).toEqual({ type: "text", value: "SHOUT:HI" })
  })
})
