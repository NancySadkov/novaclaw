import { describe, expect, test } from "bun:test"
import { UnjoinedChildren } from "./unjoined-children"

// The delegation supervisor pins the measured case where a parent did not restart a failed child.
//
// The measured failure being pinned: `spawn:10` against `wait:9` and `exit:9` on the delegated
// 100-file run `4623-S2` (2026-08-27). Ten children started, nine joined, one silently lost, run
// reported complete. Every test below is a clause of "and now it is not silent".

const child = (id: string, exited: boolean, slice?: string): UnjoinedChildren.Child => ({
  id,
  exited,
  ...(slice === undefined ? {} : { slice }),
})

describe("unaccounted", () => {
  test("a joined child is accounted for and never named", () => {
    const found = UnjoinedChildren.unaccounted({
      children: [child("ses_a", true), child("ses_b", true)],
      joined: new Set(["ses_a", "ses_b"]),
    })
    expect(found).toEqual([])
  })

  // 🔴 THE MEASURED RUN, reproduced: ten children, nine joined, one left.
  test("spawn:10 against wait:9 names the tenth", () => {
    const children = Array.from({ length: 10 }, (_, i) => child(`ses_${i}`, true, `slice ${i}`))
    const joined = new Set(children.slice(0, 9).map((c) => c.id))
    const found = UnjoinedChildren.unaccounted({ children, joined })
    expect(found).toHaveLength(1)
    expect(found[0]!.id).toBe("ses_9")
    expect(found[0]!.disposition).toBe("unjoined")
  })

  test("a child that never exited is PENDING — this check does not guess dead", () => {
    const found = UnjoinedChildren.unaccounted({
      children: [child("ses_x", false, "describe icons 81-90")],
      joined: new Set(),
    })
    expect(found).toEqual([{ id: "ses_x", disposition: "pending", slice: "describe icons 81-90" }])
  })

  test("a child with no slice recorded carries none — a restart must not invent one", () => {
    const found = UnjoinedChildren.unaccounted({ children: [child("ses_y", false)], joined: new Set() })
    expect(found[0]).not.toHaveProperty("slice")
  })

  // ⚠️ The whole fan-out joined is the ordinary healthy case, and it must stay silent however wide.
  test("a 16-wide fan-out fully joined says nothing", () => {
    const children = Array.from({ length: 16 }, (_, i) => child(`ses_${i}`, true))
    const joined = new Set(children.map((c) => c.id))
    expect(UnjoinedChildren.unaccounted({ children, joined })).toEqual([])
  })
})

describe("shouldRestart", () => {
  test("fires when a child is unaccounted for", () => {
    const unaccounted = UnjoinedChildren.unaccounted({ children: [child("ses_a", true)], joined: new Set() })
    expect(UnjoinedChildren.shouldRestart({ unaccounted, rounds: 0 })).toBe(true)
  })

  test("silent when every child was joined", () => {
    expect(UnjoinedChildren.shouldRestart({ unaccounted: [], rounds: 0 })).toBe(false)
  })

  // 🔴 THE BOUND: a restart that itself fails must not loop. A replacement
  // child can itself fail, producing another unaccounted child, producing another steer.
  test("stops at MAX_RESTART_ROUNDS however many children remain", () => {
    const unaccounted = UnjoinedChildren.unaccounted({
      children: [child("ses_a", false), child("ses_b", false)],
      joined: new Set(),
    })
    expect(UnjoinedChildren.shouldRestart({ unaccounted, rounds: UnjoinedChildren.MAX_RESTART_ROUNDS - 1 })).toBe(true)
    expect(UnjoinedChildren.shouldRestart({ unaccounted, rounds: UnjoinedChildren.MAX_RESTART_ROUNDS })).toBe(false)
    expect(UnjoinedChildren.shouldRestart({ unaccounted, rounds: UnjoinedChildren.MAX_RESTART_ROUNDS + 5 })).toBe(false)
  })
})

describe("restartMessage", () => {
  const message = (verdicts: readonly UnjoinedChildren.Verdict[], spawned = 10, joined = 9) =>
    UnjoinedChildren.restartMessage({ spawned, joined, unaccounted: verdicts })

  test("leads with the arithmetic the model could not do", () => {
    const text = message([{ id: "ses_9", disposition: "unjoined" }])
    expect(text).toContain("spawned 10")
    expect(text).toContain("result of 9")
  })

  test("an UNJOINED child is joined — its result exists and was thrown away", () => {
    const text = message([{ id: "ses_9", disposition: "unjoined" }])
    expect(text).toContain("FINISHED and you never read its result")
    expect(text).toContain('wait("ses_9")')
  })

  // ⚠️ A pending child must NOT be declared dead here — the remedy is `wait`, which owns that
  // verdict. But the fresh-replacement instruction must reach the model for the case where it IS dead.
  test("a PENDING child is sent to wait, and told what to do if it died", () => {
    const text = message([{ id: "ses_9", disposition: "pending", slice: "describe icons 81-90" }])
    expect(text).toContain('wait("ses_9")')
    expect(text).toContain("still working or died")
    expect(text).toContain("spawn a fresh replacement session")
    expect(text).toContain("describe icons 81-90")
  })

  test("forbids the two cheap answers — describing a slice from siblings, and a caveat", () => {
    const text = message([{ id: "ses_9", disposition: "pending" }])
    expect(text).toContain("Do not summarise a slice from what the other children reported")
    expect(text).toContain("do not deliver the merged answer with a note that some part is missing")
  })

  test("names at most NAME_LIMIT children and counts the rest", () => {
    const verdicts: UnjoinedChildren.Verdict[] = Array.from({ length: 9 }, (_, i) => ({
      id: `ses_${i}`,
      disposition: "pending" as const,
    }))
    const text = message(verdicts, 16, 7)
    expect(text).toContain("ses_0")
    expect(text).toContain(`and ${9 - UnjoinedChildren.NAME_LIMIT} more`)
    expect(text).not.toContain("ses_8")
  })

  // ⚠️ Asserts the SLICE was cut, not that the message is short. The message carries ~560 characters
  // of standing instruction, so `text.length < slice.length` is a comparison against an unrelated
  // constant — it passed an UNtruncated 700-character slice and failed a truncated 500-character
  // one, i.e. measured the wrong quantity in both directions.
  test("a long slice is truncated, not echoed whole", () => {
    const long = "x".repeat(500)
    const text = message([{ id: "ses_9", disposition: "pending", slice: long }])
    expect(text).toContain("…")
    const echoed = /x+/.exec(text)?.[0].length ?? 0
    expect(echoed).toBeGreaterThan(0)
    expect(echoed).toBeLessThan(long.length)
  })

  test("a slice that fits is echoed verbatim, with no ellipsis added", () => {
    const text = message([{ id: "ses_9", disposition: "pending", slice: "describe icons 81-90" }])
    expect(text).toContain("describe icons 81-90")
    expect(text).not.toContain("81-90…")
  })

  test("singular reads as English for one child", () => {
    const text = message([{ id: "ses_1", disposition: "pending" }], 1, 0)
    expect(text).toContain("1 child session and")
    expect(text).toContain("1 child is unaccounted")
  })
})

describe("isTerminalWaitResult", () => {
  test("accepts completed and confirmed-dead terminal outcomes", () => {
    expect(UnjoinedChildren.isTerminalWaitResult({ completed: true, terminal: true })).toBe(true)
    expect(UnjoinedChildren.isTerminalWaitResult({ completed: false, terminal: true })).toBe(true)
  })

  test("rejects a live timeout and missing or malformed results", () => {
    expect(UnjoinedChildren.isTerminalWaitResult({ completed: false, terminal: false })).toBe(false)
    expect(UnjoinedChildren.isTerminalWaitResult(undefined)).toBe(false)
    expect(UnjoinedChildren.isTerminalWaitResult({ terminal: "true" })).toBe(false)
  })
})
