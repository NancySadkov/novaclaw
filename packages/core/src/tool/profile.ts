export * as ProfileTool from "./profile"

import { ToolFailure } from "@novaclaw/llm"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { Config } from "../config"
import { UserProfile } from "../user-profile"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "profile"

export const description = `Look up the user's own profile — the name and background ("about me") they have made available to you. Call this when you need to know who you are helping (to address them by name, or to tailor an answer to their role, expertise, or stated preferences). The user controls what is here; treat it as trusted context they volunteered.`

// No arguments: the whole profile is small and the user owns it, so there is nothing to filter on.
export const Input = Schema.Struct({})

export const Output = Schema.Struct({
  name: Schema.optional(Schema.String),
  about: Schema.optional(Schema.String),
})
export type Output = typeof Output.Type

// Reuse the B4 formatter so the tool speaks the exact block the model already understood as an
// injected layer — "About your user: …". Empty profile still yields a clear, non-scaffolded line.
export const toModelOutput = (output: Output) =>
  UserProfile.resolve(output, {}) ?? "The user has not filled in any profile details yet."

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const config = yield* Config.Service

    // Gate registration like websearch: a config-off tool is absent from the catalog, not
    // advertised-then-refused. Sharing is OPT-OUT (`enabled !== false`) so a profile filled in before the
    // enable switch existed keeps working, and the tool only appears when there's actually something to
    // share (name / about / the legacy `username`). Config is read once at location open, like every
    // config-driven built-in — a just-edited profile takes effect for the next opened location.
    const entries = yield* config.entries()
    const profile = Config.latest(entries, "user_profile")
    const username = Config.latest(entries, "username")
    const shareEnabled = profile?.enabled !== false
    const hasContent = !!(profile?.name?.trim() || profile?.about?.trim() || username?.trim())
    if (!shareEnabled || !hasContent) {
      yield* Effect.logDebug("profile tool not registered: profile sharing is off or empty")
      return
    }

    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
          // Reads the location's config snapshot (the same one entries() returned at registration). A
          // profile edited mid-location is picked up when the location reopens, like other config.
          // `username` is the legacy name fallback (mirrors B4).
          execute: () =>
            config.entries().pipe(
              Effect.map((current) => {
                const p = Config.latest(current, "user_profile")
                const profileName = p?.name?.trim() || Config.latest(current, "username")?.trim() || undefined
                const about = p?.about?.trim() || undefined
                return { name: profileName, about }
              }),
              Effect.mapError(() => new ToolFailure({ message: "Unable to read the user profile" })),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/profile",
  layer,
  deps: [ToolRegistry.node, Config.node],
})
