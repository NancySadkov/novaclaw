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

    // ── WHY THIS IS A HORIZON PREDICATE AND NOT A REGISTRATION GATE (B7 tier-2a) ──────────────────
    //
    // ⚠️ **The precedent the old comment cited here was wrong in fact, and that is why this item
    // needed a second attempt.** It said "gate registration like websearch". `tool/websearch.ts`
    // does not import `Config` at all: it registers unconditionally and gates at EXECUTION time
    // through `permission.assert`, and its own comment block explains why (an egress channel is
    // governed by PermissionV2, not by a config key). Nothing else in the tree gated registration on
    // config — this file was the only one. Recorded so the next reader does not re-derive it.
    //
    // The real defect was todo.md **ruling 3** — *read every runtime-editable value through to its
    // store at the point of use; a settings change is not a reboot*. The gate ran once, inside this
    // layer's Effect body, i.e. at location-open time, so turning profile sharing ON in Settings did
    // nothing until the location reopened — and the only repair was tearing the whole layer graph
    // down (`markInstanceForDisposal`), which is the stop-the-world teardown B7 exists to delete.
    // Three ways out were on the table:
    //
    //  1. **Register unconditionally, refuse at execution** (the websearch shape). REJECTED: it puts
    //     a tool the user has switched off on the model's horizon and spends a turn to say no. The
    //     registry already takes the opposite position on the permission axis — `whollyDisabled`
    //     WITHDRAWS a wholly-denied tool from `materialize` rather than letting it be called — so
    //     answering "is this tool available" a second, different way is ruling 6's forbidden shape.
    //  2. **Hoist the read into `ToolRegistry.materialize` itself.** REJECTED: the registry would
    //     have to depend on `Config` and know this tool by name, and every tool would pay the read.
    //  3. **What shipped:** the registry keeps a generic, per-tool availability predicate
    //     (`ToolRegistry.withAvailability`) evaluated when the horizon is built, and the predicate
    //     lives HERE, where the config key is already understood. The tool is genuinely ABSENT while
    //     sharing is off — the same withdrawal seam `whollyDisabled` uses, so the model never sees
    //     it — and it is absent LIVE, because `materialize` runs per turn and per step.
    //
    // ── AND THE GATE IS HALF WHAT IT WAS: `hasContent` WAS NEVER AN AVAILABILITY FACT ─────────────
    //
    // The old condition was `shareEnabled && hasContent`, and treating those as one thing was the
    // second bug. They answer different questions:
    //   · `enabled !== false` is the USER'S EXPLICIT SWITCH — a statement about the CAPABILITY.
    //     "Do not share my profile with the model" is honestly rendered as absence.
    //   · an empty `name`/`about` is a statement about the DATA, not the capability. The tool answers
    //     that truthfully already ("The user has not filled in any profile details yet."), which is
    //     ruling 2's *an unavailable subsystem names itself instead of rendering empty* — a tool that
    //     quietly is not there renders empty. Collapsing the two also made "the user forbade this"
    //     and "the user has not typed anything yet" indistinguishable from the model's side, which is
    //     the same ruling's *a fault is never described falsely* read from the other end.
    //
    // The practical half, which is what settles it: `hasContent` is the condition that flips OFTEN
    // and INCIDENTALLY — a user typing their name in Settings — and every flip rewrites the
    // advertised tool array mid-conversation, invalidating the whole prompt-prefix cache
    // (todo/tool-scale.md T2: discovery must be append-only for exactly this reason). The switch
    // flips rarely and deliberately, and making it apply *now* is the entire point of ruling 3. So
    // the horizon churns only where churn is the feature. Sharing stays OPT-OUT (`!== false`) so a
    // profile filled in before the switch existed keeps working.
    //
    // ⚠️ **Cost, because this lands on a hot path.** `materialize` runs per turn AND per step
    // (`session/runner/llm.ts`), so this is one `Config.entries()` per step: a single `SELECT` over
    // `runtime_setting` plus a per-key decode — the same read `Config.entries()` already performs per
    // turn for the harness derivation and per call for `tool/bash.ts`. MEASURED, not assumed
    // (2026-07-31, `test/tool-profile-availability.test.ts`, 50 rounds after warm-up, 28 tools on the
    // horizon): `materialize()` costs **0.029 ms** with the predicate frozen and **0.570 ms** with it
    // live, i.e. this predicate is **~0.54 ms per step** — the whole of `Config.entries()`. That is
    // ~13 ms over a 20-step turn, against a ~30 ms location boot and seconds of model latency. The
    // test keeps a generous ceiling so a future predicate doing real I/O fails loudly.
    //
    // ⚠️ A store failure DIES rather than defaulting, deliberately: this is a privacy switch, so
    // "assume sharing is on" is the wrong answer to "I could not read your setting", and
    // `Config.entries()` already dies the same way on the per-turn path. Do not wrap it fail-open.
    const sharingEnabled = config
      .entries()
      .pipe(Effect.map((entries) => Config.latest(entries, "user_profile")?.enabled !== false))

    yield* tools
      .register({
        [name]: ToolRegistry.withAvailability(
          Tool.withDeferred(
            Tool.make({
              description,
              input: Input,
              output: Output,
              toModelOutput: ({ output }) => [{ type: "text", text: toModelOutput(output) }],
              // Reads through to the settings store on every call (ruling 3), so a profile edited
              // mid-session is what the next call returns — there is no registration-time snapshot to
              // go stale. `username` is the legacy name fallback (mirrors B4).
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
          ),
          sharingEnabled,
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/profile",
  layer,
  deps: [ToolRegistry.node, Config.node],
})
