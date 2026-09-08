import { describe, expect, test } from "bun:test"

import { applyOptimistic } from "./optimistic-write"

/**
 * 🔴 NC-REL-035 — a refused control write stayed on screen. The composer set each switch into
 * persisted browser state first, fired the request, and handled failure with `console.error`. For the
 * permission mode and Strict that is a SAFETY posture: the UI says "plan" while the session still
 * runs under the old permissions.
 *
 * A/B: drop the `set(previous)` from the catch and "a refused write is put back" fails.
 */
describe("an optimistic control write", () => {
  const recorder = () => {
    const values: string[] = []
    return { values, set: (value: string) => values.push(value) }
  }

  test("🔴 a REFUSED write is put back, and the caller is told", async () => {
    const { values, set } = recorder()
    let reported: unknown
    const outcome = await applyOptimistic({
      set,
      previous: "ask",
      next: "bypass",
      write: Promise.reject(new Error("kernel refused")),
      onReverted: (error) => (reported = error),
    })
    expect(outcome.reverted).toBe(true)
    // Applied first — the UI must feel instant — then put back.
    expect(values).toEqual(["bypass", "ask"])
    expect(String(reported)).toContain("kernel refused")
  })

  test("an ACCEPTED write is applied once and left alone", async () => {
    // The control: without it, "always revert" would satisfy the test above while making every
    // successful change flicker back to its old value.
    const { values, set } = recorder()
    let reported = false
    const outcome = await applyOptimistic({
      set,
      previous: "ask",
      next: "bypass",
      write: Promise.resolve(),
      onReverted: () => (reported = true),
    })
    expect(outcome.reverted).toBe(false)
    expect(values).toEqual(["bypass"])
    expect(reported).toBe(false)
  })

  test("the value is applied BEFORE the write settles", async () => {
    // The whole reason these are optimistic: the switch must not wait on a round trip.
    const { values, set } = recorder()
    let release: () => void = () => {}
    const write = new Promise<void>((resolve) => (release = resolve))
    const pending = applyOptimistic({ set, previous: "off", next: "on", write, onReverted: () => {} })
    expect(values).toEqual(["on"])
    release()
    await pending
  })
})
