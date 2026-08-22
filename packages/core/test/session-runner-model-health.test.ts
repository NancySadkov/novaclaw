import { describe, expect, test, beforeEach } from "bun:test"
import { Effect } from "effect"
import { LLMEvent } from "@novaclaw/llm"
import { SessionV2 } from "@novaclaw/core/session"
import { ModelHealth } from "@novaclaw/core/session/runner/model-health"
import { Prompt } from "@novaclaw/core/session/prompt"
import { HARNESS_SESSION, completeTurn, drive, makeRunnerHarness } from "./fixture/runner-harness"

/**
 * THE RECORD SITE IS LIVE — the half of the "or gives errors" fallback that a pure test cannot reach.
 *
 * 🔴 `model-health.test.ts` proves the RULE: two failures inside the window make an endpoint sick, a
 * success clears it. It proves nothing about whether a failing turn ever tells the module anything.
 * That is the shape that bit this session twice — both halves correct, the join never made, the
 * feature shipped dead and green. So this drives real turns through the runner and reads the
 * module's own counter afterwards.
 *
 * ⚠️ Asserts the COUNT, not `sick()`: the count is what the runner produced, while `sick()` folds in
 * the threshold that the pure ledger already owns. A test asserting the verdict would go green if the
 * runner recorded nothing and the threshold were accidentally lowered to zero.
 */

const HARNESS_MODEL = { providerID: "harness", id: "harness-model" }

describe("SessionRunnerLLM — model health bookkeeping", () => {
  beforeEach(() => ModelHealth.reset())

  test("a turn that fails on the provider is recorded against the model that ran it", async () => {
    const harness = makeRunnerHarness({
      turns: [[LLMEvent.stepStart({ index: 0 }), LLMEvent.providerError({ message: "Provider unavailable" })]],
    })
    await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Fail once" }),
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
      }),
      "model health — a failed turn reaches ModelHealth",
    )
    expect(ModelHealth.failures(HARNESS_MODEL, Date.now())).toBeGreaterThan(0)
  })

  test("a turn that ANSWERS clears the model's failure record", async () => {
    ModelHealth.failed(HARNESS_MODEL, Date.now())
    const harness = makeRunnerHarness({ turns: [completeTurn("call_1", "Answered")] })
    await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Answer me" }),
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
      }),
      "model health — a working turn reaches ModelHealth",
    )
    expect(ModelHealth.failures(HARNESS_MODEL, Date.now())).toBe(0)
  })
})
