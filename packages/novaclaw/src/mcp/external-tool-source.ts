export * as McpExternalToolSource from "./external-tool-source"

import { Cause, Effect, Layer, Ref } from "effect"
import { ExternalToolSource } from "@novaclaw/core/tool/external-tool-source"
import { McpExternal } from "@novaclaw/core/tool/mcp-external"
import { makeLocationNode } from "@novaclaw/core/effect/app-node"
import { Location } from "@novaclaw/core/location"
import { PermissionV2 } from "@novaclaw/core/permission"
import { Tool } from "@novaclaw/core/tool/tool"
import { InstanceRef } from "@/effect/instance-ref"
import type { InstanceContext } from "@/project/instance-context"
import { MCP } from "."

// Novaclaw-side `ExternalToolSource` backed by MCP. Lists connected MCP servers' tools
// (`mcp.tools()` forces lazy connection of configured servers like `npx mcp-searxng`) and
// adapts each to a V2 core tool via `fromMcpTool`. Replaces core's empty `ExternalToolSource`
// node in the V2 location graph (via `buildLocationServiceMap` replacements), so MCP tools
// reach the runner without core depending on novaclaw.
//
// MCP runs against novaclaw's instance context, which the V2 (core) location graph doesn't
// construct — so we bridge a minimal `InstanceRef` from the location's directory (the only
// field MCP/McpAuth read). `Effect.catchCause` keeps a missing-context defect from breaking
// a session. Entries are cached and rebuilt only when the MCP tool-NAME set changes, so
// identities stay stable within a turn (the registry's stale-call guard compares them).
// The Interface-producing Effect, factored out of `layer` so the V2
// `ExternalToolSource` aggregator (`tool/external-tool-source.ts`) can merge MCP
// entries with config-dir custom tools WITHOUT re-deriving the MCP adapter or the
// per-call permission gate. Yields the same MCP/Location/PermissionV2 services the
// aggregator already depends on, so calling it from the aggregator's layer resolves
// against the shared location context.
export const make = Effect.gen(function* () {
  const mcp = yield* MCP.Service
  const location = yield* Location.Service
  const permission = yield* PermissionV2.Service

  // F0: per-call permission ask for MCP tools on the V2 path (V1 parity —
  // session/tools.ts asks `{permission: key, patterns: ["*"], always: ["*"]}`
  // before every MCP call). Action = the tool name; the evaluate fallback for
  // an unmatched action is "ask", so the first call asks and "allow always"
  // persists — exactly the V1 UX. A denial/rejection lowers into the tool
  // result via denialMessage (1J), never a halt.
  const gate = (name: string) => (context: Tool.Context) =>
    permission
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
                `Permission check failed for MCP tool '${name}': ${String(error)}`,
            }),
        ),
      )
  // Minimal instance context: MCP only reads `directory`. `project` is unused on this path.
  const instance = {
    directory: location.directory,
    worktree: location.directory,
    project: {},
  } as unknown as InstanceContext
  const cache = yield* Ref.make<{ key: string; entries: Map<string, ExternalToolSource.Entry> }>({
    key: " uninitialized",
    entries: new Map(),
  })
  return ExternalToolSource.Service.of({
    entries: () =>
      Effect.gen(function* () {
        const tools = yield* mcp
          .tools()
          .pipe(
            Effect.provideService(InstanceRef, instance),
            Effect.catchCause((cause) =>
              Effect.logDebug("MCP tools unavailable for V2 location " + location.directory + ": " + Cause.pretty(cause)).pipe(
                Effect.map(() => ({}) as Record<string, unknown>),
              ),
            ),
          )
        const key = Object.keys(tools).sort().join(" ")
        const current = yield* Ref.get(cache)
        if (key === current.key) return current.entries
        const entries = new Map<string, ExternalToolSource.Entry>()
        for (const [name, tool] of Object.entries(tools))
          entries.set(name, {
            identity: {},
            tool: McpExternal.fromMcpTool(tool as McpExternal.AiSdkTool, { gate: gate(name) }),
          })
        yield* Ref.set(cache, { key, entries })
        return entries
      }),
  })
})

export const layer = Layer.effect(ExternalToolSource.Service, make)

export const node = makeLocationNode({
  service: ExternalToolSource.Service,
  layer,
  deps: [MCP.node, Location.node, PermissionV2.node],
})
