export * as SystemContextBuiltIns from "./builtins"

import { makeLocationNode } from "../effect/app-node"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Location } from "../location"
import { SystemContext } from "./index"
import { InstructionContext } from "../instruction-context"
import { SystemContextRegistry } from "./registry"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { SettingsConfigStore } from "../settings-config-store"
import { Shell } from "../shell"

const builtIns = Layer.effectDiscard(
  Effect.gen(function* () {
    const location = yield* Location.Service
    const registry = yield* SystemContextRegistry.Service
    const settingsStore = yield* SettingsConfigStore.Service
    // P2P: tell the model about configured peer instances — full free-form HTTP access with the
    // token from env (the bash tool injects NOVACLAW_INSTANCE_<NAME>_URL/_TOKEN; tokens are never
    // printed into the prompt itself).
    const peers = ((yield* settingsStore.all()).instances ?? []) as Array<{ name: string; url: string }>
    const peerLines = peers.map((peer) => {
      const key = peer.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")
      return `  Peer instance "${peer.name}": ${peer.url} — same HTTP API as this instance (sessions, registry, config). Drive it from bash, e.g. curl -u "novaclaw:$NOVACLAW_INSTANCE_${key}_TOKEN" $NOVACLAW_INSTANCE_${key}_URL/api/session (the env vars are preset).`
    })
    const environment = [
      "<env>",
      `  Working directory: ${location.directory}`,
      `  Workspace root folder: ${location.root}`,
      `  Is directory a git repo: ${location.vcs?.type === "git" ? "yes" : "no"}`,
      `  Platform: ${process.platform}`,
      `  Shell: ${Shell.agentDefault()}`,
      // The agent shell is bash almost everywhere, and the tool descriptions + the shipped recipes
      // all assume it. When the fallback fires (Windows without the provisioned bundle or a system
      // git-bash) the model MUST be told, or it writes POSIX at cmd.exe and the task dies of
      // unrelated-looking errors — measured 2026-07-26: the same π prompt scored 1/100 digits under
      // a silent cmd.exe and 100/100 under bash.
      ...(Shell.bashFallbackNote() ? [`  ${Shell.bashFallbackNote()}`] : []),
      ...peerLines,
      "</env>",
    ].join("\n")
    const context = SystemContext.combine([
      SystemContext.make({
        key: SystemContext.Key.make("core/environment"),
        codec: Schema.toCodecJson(Schema.String),
        load: Effect.succeed(environment),
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
  deps: [Location.node, SystemContextRegistry.node, InstructionContext.node, FSUtil.node, Global.node, SettingsConfigStore.node],
})
