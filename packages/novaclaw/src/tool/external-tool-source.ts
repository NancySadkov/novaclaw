export * as AggregateExternalToolSource from "./external-tool-source"

import { Cause, Effect, JsonSchema, Layer } from "effect"
import { ExternalToolSource } from "@novaclaw/core/tool/external-tool-source"
import { PluginTools } from "@novaclaw/core/tool/plugin-tools"
import { Tool } from "@novaclaw/core/tool/tool"
import { Config } from "@novaclaw/core/config"
import { Location } from "@novaclaw/core/location"
import { PermissionV2 } from "@novaclaw/core/permission"
import { Glob } from "@novaclaw/core/util/glob"
import { makeLocationNode } from "@novaclaw/core/effect/app-node"
import { type ToolContext as PluginToolContext, type ToolDefinition } from "@novaclaw/plugin"
import path from "path"
import { pathToFileURL } from "url"
import { MCP } from "@/mcp"
import { McpExternalToolSource } from "@/mcp/external-tool-source"
import { isPluginTool, pluginToolSchema } from "./plugin-schema"

// F1a SLICE 1 (keystone): the V2 `ExternalToolSource` aggregator. Merges the MCP
// source (unchanged) with CUSTOM tools discovered from config-dir
// `{tool,tools}/*.{js,ts}` files — the tools that used to force a session onto the
// legacy V1 engine (`ToolRegistry.hasCustom` → the `promptAsync` fallback) — and
// (F1a plugin-tool parity) tools REGISTERED by V2 plugins via `ctx.tool.register`
// (the core `PluginTools` store). With this providing `ExternalToolSource.Service`,
// a custom- or plugin-tool turn materializes its tools on the V2 registry, so the
// legacy fallbacks are retired. The V1 plugin `tool:` map (the legacy Hooks API)
// deliberately has NO V2 bridge — plugin tools are declared through the V2 plugin
// API; the Hooks shape dies with the V1 engine (F1f).
//
// Discovery uses the V2-native `Config.Service` already in the location graph (its
// `Directory` entries ARE the config dirs), so — unlike the design map's Option 1 —
// no V1 `InstanceRef`/`Config` bridging is needed.

// A plugin tool's `execute` receives an `AbortSignal`; the V2 tool context carries
// no abort (Effect interruption can't reach into an in-flight Promise anyway), so a
// never-aborting signal preserves the contract. Residue: real cancellation parity.
const NEVER_ABORT = new AbortController().signal

// Adapt one plugin-shaped `ToolDefinition` (config-dir file export or V2-plugin
// registration) into a V2 core `AnyTool`. Mirrors the V1 `fromPlugin` (registry.ts)
// minus the V1-only bits: output truncation is handled downstream by the registry's
// `ToolOutputStore.bound`, and `ask` is best-effort (the per-call
// `PermissionV2.assert` gate is the real enforcement — 1J: a denial is the tool
// result, never a halt). Zod args are validated for parity.
export const makeDefinitionAdapter = Effect.gen(function* () {
  const location = yield* Location.Service
  const permission = yield* PermissionV2.Service

  const fromDefinition = (name: string, def: ToolDefinition): Tool.AnyTool =>
    Tool.makeExternal({
      description: def.description,
      inputSchema: pluginToolSchema(def).jsonSchema as unknown as JsonSchema.JsonSchema,
      execute: (input, context) =>
        Effect.gen(function* () {
          yield* permission
            .assert({
              sessionID: context.sessionID,
              action: name,
              resources: ["*"],
              save: ["*"],
              source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              agent: context.agent,
            })
            .pipe(
              Effect.mapError(
                (error) =>
                  new Tool.Failure({
                    message:
                      PermissionV2.denialMessage(error) ??
                      `Permission check failed for tool '${name}': ${String(error)}`,
                  }),
              ),
            )
          const { zodParams } = pluginToolSchema(def)
          if (zodParams) {
            const parsed = zodParams.safeParse(input)
            if (!parsed.success)
              return yield* Effect.fail(new Tool.Failure({ message: `Invalid tool input: ${parsed.error.message}` }))
          }
          const pluginCtx: PluginToolContext = {
            sessionID: context.sessionID,
            messageID: context.assistantMessageID,
            agent: context.agent,
            directory: location.directory,
            worktree: location.directory,
            abort: NEVER_ABORT,
            metadata: () => {},
            ask: async () => {},
          }
          const result = yield* Effect.tryPromise({
            try: () => def.execute(input as Parameters<typeof def.execute>[0], pluginCtx),
            catch: (error) => new Tool.Failure({ message: error instanceof Error ? error.message : String(error) }),
          })
          const output = typeof result === "string" ? result : result.output
          const title = typeof result === "string" ? "" : (result.title ?? "")
          const metadata = typeof result === "string" ? {} : (result.metadata ?? {})
          return { structured: { title, output, metadata }, content: [{ type: "text" as const, text: output }] }
        }),
    })

  return fromDefinition
})

// Config-dir custom tool source. Discovered ONCE when the location layer boots (V1
// parity — the V1 registry globs + imports once in `InstanceState.make`), so each
// entry's `identity` object is stable for the location's lifetime and the registry's
// stale-call guard never re-mints mid-turn.
export const makeCustom = Effect.gen(function* () {
  const config = yield* Config.Service
  const fromDefinition = yield* makeDefinitionAdapter

  const entries = new Map<string, ExternalToolSource.Entry>()
  const dirs = (yield* config.entries()).flatMap((entry) => (entry.type === "directory" ? [entry.path] : []))
  const matches = dirs.flatMap((dir) =>
    Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true }),
  )
  for (const match of matches) {
    const namespace = path.basename(match, path.extname(match))
    // Import as `file://` so Node on Windows accepts the absolute path. A bad tool
    // file must not sink the session — log and skip it (stricter than V1, which dies).
    const mod = yield* Effect.promise(() => import(pathToFileURL(match).href)).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("skipping unloadable config-dir tool file " + match + ": " + Cause.pretty(cause)).pipe(
          Effect.as({} as Record<string, unknown>),
        ),
      ),
    )
    for (const [id, def] of Object.entries(mod as Record<string, unknown>)) {
      if (!isPluginTool(def)) continue
      const toolName = id === "default" ? namespace : `${namespace}_${id}`
      entries.set(toolName, { identity: {}, tool: fromDefinition(toolName, def) })
    }
  }

  return ExternalToolSource.Service.of({ entries: () => Effect.succeed(entries) })
})

// V2-plugin-registered tool source (F1a plugin-tool parity). Unlike the boot-time
// config-dir snapshot, plugins register/unregister at any time, so the map is
// rebuilt per call from the LIVE `PluginTools` store — but each adapted entry is
// cached per registration `identity`, so the registry's stale-call guard sees a
// stable identity + tool object for as long as that registration lives.
export const makePluginRegistered = Effect.gen(function* () {
  const pluginTools = yield* PluginTools.Service
  const fromDefinition = yield* makeDefinitionAdapter
  const cache = new WeakMap<object, ExternalToolSource.Entry>()

  return ExternalToolSource.Service.of({
    entries: () =>
      Effect.map(pluginTools.entries(), (source) => {
        const entries = new Map<string, ExternalToolSource.Entry>()
        for (const [name, item] of source) {
          const cached = cache.get(item.identity)
          const entry = cached ?? { identity: item.identity, tool: fromDefinition(name, item.definition) }
          if (!cached) cache.set(item.identity, entry)
          entries.set(name, entry)
        }
        return entries
      }),
  })
})

// The aggregate source: MCP + V2-plugin-registered + config-dir custom entries in
// one map. Each sub-source caches its own entries (stable identities), so the merged
// map — rebuilt per call but referencing those cached entries — keeps identities
// stable. On a name collision the LAST set wins: a config-dir tool (the user's own
// file) beats a plugin-registered tool, which beats an MCP tool.
export const layer = Layer.effect(
  ExternalToolSource.Service,
  Effect.gen(function* () {
    const mcp = yield* McpExternalToolSource.make
    const plugin = yield* makePluginRegistered
    const custom = yield* makeCustom
    return ExternalToolSource.Service.of({
      entries: () =>
        Effect.gen(function* () {
          const merged = new Map<string, ExternalToolSource.Entry>(yield* mcp.entries())
          for (const [name, entry] of yield* plugin.entries()) merged.set(name, entry)
          for (const [name, entry] of yield* custom.entries()) merged.set(name, entry)
          return merged
        }),
    })
  }),
)

export const node = makeLocationNode({
  service: ExternalToolSource.Service,
  layer,
  deps: [MCP.node, Location.node, PermissionV2.node, Config.node, PluginTools.node],
})
