import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
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

  test("automatically inspects after an unsettled tool without replaying it", () => {
    expect(SessionRecoveryDecision.decide({ phase: "tool", checkpointed: false, failureCount: 1 })).toEqual({
      action: "inspect",
      reason: "outcome-unknown",
      automatic: true,
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
        }),
      ).toEqual({ action: "inspect", reason: "outcome-unknown", automatic: true })
  })

  test("opens the per-session circuit breaker at the failure limit", () => {
    for (const phase of ["drain", "provider", "tool", "maintenance"] as const)
      expect(SessionRecoveryDecision.decide({ phase, checkpointed: true, failureCount: 3 })).toEqual({
        action: "pause",
        reason: "repeated-failure",
        automatic: false,
      })
  })

  /**
   * `during-result-persistence` — the crash matrix's other pinned gap
   * (`session-recovery-matrix.test.ts`). A tool result and its attempt row are TWO writes, so a
   * crash can land between them. Which state that leaves, and whether recovery is then safe,
   * depends entirely on their ORDER.
   *
   * `publish-llm-event.ts` publishes `Tool.Success` FIRST, then marks the checkpoint, then calls
   * `toolSettled`. So the torn window leaves a durable result with `tool_state` still `dispatched`
   * and `checkpoint_at` set — and continuing is correct, because the effect ran once and its output
   * is already recorded.
   */
  test("a crash after the result is durable continues instead of replaying the effect", () => {
    for (const sideEffect of ["read", "idempotent-write", "non-idempotent", "external-unknown"] as const) {
      expect(
        SessionRecoveryDecision.decide({
          phase: "tool",
          checkpointed: true,
          failureCount: 1,
          toolState: "dispatched",
          toolSideEffect: sideEffect,
        }),
        `${sideEffect} must not be replayed once its result is durable`,
      ).toEqual({ action: "continue", reason: "settled-tool", automatic: true })
    }
  })

  /**
   * ⚠️ The ordering above is what makes that decision safe, and it is invisible to every behavioural
   * test: reorder the checkpoint ahead of the publish and nothing fails, but a crash in the new
   * window leaves `checkpointed: true` with NO result — so recovery would `continue` past a tool
   * call whose output was silently lost, which is worse than replaying it.
   */
  test("the tool result is published BEFORE the checkpoint that authorises continuing", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "session", "runner", "publish-llm-event.ts"), "utf8")
    // ⚠️ Scoped to the ONE block on purpose. A first draft searched the whole file and was vacuous:
    // `toolSettled` appears three times, so reordering the success path still found a later
    // occurrence and the test passed. Proved by reordering the real source and watching it stay
    // green — which is why this now slices the block and asserts each marker appears exactly once.
    const start = source.indexOf("events.publish(SessionEvent.Tool.Success")
    expect(start, "the Tool.Success publish moved — re-anchor this ledger").toBeGreaterThan(-1)
    const block = source.slice(start, source.indexOf('case "tool-error"', start))

    const mark = block.indexOf('executionBoundary("tool", "mark")')
    const settled = block.indexOf("input.toolSettled?.(event.id)")
    expect(block.split('executionBoundary("tool", "mark")').length - 1, "expected one checkpoint here").toBe(1)
    expect(block.split("input.toolSettled?.(event.id)").length - 1, "expected one settle here").toBe(1)
    expect(mark, "the tool checkpoint must come AFTER the result is published").toBeGreaterThan(-1)
    expect(settled, "toolSettled must come AFTER the checkpoint").toBeGreaterThan(mark)
  })
})
