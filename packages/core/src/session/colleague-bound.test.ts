import { describe, expect, test, beforeEach } from "bun:test"
import { ColleagueBound } from "./colleague-bound"

// The MECHANISM behind the colleague loop bound (`notes/named-agents.md`). Every case here is one the
// wording of a note cannot enforce — which is the reason the mechanism exists.

describe("hop cap", () => {
  test("a first hand-off is hop 1, not hop 0", () => {
    // Off-by-one here is the difference between a cap of 4 and a cap of 5, silently.
    expect(ColleagueBound.nextHop(undefined)).toBe(1)
    expect(ColleagueBound.nextHop(0)).toBe(1)
  })

  test("ordinary exchanges remain inside the immediate-wake budget", () => {
    // ask→answer, and delegate→ask→answer→report. A cap that clears only the first refuses the org
    // chart doing its job, which reads to a user as the product being broken.
    expect(ColleagueBound.exceedsHopCap(2)).toBe(false)
    expect(ColleagueBound.exceedsHopCap(4)).toBe(false)
  })

  test("a deeper hand-off exceeds the immediate-wake budget", () => {
    expect(ColleagueBound.exceedsHopCap(5)).toBe(true)
  })
})

describe("rate window", () => {
  beforeEach(() => ColleagueBound.reset())

  test("a normal exchange never touches it", () => {
    for (let n = 0; n < ColleagueBound.RATE_LIMIT - 1; n++) ColleagueBound.record("ses_a", 1_000 + n)
    expect(ColleagueBound.rateExceeded("ses_a", 2_000)).toBe(false)
  })

  test("a sender that keeps hammering is stopped", () => {
    for (let n = 0; n < ColleagueBound.RATE_LIMIT; n++) ColleagueBound.record("ses_a", 1_000 + n)
    expect(ColleagueBound.rateExceeded("ses_a", 2_000)).toBe(true)
  })

  test("one loud colleague does not spend another's allowance", () => {
    for (let n = 0; n < ColleagueBound.RATE_LIMIT; n++) ColleagueBound.record("ses_a", 1_000 + n)
    expect(ColleagueBound.rateExceeded("ses_b", 2_000)).toBe(false)
  })

  test("the window MOVES — the same sender is free again later", () => {
    for (let n = 0; n < ColleagueBound.RATE_LIMIT; n++) ColleagueBound.record("ses_a", 1_000 + n)
    expect(ColleagueBound.rateExceeded("ses_a", 1_000 + ColleagueBound.RATE_WINDOW_MS + 1)).toBe(false)
  })

  test("the record is TRIMMED rather than grown forever", () => {
    for (let n = 0; n < 500; n++) ColleagueBound.record("ses_a", n * 60_000)
    expect(ColleagueBound.recent("ses_a", 499 * 60_000)).toBeLessThanOrEqual(ColleagueBound.RATE_WINDOW_MS / 60_000 + 1)
  })

  // ⚠️ The hop cap CANNOT see this case, which is why there are two mechanisms and not one: a model
  // re-asking the same colleague over and over never gets a reply back, so it sits at hop 1 forever.
  test("a sender stuck at hop 1 forever is still bounded", () => {
    expect(ColleagueBound.exceedsHopCap(ColleagueBound.nextHop(0))).toBe(false)
    for (let n = 0; n < ColleagueBound.RATE_LIMIT; n++) ColleagueBound.record("ses_a", 1_000 + n)
    expect(ColleagueBound.rateExceeded("ses_a", 2_000)).toBe(true)
  })
})
