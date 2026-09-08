import { describe, expect, test } from "bun:test"
import { makeRunnerHarness } from "./fixture/runner-harness"

// The harness's own contract, before any claim is ported onto it. These are cheap and they pin the
// property the old fixture lacks — S2's whole reason for existing.

describe("makeRunnerHarness", () => {
  test("🔴 two harnesses cannot see each other's requests", async () => {
    // THE point. The old fixture drives its mock through six module-level variables reset by hand in
    // sixty places, so a forgotten reset silently inherits the previous test's script. Here there is
    // nothing to forget: the state belongs to the harness, and a second one starts empty regardless of
    // what the first did.
    const a = makeRunnerHarness({ turns: [[]] })
    const b = makeRunnerHarness()
    a.requests.push({ model: "x" } as never)
    expect(a.requests).toHaveLength(1)
    expect(b.requests, "a fresh harness must not inherit another's requests").toHaveLength(0)
  })

  test("each harness gets its own script", () => {
    const a = makeRunnerHarness({ turns: [[{ type: "text-delta" } as never]] })
    const b = makeRunnerHarness({ turns: [] })
    expect(a).not.toBe(b)
    expect(a.requests).not.toBe(b.requests)
    expect(a.clientLayer).not.toBe(b.clientLayer)
  })

  test("the script is COPIED, so a caller's array cannot be drained under it", () => {
    // `turns` is spread on the way in. Without that, a script reused across two harnesses would be
    // consumed by the first — the same class of shared-mutable bug this fixture exists to end, just
    // relocated to the caller.
    const shared = [[{ type: "text-delta" } as never]]
    const a = makeRunnerHarness({ turns: shared })
    const b = makeRunnerHarness({ turns: shared })
    expect(shared).toHaveLength(1)
    expect(a.clientLayer).not.toBe(b.clientLayer)
  })

  test("a harness with no script is legal — some claims only assert on the request", () => {
    const h = makeRunnerHarness()
    expect(h.requests).toEqual([])
    expect(String(h.model.id)).toBe("harness-model")
  })
})
