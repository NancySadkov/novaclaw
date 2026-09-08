import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { ModelV2 } from "@novaclaw/core/model"
import { ProviderV2 } from "@novaclaw/core/provider"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionRunnerModel } from "@novaclaw/core/session/runner/model"
import { Prompt } from "@novaclaw/core/session/prompt"
import { HARNESS_SESSION, completeTurn, drive, makeRunnerHarness } from "./fixture/runner-harness"

/**
 * **A PRE-TURN failure must be SPOKEN, not merely logged.**
 *
 * The four steps that run before any assistant row exists — the session-config walk, agent
 * selection, context-epoch preparation, model resolution — have nowhere to put an error:
 * `step.failed` carries its error *on an assistant message*, and at this point there is none. So the
 * runner taps each of them and publishes a calm Synthetic notice first. Without it the turn dies in
 * the server log and the chat simply never answers, which is the dead end *It never breaks in your
 * hands* forbids.
 *
 * 🔴 **THIS CLAIM WAS MISSING, AND THE GAP WAS FOUND BY MUTATION.** The four taps were extracted
 * into `prepareTurn`'s `onFailure` parameter (5.1②), and deleting the `Effect.tapError` that applies
 * it left **198 runner tests green**. `session-runner-attachment-gate.test.ts` asserts the same
 * sentence, which is why the hole looked covered — but the capability refusal calls the notice
 * DIRECTLY rather than through the tap, so it survives the deletion. A parameter a refactor can drop
 * in silence is exactly what ruling 1 says ships with a mechanical check.
 *
 * ⚠️ **The lever had to be model resolution, and the two levers that looked better both failed.**
 * `agents.select` returns `Effect.Effect<Selection>` — it cannot fail at all. And an unavailable
 * context source does NOT reach the tapped step: `SessionContextEpoch.initialize` is the cheap
 * "is there already an epoch" probe, it runs before input promotion, and it is deliberately
 * untapped — so blocking the source kills the turn there, with an empty transcript and no notice,
 * which is a REAL pre-existing gap this file does not claim to close. Model resolution is the one
 * tapped step a test can fail on purpose (`controls.modelResolveFailure`, added for this claim),
 * and it is also the step with the dedicated sentence.
 */

const NOTICE = "⚠️ This turn couldn't run"

describe("SessionRunnerLLM — pre-turn failures are spoken in the chat", () => {
  test("an unresolvable model publishes a Synthetic notice instead of failing silently", async () => {
    const harness = makeRunnerHarness({ turns: [completeTurn("never", "unreachable")] })
    // Of the four tapped steps this is the only one a test can make fail on purpose, and it is also
    // the one with a dedicated sentence — see the fixture control's note for why the other three are
    // not reachable levers.
    harness.controls.modelResolveFailure = new SessionRunnerModel.ModelUnavailableError({
      providerID: ProviderV2.ID.make("harness"),
      modelID: ModelV2.ID.make("gone"),
    })

    const context = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Answer me" }),
          resume: false,
        })
        // The error still propagates — the notice is additional, never a swallow. Ruling 2: a fault
        // described to the user and then quietly succeeded would be a worse lie than silence.
        yield* session.resume(HARNESS_SESSION).pipe(Effect.ignore)
        return yield* session.context(HARNESS_SESSION)
      }),
      "claim — a pre-turn failure is spoken",
    )

    // No turn was ever issued: the failure is upstream of the request.
    expect(harness.requests, "the provider is never reached when assembly fails").toHaveLength(0)
    const spoken = JSON.stringify(context)
    expect(spoken, "the user must be told the turn could not run").toContain(NOTICE)
    // …and told WHICH model, by the id the user picked — the half of the sentence that makes the
    // notice actionable rather than decorative.
    expect(spoken).toContain("harness/gone")
  }, 60_000)

  // CONTROL. The same harness with a resolvable model answers normally and says nothing — so the
  // assertion above is about the failure path and not about a notice the runner emits always.
  test("a healthy first turn publishes no such notice (control)", async () => {
    const harness = makeRunnerHarness({ turns: [completeTurn("ok", "Here is your answer.")] })

    const context = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Answer me" }),
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
        return yield* session.context(HARNESS_SESSION)
      }),
      "control — a healthy turn is silent",
    )

    expect(harness.requests).toHaveLength(1)
    expect(JSON.stringify(context)).not.toContain(NOTICE)
  }, 60_000)
})
