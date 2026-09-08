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
import { McpHealthContext } from "../mcp-health-context"
import { CapabilityRegistry } from "../effect/capability-registry"

/**
 * The environment update, as a DIFF rather than a full re-render. Resource pressure deliberately
 * does not enter this ambient block any more: it is a targeted, configurable Nudge hook. Removals
 * for MCP/capability state are still reported, because silently retaining a cleared fault would
 * leave the model reasoning against an outage that no longer exists.
 */
export const environmentUpdate = (previous: string, current: string): string => {
  const meaningful = (text: string) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && line !== "<env>" && line !== "</env>")
  const before = meaningful(previous)
  const after = meaningful(current)
  const added = after.filter((line) => !before.includes(line))
  /**
   * ⚠️ A line whose VALUE moved is an update, not a removal. These read `<subject>: <value>`
   * ("Memory headroom is low: 40655 MB of 43954 MB committed"), so a gone line is SUPERSEDED when an
   * added line shares its subject — and emitting "No longer applies" for it would nearly double the
   * notice while telling the model nothing, which is the bloat this change exists to remove.
   */
  const subject = (line: string) => line.slice(0, line.indexOf(":") + 1 || line.length)
  const addedSubjects = new Set(added.map(subject))
  const gone = before.filter((line) => !after.includes(line) && !addedSubjects.has(subject(line)))
  // Nothing line-level to report (wrapper or whitespace churn): fall back to the whole render
  // rather than emitting an empty notice.
  if (added.length === 0 && gone.length === 0) return ["The environment you are running in is now:", current].join("\n")
  return [
    "The environment you are running in has changed:",
    ...added.map((line) => `  ${line}`),
    ...gone.map((line) => `  No longer applies: ${line}`),
  ].join("\n")
}

export interface EnvironmentObservation {
  readonly rendered: string
  readonly observedAt: number
}

/** Environment changes other than resource pressure remain ordinary exact-value updates. Resource
 * warnings moved to the user-configurable Nudge dispatcher, where an hourly occurrence key bounds
 * repetition without depositing near-identical `<env>` blocks in the transcript. */
export const environmentEquivalent = (previous: EnvironmentObservation, current: EnvironmentObservation): boolean =>
  previous.rendered === current.rendered

const builtIns = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* SystemContextRegistry.Service
    const settingsStore = yield* SettingsConfigStore.Service
    const mcpHealth = yield* McpHealthContext.Service
    const capabilities = yield* CapabilityRegistry.Service
    // P2P: tell the model about configured peer instances — full free-form HTTP access with the
    // token from env (the bash tool injects NOVACLAW_INSTANCE_<NAME>_URL/_TOKEN; tokens are never
    // printed into the prompt itself).
    // ⚠️ SORTED: this renders into the system prompt, and settings order is AUTHORING order —
    // adding a peer would otherwise reshuffle the block and re-prefill everything after it
    // (NC-PROMPT-CACHE-007).
    const peers = (((yield* settingsStore.all()).instances ?? []) as Array<{ name: string; url: string }>).toSorted(
      (a, b) => a.name.localeCompare(b.name),
    )
    const peerLines = peers.map((peer) => {
      const key = peer.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")
      return `  Peer instance "${peer.name}": ${peer.url} — same HTTP API as this instance (sessions, registry, config). Drive it from bash, e.g. curl -u "novaclaw:$NOVACLAW_INSTANCE_${key}_TOKEN" $NOVACLAW_INSTANCE_${key}_URL/api/session (the env vars are preset).`
    })
    const environment = Effect.all([mcpHealth.lines(), capabilities.lines(), DateTime.nowAsDate]).pipe(
      Effect.map(([mcpLines, capabilityLines, observedAt]) => ({
        observedAt: observedAt.getTime(),
        rendered: [
          "<env>",
          // 🔴 The working folder/project horizon is deliberately NOT frozen into this baseline, and
          // this block is NOT one of its owners in any posture. `runner/project-grounding.ts` holds
          // the `Horizon` table that says who delivers it for a chat request — the cadence in an
          // ordinary chat, a one-line system part in Fast Chat — and the jh step prompt carries its
          // own on its own path. That table is total and has no "nobody" in it, which is the point:
          // this comment used to name ONE owner that could be switched off, and when it was, two
          // postures were left with no horizon at all (measured 2026-09-02).
          //
          // ⚠️ Do not "fix" a missing horizon by adding the cwd here. This baseline cannot see the
          // session's mode, it repeats the preamble in every provider payload (which is what the
          // cadence exists to avoid), and it does not render AT ALL in Fast Chat — the runner's
          // context load short-circuits to `SystemContext.empty`, so there is no `<env>` block there
          // for a folder line to be missing from.
          `  Platform: ${process.platform}`,
          `  Shell: ${Shell.agentDefault()}`,
          // The agent shell is bash almost everywhere, and the tool descriptions + the shipped recipes
          // all assume it. When the fallback fires (Windows without the provisioned bundle or a system
          // git-bash) the model MUST be told, or it writes POSIX at cmd.exe and the task dies of
          // unrelated-looking errors — measured 2026-07-26: the same π prompt scored 1/100 digits under
          // a silent cmd.exe and 100/100 under bash.
          ...(Shell.shellFallbackNote() ? [`  ${Shell.shellFallbackNote()}`] : []),
          // 🔴 The image toolkit, NAMED (owner, 2026-08-23). A binary the model does not know about
          // is a binary that never gets used — the "built, tested and never called" shape. One line,
          // and it is the line that turns 32 MB on disk into a capability: without it a colleague
          // asked to crop a screenshot reasons about Pillow, npm packages and whether it may install
          // anything, and usually gives up. The verbs are listed because ImageMagick's surface is
          // enormous and a model that knows only the name still has to guess the syntax.
          ...(Shell.imagemagick()
            ? [
                `  Images: \`magick\` (ImageMagick 7) is on your PATH — use it to inspect, convert,`,
                `    crop, resize, annotate and DRAW. Examples: \`magick in.png out.webp\` (convert),`,
                `    \`magick identify in.png\` (dimensions/format), \`magick in.png -crop 100x80+10+10 out.png\`,`,
                `    \`magick -size 64x48 xc:navy -stroke yellow -fill none -draw "rectangle 5,5 30,30" out.png\``,
                `    (primitives: point, line, rectangle, circle, ellipse, polygon, text),`,
                `    \`magick in.png -fill red -draw "point 2,3" out.png\` (set one pixel),`,
                `    \`magick in.png -format "%[pixel:p{2,3}]" info:\` (read one pixel).`,
              ]
            : []),
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
      })),
    )
    const context = SystemContext.combine([
      SystemContext.make({
        key: SystemContext.Key.make("core/environment"),
        codec: Schema.toCodecJson(
          Schema.Struct({
            rendered: Schema.String,
            observedAt: Schema.Number,
          }),
        ),
        // MCP server health is live per turn. Keeping this as an Effect instead of freezing the
        // string at location boot lets SystemContext.reconcile tell the model when a configured MCP
        // server drops or comes back without restarting the instance. Resource pressure is a Nudge
        // hook now and deliberately never enters this ambient block.
        load: environment,
        baseline: (environment) =>
          ["Here is some useful information about the environment you are running in:", environment.rendered].join(
            "\n",
          ),
        update: (previous, current) => environmentUpdate(previous.rendered, current.rendered),
        equivalent: environmentEquivalent,
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
    McpHealthContext.node,
    CapabilityRegistry.node,
    // `InstructionContext` screens discovered AGENTS.md files against the project's `exclude` list.
    ProjectFileCache.node,
  ],
})
