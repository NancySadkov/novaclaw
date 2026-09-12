// The scheduler's class decides TWO things at once: what share of the device a session gets, and
// whether it may run while a human is waiting (`batchCapacity` admits batch work only at
// `inFlightInteractive.size === 0`). So the function that derives the class is not a label lookup —
// it allocates the human's bus. It had no test at all: `grep classForSessionType` across the repo's
// tests found nothing, while the containment half of the same decision was already pinned in
// `config-resolve.test.ts:310-322`.
//
// The gap that matters is the COMPOSITION, not either function alone. `classForSessionType`
// (scheduler.ts:62) falls through to `"interactive"` for anything it does not map — the shape that
// caused a real incident one level up on 2026-07-28, where a chain fault answering `"interactive"`
// handed a chain of "nobody is watching" rows the operator's full host authority
// (`config-resolve.ts:214-224`). Reading that function in isolation, it still looks like that bug:
// `default: "interactive"`. It is safe only because `"unknown"` can never reach it —
// `narrowRootType` is "THE ONE collapse point" and maps a fault to the RESTRICTIVE class. Neither
// fact is visible from the scheduler, so neither was guaranteed.
import { describe, expect, test } from "bun:test"
import { classForSessionType, type SessionClass } from "../src/session/scheduler"
import { narrowRootType, type SessionType } from "../src/session/config-resolve"

describe("classForSessionType allocates the interactive lane honestly", () => {
  test("every real type maps to its own class — no silent promotion", () => {
    // ⚠️ Totality, deliberately spelled out. If someone widens `SessionType` and forgets this switch,
    // the new member lands in `default` and inherits the most privileged lane: weight 50 and the
    // power to hold `batchCapacity` shut for everyone else. A forgotten arm must fail HERE, not
    // quietly reshape scheduling.
    const cases: Array<[SessionType, SessionClass]> = [
      ["interactive", "interactive"],
      ["sub-agent", "sub-agent"],
      ["auto-prompting", "auto-prompting"],
      ["goal-oriented", "goal-oriented"],
    ]
    for (const [type, expected] of cases) expect(classForSessionType(type)).toBe(expected)
  })

  test("🔴 a chain fault must not buy the interactive lane", () => {
    // The composition that actually runs: `llm.ts:2746` feeds this `config.type`, and an unreadable
    // chain arrives through `narrowRootType`. A fault is therefore a `goal-oriented` session — weight
    // 20, batch class, admitted only while no interactive turn is in flight.
    //
    // A/B: make `UNREADABLE_CHAIN_ROOT_TYPE` "interactive" (the tempting "fail open so we never slow
    // a human down" edit) and this fails. That edit would be wrong twice: it grants latency privilege
    // on missing data, which ruling 2 forbids, and it lets an unreadable background chain block the
    // work of every session that cannot start until it finishes.
    expect(classForSessionType(narrowRootType("unknown"))).toBe("goal-oriented")
  })

  test("an absent type is interactive, and that is a documented choice, not a slip", () => {
    // `undefined` means inherit and the root fallback is "interactive"
    // (`config-resolve.ts:802`), so this arm is defensive rather than reachable. Pinned so it stays a
    // decision someone can read.
    expect(classForSessionType(undefined)).toBe("interactive")
  })
})
