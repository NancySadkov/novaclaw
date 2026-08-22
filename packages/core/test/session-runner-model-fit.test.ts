import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AgentV2 } from "@novaclaw/core/agent"
import { AgentModelFit } from "@novaclaw/core/agent/model-fit"
import { SessionV2 } from "@novaclaw/core/session"
import { Prompt } from "@novaclaw/core/session/prompt"
import { HARNESS_SESSION, completeTurn, drive, makeRunnerHarness } from "./fixture/runner-harness"

/**
 * THE FIT NOTICE IS ACTUALLY DELIVERED — the half a pure test cannot reach.
 *
 * 🔴 `src/agent/model-fit.test.ts` proves the RULE: when a floor is beneath a bound tier, what the
 * colleague is told, and that a past notice is findable by the check that suppresses it. None of that
 * says the runner ever asks. This session has now shipped three features whose halves were each
 * correct and whose JOIN was never made, so the join gets its own test: drive a real turn, on a
 * colleague with a floor, against a model beneath it, and read the transcript.
 */

/**
 * How the notice names this model.
 *
 * ⚠️ The bare id, because the harness's `models.ref` reports no CATALOG entry — which is the runner's
 * fallback arm, and a fair one to be exercising: a hand-added local model has no catalog ref either.
 * In production the notice names `providerID/modelID` as Settings shows it.
 */
const HARNESS_MODEL_NAME = "harness-model"

const withFloor = (needs: "large" | undefined) =>
  Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    yield* agents.transform((draft) => {
      draft.update(AgentV2.defaultID, (item) => {
        item.needsTier = needs
      })
    })
  })

const transcriptOf = (context: { readonly messages?: readonly unknown[] }): string =>
  JSON.stringify(context.messages ?? context)

describe("SessionRunnerLLM — role/model fit", () => {
  test("a colleague whose model is BENEATH its declared floor is told, in its own chat", async () => {
    const harness = makeRunnerHarness({ turns: [completeTurn("call_1", "Working on it")] })
    harness.controls.modelTier = "tiny"

    const context = await drive(
      harness,
      Effect.gen(function* () {
        yield* withFloor("large")
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Take on the quarterly close" }),
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
        return yield* session.context(HARNESS_SESSION)
      }),
      "fit — a colleague beneath its floor is told",
    )

    const transcript = transcriptOf(context as never)
    expect(transcript).toContain(AgentModelFit.opening(HARNESS_MODEL_NAME))
    // ⚠️ It WARNS. A notice that told the model to stop would be a refusal wearing a warning's label.
    expect(transcript.toLowerCase()).toContain("carry on")
  })

  test("a colleague with NO declared floor is never told anything", async () => {
    // The shipped default. If this ever fails, every colleague on every install gets a warning about
    // a requirement nobody stated — which is how a real warning stops being read.
    const harness = makeRunnerHarness({ turns: [completeTurn("call_1", "Working on it")] })
    harness.controls.modelTier = "tiny"

    const context = await drive(
      harness,
      Effect.gen(function* () {
        yield* withFloor(undefined)
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Take on the quarterly close" }),
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
        return yield* session.context(HARNESS_SESSION)
      }),
      "fit — no floor, no notice",
    )

    expect(transcriptOf(context as never)).not.toContain(AgentModelFit.opening(HARNESS_MODEL_NAME))
  })

  test("an UNKNOWN model tier is not treated as a low one", async () => {
    // The shipped default for a hand-added local model, which is most of them on this install.
    const harness = makeRunnerHarness({ turns: [completeTurn("call_1", "Working on it")] })
    harness.controls.modelTier = undefined

    const context = await drive(
      harness,
      Effect.gen(function* () {
        yield* withFloor("large")
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Take on the quarterly close" }),
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
        return yield* session.context(HARNESS_SESSION)
      }),
      "fit — unknown tier says nothing",
    )

    expect(transcriptOf(context as never)).not.toContain(AgentModelFit.opening(HARNESS_MODEL_NAME))
  })
})
