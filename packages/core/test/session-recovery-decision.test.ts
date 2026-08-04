import { describe, expect, test } from "bun:test"
import { SessionRecoveryDecision } from "@novaclaw/core/session/recovery-decision"

describe("SessionRecoveryDecision", () => {
  test("retries boundaries before side effects", () => {
    expect(SessionRecoveryDecision.decide({ phase: "drain", checkpointed: false, failureCount: 1 })).toEqual({
      action: "retry",
      reason: "before-side-effect",
      automatic: true,
    })
    expect(SessionRecoveryDecision.decide({ phase: "provider", checkpointed: false, failureCount: 1 })).toEqual({
      action: "retry",
      reason: "before-side-effect",
      automatic: true,
    })
  })

  test("continues from durable provider and tool checkpoints", () => {
    expect(SessionRecoveryDecision.decide({ phase: "provider", checkpointed: true, failureCount: 1 })).toEqual({
      action: "continue",
      reason: "partial-provider-output",
      automatic: true,
    })
    expect(SessionRecoveryDecision.decide({ phase: "tool", checkpointed: true, failureCount: 1 })).toEqual({
      action: "continue",
      reason: "settled-tool",
      automatic: true,
    })
  })

  test("never automatically replays an unsettled tool", () => {
    expect(SessionRecoveryDecision.decide({ phase: "tool", checkpointed: false, failureCount: 1 })).toEqual({
      action: "inspect",
      reason: "outcome-unknown",
      automatic: false,
    })
  })

  test("replays only adapters that explicitly declare a safe effect", () => {
    expect(
      SessionRecoveryDecision.decide({
        phase: "tool",
        checkpointed: false,
        failureCount: 1,
        toolSideEffect: "read",
        toolState: "dispatched",
      }),
    ).toEqual({
      action: "retry",
      reason: "replay-safe-tool",
      automatic: true,
    })
    for (const toolSideEffect of ["idempotent-write", "non-idempotent", "external-unknown"] as const)
      expect(
        SessionRecoveryDecision.decide({
          phase: "tool",
          checkpointed: false,
          failureCount: 1,
          toolSideEffect,
          toolState: "dispatched",
        }).automatic,
      ).toBe(false)
  })

  test("opens the per-session circuit breaker at the failure limit", () => {
    for (const phase of ["drain", "provider", "tool", "maintenance"] as const)
      expect(SessionRecoveryDecision.decide({ phase, checkpointed: true, failureCount: 3 })).toEqual({
        action: "pause",
        reason: "repeated-failure",
        automatic: false,
      })
  })
})
