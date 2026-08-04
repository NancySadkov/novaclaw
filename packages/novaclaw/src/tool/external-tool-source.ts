export * as AggregateExternalToolSource from "./external-tool-source"

import { Effect, JsonSchema, Layer } from "effect"
import { ExternalToolSource } from "@novaclaw/core/tool/external-tool-source"
import { PluginTools } from "@novaclaw/core/tool/plugin-tools"
import { Tool } from "@novaclaw/core/tool/tool"
import { Config } from "@novaclaw/core/config"
import { Location } from "@novaclaw/core/location"
import { PermissionV2 } from "@novaclaw/core/permission"
import { Glob } from "@novaclaw/core/util/glob"
import { makeLocationNode } from "@novaclaw/core/effect/app-node"
import { type ToolContext as PluginToolContext, type ToolDefinition } from "@novaclaw/plugin/tool"
import { Log } from "@novaclaw/schema/log"
import path from "path"
import { MCP } from "@/mcp"
import { McpExternalToolSource } from "@/mcp/external-tool-source"
import { pluginToolSchema } from "./plugin-schema"

// The V2 `ExternalToolSource` aggregator. Merges the MCP source with tools
// REGISTERED by V2 plugins via `ctx.tool.register` (the core `PluginTools` store),
// so a plugin-tool turn materializes its tools on the V2 registry. The V1 plugin
// `tool:` map (the legacy Hooks API) deliberately has NO V2 bridge — plugin tools
// are declared through the V2 plugin API; the Hooks shape died with the V1 engine.
//
// ⚠️ RULING 5 — outside code never runs in-process. This file used to carry a THIRD
// source: a `{tool,tools}/*.{js,ts}` walk over the config dirs that did
// `await import(pathToFileURL(match).href)` and turned every matching export into a
// live tool. That is arbitrary third-party code executing inside the kernel process,
// unsandboxed, and it was not even gated by `--pure`/`NOVACLAW_PURE`. **MCP is the
// out-of-process tool seam** — it runs the third party in its own process and gates
// every call through `PermissionV2` (`core/src/tool/mcp-external.ts`'s `gate`). The
// walk is deleted; all that survives of it is `warnRetiredConfigDirTools` below,
// which tells a user with such files that they are NOT loaded rather than ignoring
// them silently (ruling 2 — a fault is never described falsely).

// A plugin tool's `execute` receives an `AbortSignal`; the V2 tool context carries
// no abort (Effect interruption can't reach into an in-flight Promise anyway), so a
// never-aborting signal preserves the contract. Residue: real cancellation parity.
const NEVER_ABORT = new AbortController().signal

// Adapt one plugin-shaped `ToolDefinition` (a V2-plugin `ctx.tool.register`
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

// The glob the RETIRED config-dir tool loader used to import from. Kept only so the
// warning below can name exactly what is being skipped.
export const RETIRED_CONFIG_DIR_TOOL_GLOB = "{tool,tools}/*.{js,ts}"

type RetiredToolScanner = (
  pattern: string,
  options: { cwd: string; absolute: true; dot: true; symlink: true },
) => string[]

/**
 * Ruling 2, the honest half of ruling 5's removal: a config dir that still holds
 * `{tool,tools}/*.{js,ts}` files used to have them imported and run in-process. They
 * are not loaded any more, and a silently-ignored directory is exactly the "lying
 * surface" the ruling forbids — so name the directory, name the files, and point at
 * the replacement seam. Runs once per location boot (where the walk itself used to
 * run). Scan-only: it never reads, parses or imports the file contents.
 *
 * Never fails the boot — an unreadable config dir degrades to a debug line.
 */
export const warnRetiredConfigDirTools = (scan: RetiredToolScanner = Glob.scanSync) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const dirs = (yield* config.entries()).flatMap((entry) => (entry.type === "directory" ? [entry.path] : []))
    for (const dir of dirs) {
      const matches = yield* Effect.try({
        try: () => scan(RETIRED_CONFIG_DIR_TOOL_GLOB, { cwd: dir, absolute: true, dot: true, symlink: true }),
        catch: (error) => error,
      }).pipe(
        Effect.catch((error) =>
          Log.event("tool.config.scan.failed", {
            "tool.directory": dir,
            "tool.error": String(error),
          }).pipe(Effect.as([] as string[])),
        ),
      )
      if (matches.length === 0) continue
      const names = matches.map((match) => path.relative(dir, match).replaceAll("\\", "/")).sort()
      yield* Log.event("tool.config.load.skipped", {
        "tool.directory": dir,
        "tool.files": names.join(", "),
        "tool.count": names.length,
      })
    }
  })

// V2-plugin-registered tool source (F1a plugin-tool parity). Plugins
// register/unregister at any time, so the map is
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

// The aggregate source: MCP + V2-plugin-registered entries in one map. Each
// sub-source caches its own entries (stable identities), so the merged map —
// rebuilt per call but referencing those cached entries — keeps identities stable.
//
// PRECEDENCE (two rungs, since ruling 5 removed the config-dir rung): MCP is seeded
// first and a plugin-registered tool with the same name OVERWRITES it, so
// **plugin > MCP**, deterministically, independent of iteration order within either
// source. Pinned by `test/tool/external-tool-source.test.ts` →
// "resolves a plugin/MCP name collision in favour of the plugin tool".
export const layer = Layer.effect(
  ExternalToolSource.Service,
  Effect.gen(function* () {
    yield* warnRetiredConfigDirTools()
    const mcp = yield* McpExternalToolSource.make
    const plugin = yield* makePluginRegistered
    return ExternalToolSource.Service.of({
      entries: () =>
        Effect.gen(function* () {
          const merged = new Map<string, ExternalToolSource.Entry>(yield* mcp.entries())
          for (const [name, entry] of yield* plugin.entries()) merged.set(name, entry)
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
