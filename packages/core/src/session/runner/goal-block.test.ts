import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { SystemCompose } from "./system-compose"
import { SessionComponentRegistry } from "../component-registry"

/**
 * THE GOAL BLOCK, AND WHO MAY AUTHOR IT.
 *
 * Owner statement, 2026-09-16: *"The goal is something user or agent's Superior officer sets. Agent
 * can't set its own goal (i.e. no set your durable goal nudges). Goal prompt is appended to system
 * prompt, right after the tool specification and before the user prompt."*
 *
 * Three separable claims, and each has its own failure direction:
 *   1. PLACE — the goal is in the system prompt, last, which in this codebase is the only position that
 *      is both "after the tool specification" (the schemas ride the request, not a block) and "before
 *      the user prompt" (the message history). Getting it wrong is silent: the model still receives the
 *      goal, just where an instruction is weaker than a directive.
 *   2. AUTHORITY — an agent may not write it. A permission tier is not enough, because tiers are
 *      operator dials that may be widened, and a widened dial must not hand an officer power over what
 *      it is for.
 *   3. PRESENCE — it exists only while the session is unattended, which is what makes the Interactive ⇄
 *      Unattended switch add and remove it.
 */

describe("the goal block's PLACE in the system prompt", () => {
  test("🔴 it is LAST, after `base`, so it is the final thing before the message history", () => {
    const parts = SystemCompose.systemPartsInOrder({ persona: "P", base: "B", goal: "G" })
    const blocks = parts.filter((part) => part.text !== undefined).map((part) => part.block)
    expect(blocks.at(-1)).toBe("goal")
    // And AFTER base, not merely present: the owner's "right after the tool specification" is the tool
    // schemas on the wire, and the only tool-ish BLOCK is `toolDiscovery`, which sits above `base`.
    expect(blocks.indexOf("goal")).toBeGreaterThan(blocks.indexOf("base"))
  })

  test("an interactive session composes no goal block at all", () => {
    const blocks = SystemCompose.systemPartsInOrder({ persona: "P", base: "B" })
      .filter((part) => part.text !== undefined)
      .map((part) => part.block)
    expect(blocks).not.toContain("goal")
  })

  test("goalSection says WHOSE goal it is, and is absent for an empty one", () => {
    // Provenance is the point of the block: a colleague that knows it did not author its own objective
    // treats it differently from one that thinks it did.
    const section = SystemCompose.goalSection("Ship the reviewed manuscript.")
    expect(section).toContain("Ship the reviewed manuscript.")
    expect(section).toContain("set for you by whoever assigned this work")
    expect(SystemCompose.goalSection("   ")).toBeUndefined()
    expect(SystemCompose.goalSection(undefined)).toBeUndefined()
  })
})

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
      // `Cause.pretty`, not `JSON.stringify`: an `Error`'s `message` is non-enumerable, so stringifying
      // the cause loses the one sentence the whole guard exists to deliver.
      const message = Cause.pretty(exit.cause)
      // Says what the rule IS and why it exists, so a model (or a reader of a log) is not left guessing.
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
