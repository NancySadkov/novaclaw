import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { SessionComponentRegistry } from "../component-registry"

/**
 * WHO MAY AUTHOR THE GOAL.
 *
 * Owner statement, 2026-09-16: *"The goal is something user or agent's Superior officer sets. Agent
 * can't set its own goal (i.e. no set your durable goal nudges)."*
 *
 * ⚠️ The PLACE and PRESENCE claims that used to live here (the goal as the last system block, absent
 * when interactive) belonged to the per-turn part assembly, which is retired (owner, 2026-09-17). The
 * goal is now a paragraph inside the one `PromptManager` prompt, shown only while the session is
 * unattended; that is pinned in `prompt-manager.test.ts`. AUTHORITY is a registry rule and unchanged.
 */
describe("the goal's AUTHORITY", () => {
  /**
   * ⚠️ Called directly, with a cast, because the definition IS the enforcement point. Driving it through
   * the `session` tool would test the permission LAYER instead — and the layer is exactly what this
   * guard exists to outrank, so a test that goes through it cannot tell the two apart.
   */
  const write = (system: boolean) =>
    Exit.isSuccess(Effect.runSyncExit((SessionComponentRegistry.GoalDefinition.validateWrite as Function)({ system })))

  test("🔴 an agent write is REFUSED, and a host write is allowed", () => {
    expect(write(false)).toBe(false)
    expect(write(true)).toBe(true)
  })

  test("the refusal names the authority rule, not just a failure", () => {
    const exit = Effect.runSyncExit(
      (SessionComponentRegistry.GoalDefinition.validateWrite as Function)({
        system: false,
      }),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const message = Cause.pretty(exit.cause)
      expect(message).toContain("superior officer")
      expect(message).toContain("not by the agent")
    }
  })

  test("CLEARING carries the same gate — the second door onto the same escalation", () => {
    // An agent that cannot SET its own goal but can CLEAR the one it was given has the same power by
    // subtraction, and inheritance would let it clear one it only inherited.
    const remove = (system: boolean) =>
      Exit.isSuccess(
        Effect.runSyncExit((SessionComponentRegistry.GoalDefinition.validateRemove as Function)({ system })),
      )
    expect(remove(false)).toBe(false)
    expect(remove(true)).toBe(true)
  })
})
