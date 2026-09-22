import { describe, expect, test } from "bun:test"
import { DateTime, Effect } from "effect"
import { LLMError, QuotaExceededReason } from "@novaclaw/llm"
import { ModelV2 } from "@novaclaw/core/model"
import { ProviderV2 } from "@novaclaw/core/provider"
import { Database } from "@novaclaw/core/database/database"
import { EventV2 } from "@novaclaw/core/event"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionEvent } from "@novaclaw/core/session/event"
import { SessionInput } from "@novaclaw/core/session/input"
import { SessionMessage } from "@novaclaw/core/session/message"
import { Prompt } from "@novaclaw/core/session/prompt"
import { SessionRunner } from "@novaclaw/core/session/runner"
import { ProviderRecovery } from "@novaclaw/core/session/runner/provider-recovery"
import { SettingsConfigStore } from "@novaclaw/core/settings-config-store"
import {
  HARNESS_SESSION,
  completeTurn,
  drive,
  makeRunnerHarness,
} from "./fixture/runner-harness"

/**
 * THE LEDGER IS THE JOIN — three claims about the durable provider-recovery verdict.
 *
 * Measured live 2026-09-22: two officers pinned to a gateway whose account was overdrawn
 * (`Go usage limit exceeded`) looped sixty identical restarts without ever substituting, while
 * a working default stood by. The recovery ledger that routes around a dead endpoint stayed
 * empty for two independent reasons, and each has its claim here (plus the negative control
 * that supersession is not evidence):
 *
 * 1. A quota refusal is endpoint health, not a malformed request. Filing it as a halt kept the
 *    verdict out of the ledger and ended the drain on the dead route instead of continuing it
 *    on a substitute.
 * 2. A stranded attempt — a worker gone before turn-end bookkeeping could file anything — left
 *    no verdict at all. The next drain must file it at abandon time, or resolution selects the
 *    same dead route forever.
 */

const staleModel = { id: ModelV2.ID.make("stale-model"), providerID: ProviderV2.ID.make("harness") }

const publishStrandedAttempt = (startedAt: DateTime.Utc) =>
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const db = (yield* Database.Service).db
    yield* SessionV2.Service.pipe(
      Effect.flatMap((session) =>
        session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Finish the interrupted task" }),
          resume: false,
        }),
      ),
    )
    yield* SessionInput.promoteNextQueued(db, events, HARNESS_SESSION)
    yield* events.publish(SessionEvent.ProviderAttempt.Started, {
      sessionID: HARNESS_SESSION,
      timestamp: startedAt,
      recovery: {
        attemptID: EventV2.ID.create(),
        assistantMessageID: SessionMessage.ID.create(),
        model: staleModel,
        startedAt,
        toolProtocol: false,
      },
    })
  })

const readRecoveryLedger = Effect.gen(function* () {
  const all = yield* (yield* SettingsConfigStore.Service).all()
  return ProviderRecovery.decode(all["provider_recovery"])
})

describe("SessionRunnerLLM — the recovery ledger learns what the turn could not file", () => {
  test("a quota refusal continues the drain instead of halting it on the dead route", async () => {
    const quota = new LLMError({
      module: "test",
      method: "stream",
      reason: new QuotaExceededReason({ message: "Go usage limit exceeded." }),
    })
    const harness = makeRunnerHarness({
      // A failing request DISCARDS one scripted turn without consuming it, so the rerouted turn
      // needs its own: one sacrifice for the quota refusal, one for the answer that follows it.
      turns: [completeTurn("t-discarded", "discarded"), completeTurn("t-recover", "Recovered on the substitute")],
      providerRecoveryStore: true,
    })
    harness.controls.streamFailure = quota
    // Clear the fault once the first request is on the wire, so the rerouted turn meets a working
    // endpoint. Keyed off the request log rather than a resolution count — resolution runs more
    // than once per turn, so counting resolutions clears the fault before the first request.
    harness.controls.modelResolveHook = Effect.sync(() => {
      if (harness.requests.length >= 1) harness.controls.streamFailure = undefined
    })

    await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Do quota-sensitive work" }),
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
      }),
      "claim — a throttled account reroutes the same drain",
    )

    expect(
      harness.requests,
      "a quota refusal halted the drain after one request instead of continuing it",
    ).toHaveLength(2)
  })

  test("abandoning a stranded attempt files its route, so the next turn routes around it", async () => {
    const harness = makeRunnerHarness({
      turns: [completeTurn("t1", "Recovered and continued")],
      providerRecoveryStore: true,
    })
    const state = await drive(
      harness,
      Effect.gen(function* () {
        yield* publishStrandedAttempt(DateTime.makeUnsafe(1234))
        const db = (yield* Database.Service).db
        const events = yield* EventV2.Service
        expect(yield* SessionInput.hasPending(db, HARNESS_SESSION, "steer")).toBe(false)
        expect(yield* SessionInput.hasPending(db, HARNESS_SESSION, "queue")).toBe(false)
        yield* SessionRunner.Service.use((runner) => runner.run({ sessionID: HARNESS_SESSION, force: false }))
        return yield* readRecoveryLedger
      }),
      "claim — a latch older than the stall window is endpoint evidence",
    )

    expect(harness.requests).toHaveLength(1)
    expect(
      state["harness/stale-model"]?.failures,
      "the stranded route left no durable verdict, so resolution will select it again",
    ).toBe(2)
  })

  test("a young latch files nothing — supersession is not endpoint evidence", async () => {
    const harness = makeRunnerHarness({
      turns: [completeTurn("t1", "Recovered and continued")],
      providerRecoveryStore: true,
    })
    const state = await drive(
      harness,
      Effect.gen(function* () {
        yield* publishStrandedAttempt(yield* DateTime.now)
        yield* SessionRunner.Service.use((runner) => runner.run({ sessionID: HARNESS_SESSION, force: false }))
        return yield* readRecoveryLedger
      }),
      "claim — a fresh latch is preemption, not a hang",
    )

    expect(harness.requests).toHaveLength(1)
    expect(state["harness/stale-model"]).toBeUndefined()
  })
})
