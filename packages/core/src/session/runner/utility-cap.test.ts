import { describe, expect, test } from "bun:test"
import { UtilityCap } from "./utility-cap"

const attempt = (over: Partial<UtilityCap.Attempt> = {}): UtilityCap.Attempt => ({
  finish: "length",
  text: "",
  attempt: 0,
  cap: 512,
  ...over,
})

// The numbers below are the measured ones, not invented thresholds: on holo3.1 with the shipped
// extraction prompt every cap <= 384 finished `length` with zero content chars, while 512/2048/4096
// stopped on their own at 260-310 completion tokens with identical valid JSON.
describe("the case this exists for: budget spent, nothing said", () => {
  test("an empty completion that finished on `length` is re-asked with double the budget", () => {
    expect(UtilityCap.decide(attempt())).toEqual({ retry: true, cap: 1024 })
  })

  test("doubling is safe HERE, which it was believed not to be", () => {
    // runner/llm.ts used to conclude from a 2026-07-20 table that a bigger cap was WORSE. That did
    // not reproduce on the current test model -- above the cliff a bigger cap is neutral and the
    // model stops by itself. If the inversion ever comes back, this module is the first thing to
    // re-examine, so the dependency is pinned here rather than left implicit.
    expect(UtilityCap.decide(attempt({ cap: 1024 }))).toEqual({ retry: true, cap: 2048 })
  })
})

describe("each condition excludes a different wrong retry", () => {
  test("content present: never re-ask, even if it was truncated", () => {
    // A truncated-but-partial answer is a different problem, and re-running discards content the
    // caller may still parse.
    expect(UtilityCap.decide(attempt({ text: '[{"name":"x"' }))).toEqual({ retry: false, reason: "answered" })
  })

  test("whitespace is not content — that is exactly the silent no-op", () => {
    expect(UtilityCap.decide(attempt({ text: "  \n\t " }))).toEqual({ retry: true, cap: 1024 })
  })

  test("a model that stopped for its own reasons is not re-asked", () => {
    // An empty `stop` is a capability reading, not a budget reading. Re-asking spends tokens to get
    // the same answer.
    for (const finish of ["stop", "tool-calls", "content-filter", "error", "unknown"] as const)
      expect(UtilityCap.decide(attempt({ finish }))).toEqual({ retry: false, reason: "not-truncated" })
    expect(UtilityCap.decide(attempt({ finish: undefined }))).toEqual({ retry: false, reason: "not-truncated" })
  })

  test("an honest empty array is content and stops the ladder", () => {
    // `[]` means "nothing worth remembering", which the pass must be able to say. Conflating it with
    // a broken call is the defect the extract path already logs about.
    expect(UtilityCap.decide(attempt({ text: "[]" }))).toEqual({ retry: false, reason: "answered" })
  })
})

describe("the ladder is bounded twice, mechanically", () => {
  test("one doubling only — the second failure is not a budget problem", () => {
    expect(UtilityCap.decide(attempt({ attempt: 1 }))).toEqual({ retry: false, reason: "budget-exhausted" })
    expect(UtilityCap.decide(attempt({ attempt: 7 }))).toEqual({ retry: false, reason: "budget-exhausted" })
  })

  test("and never past the ceiling, however many retries a caller allows", () => {
    expect(UtilityCap.decide(attempt({ cap: UtilityCap.MAX_CAP }))).toEqual({ retry: false, reason: "capped" })
    expect(UtilityCap.decide(attempt({ cap: UtilityCap.MAX_CAP / 2 }))).toEqual({
      retry: true,
      cap: UtilityCap.MAX_CAP,
    })
  })

  test("the bound is a constant, not a literal sprinkled through callers", () => {
    expect(UtilityCap.MAX_RETRIES).toBe(1)
    expect(UtilityCap.MAX_CAP).toBe(4096)
  })

  test("a doubling ladder always terminates from any starting cap", () => {
    // The runaway that taught us to bound every phase cost real money. Prove termination rather than
    // asserting it: from any cap, repeated application reaches a non-retry in a few steps.
    for (const start of [1, 64, 512, 3000, 4096, 100000]) {
      let current = start
      let steps = 0
      for (let i = 0; i < 50; i++) {
        const d = UtilityCap.decide(attempt({ cap: current, attempt: 0 }))
        if (!d.retry) break
        current = d.cap
        steps++
      }
      expect(steps).toBeLessThan(20)
    }
  })
})

describe("giving up says which failure it was, as a closed cause", () => {
  test("a budget exhaustion is named as one", () => {
    expect(UtilityCap.giveUpCause(attempt({ attempt: 1, cap: 1024 }))).toBe("budget-exhausted")
  })

  test("a non-budget emptiness says so, so nobody raises the cap chasing it", () => {
    expect(UtilityCap.giveUpCause(attempt({ finish: "stop" }))).toBe("not-a-budget-problem")
    expect(UtilityCap.giveUpCause(attempt({ finish: undefined }))).toBe("not-a-budget-problem")
  })

  test("the cause is a CLOSED vocabulary, not prose — that is what lets it egress", () => {
    // The log-event ledger refused a prose `text` attribute: by declaration it never egresses, so a
    // diagnostic written as prose is one crash telemetry can never carry. A finite cause is an `id`.
    const causes = new Set(
      [undefined, "stop", "length", "tool-calls", "error"].map((f) =>
        UtilityCap.giveUpCause(attempt({ finish: f as never })),
      ),
    )
    expect([...causes].sort()).toEqual(["budget-exhausted", "not-a-budget-problem"])
  })
})
