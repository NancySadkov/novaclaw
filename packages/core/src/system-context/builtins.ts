export * as SystemContextBuiltIns from "./builtins"

import { makeLocationNode } from "../effect/app-node"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Location } from "../location"
import { ProjectFileCache } from "../project-file-cache"
import { SystemContext } from "./index"
import { InstructionContext } from "../instruction-context"
import { SystemContextRegistry } from "./registry"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { SettingsConfigStore } from "../settings-config-store"
import { Shell } from "../shell"
import { ResourcePressureContext } from "../resource-pressure-context"
import { McpHealthContext } from "../mcp-health-context"
import { CapabilityRegistry } from "../effect/capability-registry"

const builtIns = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* SystemContextRegistry.Service
    const settingsStore = yield* SettingsConfigStore.Service
    const resourcePressure = yield* ResourcePressureContext.Service
    const mcpHealth = yield* McpHealthContext.Service
    const capabilities = yield* CapabilityRegistry.Service
    // P2P: tell the model about configured peer instances — full free-form HTTP access with the
    // token from env (the bash tool injects NOVACLAW_INSTANCE_<NAME>_URL/_TOKEN; tokens are never
    // printed into the prompt itself).
    const peers = ((yield* settingsStore.all()).instances ?? []) as Array<{ name: string; url: string }>
    const peerLines = peers.map((peer) => {
      const key = peer.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")
      return `  Peer instance "${peer.name}": ${peer.url} — same HTTP API as this instance (sessions, registry, config). Drive it from bash, e.g. curl -u "novaclaw:$NOVACLAW_INSTANCE_${key}_TOKEN" $NOVACLAW_INSTANCE_${key}_URL/api/session (the env vars are preset).`
    })
    const environment = Effect.all([resourcePressure.lines(), mcpHealth.lines(), capabilities.lines()]).pipe(
      Effect.map(([resourceLines, mcpLines, capabilityLines]) =>
        [
          "<env>",
          // The working folder/project horizon is deliberately NOT frozen into this baseline.
          // `runner/project-grounding.ts` projects it initially, after compaction, after each 64K
          // context growth interval, and on a location change. Keeping it here as well repeated the
          // cwd preamble in every provider payload and defeated that cadence.
          `  Platform: ${process.platform}`,
          `  Shell: ${Shell.agentDefault()}`,
          // The agent shell is bash almost everywhere, and the tool descriptions + the shipped recipes
          // all assume it. When the fallback fires (Windows without the provisioned bundle or a system
          // git-bash) the model MUST be told, or it writes POSIX at cmd.exe and the task dies of
          // unrelated-looking errors — measured 2026-07-26: the same π prompt scored 1/100 digits under
          // a silent cmd.exe and 100/100 under bash.
          ...(Shell.shellFallbackNote() ? [`  ${Shell.shellFallbackNote()}`] : []),
          ...resourceLines.map((line) => `  ${line}`),
          // Only when a CONFIGURED MCP server is not usable. Empty for a healthy set, so the block is
          // byte-identical to one built without this seam — see `mcp-health-context.ts` for the whole
          // decision, and the "loads location-scoped environment" case in
          // `test/system-context/builtins.test.ts` for the check that keeps it that way. A server the
          // user switched OFF is deliberately absent from this list: that is a preference, not a fault.
          ...mcpLines.map((line) => `  ${line}`),
          // Generic lazy-capability failures use the same exception-only ambient channel. Merely
          // reading these lines never starts an idle capability; healthy/idle/starting is [] exactly.
          ...capabilityLines.map((line) => `  ${line}`),
          ...peerLines,
          "</env>",
        ].join("\n"),
      ),
    )
    const context = SystemContext.combine([
      SystemContext.make({
        key: SystemContext.Key.make("core/environment"),
        codec: Schema.toCodecJson(Schema.String),
        // Resource headroom and MCP server health are both live per turn. Keeping this as an Effect
        // instead of freezing the string at location boot lets SystemContext.reconcile tell the model
        // when the machine moves across a pressure line — or when a configured MCP server drops or
        // comes back — without restarting the instance, and pays for it in a TAIL update rather than
        // a prompt-prefix re-render.
        load: environment,
        baseline: (environment) =>
          ["Here is some useful information about the environment you are running in:", environment].join("\n"),
        update: (_previous, environment) => ["The environment you are running in is now:", environment].join("\n"),
      }),
      SystemContext.make({
        key: SystemContext.Key.make("core/date"),
        codec: Schema.toCodecJson(Schema.String),
        load: DateTime.nowAsDate.pipe(Effect.map((date) => date.toDateString())),
        baseline: (date) => `Today's date: ${date}`,
        update: (_previous, date) => `Today's date is now: ${date}`,
      }),
    ])

    yield* registry.register({ key: SystemContext.Key.make("core/builtins"), load: Effect.succeed(context) })
  }),
)

export const layer = Layer.mergeAll(builtIns, InstructionContext.layer).pipe(
  Layer.provideMerge(SystemContextRegistry.layer),
)

export const locationLayer = layer

export const node = makeLocationNode({
  name: "system-context-builtins",
  layer,
  deps: [
    Location.node,
    SystemContextRegistry.node,
    InstructionContext.node,
    FSUtil.node,
    Global.node,
    SettingsConfigStore.node,
    ResourcePressureContext.node,
    McpHealthContext.node,
    CapabilityRegistry.node,
    // `InstructionContext` screens discovered AGENTS.md files against the project's `exclude` list.
    ProjectFileCache.node,
  ],
})
