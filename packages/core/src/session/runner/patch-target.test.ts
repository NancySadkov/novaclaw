import { describe, expect, test } from "bun:test"
import { detectFailureStreak, FAILURE_STREAK_THRESHOLD, patchTarget, toolTargetKey } from "./doom-loop"

// `apply_patch` is the one tool whose PAYLOAD is the argument: its input is `patchText`, which appears
// in no `TARGET_FIELDS` entry, so `toolTargetKey` fell through to the trimmed raw arguments. A weak
// model regenerates the whole body on every retry — different whitespace, reordered context — so each
// attempt produced a NEW streak key and the failure-streak detector never fired.
//
// Ported from NancySadkov/novaclaw#6 by @DassaultFalconKing, whose packaged local-model E2E measured
// thirteen failed calls before any nudge.

const fail = (name: string, input: string) => ({ name, input, failed: true })
const patch = (body: string) => JSON.stringify({ patchText: body })

describe("patchTarget", () => {
  test("reads the official envelope", () => {
    expect(patchTarget("*** Begin Patch\n*** Add File: src/a.ts\n+hello\n*** End Patch")).toBe("src/a.ts")
    expect(patchTarget("*** Update File: pkg/b.ts")).toBe("pkg/b.ts")
    expect(patchTarget("*** Delete File: gone.ts")).toBe("gone.ts")
  })

  test("falls back to a unified-diff header for a model that reached for the format it knows", () => {
    expect(patchTarget("--- a/x.ts\n+++ b/x.ts")).toBe("x.ts")
  })

  test("/dev/null is not a target", () => {
    expect(patchTarget("+++ /dev/null")).toBeUndefined()
  })

  test("undefined when there is nothing to find", () => {
    expect(patchTarget("just some prose")).toBeUndefined()
    expect(patchTarget("")).toBeUndefined()
  })
})

describe("toolTargetKey with a patch body", () => {
  test("THE BUG: cosmetically different patches for ONE file share a key", () => {
    const first = patch("*** Begin Patch\n*** Add File: src/a.ts\n+one\n*** End Patch")
    const reworded = patch("*** Begin Patch\n\n*** Add File: src/a.ts\n+one\n+two\n*** End Patch")
    expect(toolTargetKey("apply_patch", first)).toBe(toolTargetKey("apply_patch", reworded))
  })

  test("NEGATIVE CONTROL: a different file must not share the key, or the nudge fires on progress", () => {
    const a = patch("*** Add File: src/a.ts\n+one")
    const b = patch("*** Add File: src/b.ts\n+one")
    expect(toolTargetKey("apply_patch", a)).not.toBe(toolTargetKey("apply_patch", b))
  })

  test("the envelope outranks a stray `path` field — the envelope is the more specific answer", () => {
    const withPath = JSON.stringify({ patchText: "*** Add File: src/a.ts\n+x", path: "unrelated.ts" })
    expect(toolTargetKey("apply_patch", withPath)).toBe(
      toolTargetKey("apply_patch", patch("*** Add File: src/a.ts\n+y")),
    )
  })

  test("an unparseable patch body still falls back to raw args rather than throwing", () => {
    expect(toolTargetKey("apply_patch", patch("garbage"))).toBe(toolTargetKey("apply_patch", patch("garbage")))
  })
})

describe("the streak the fix exists to catch", () => {
  test("N reworded malformed patches for one file trip the threshold", () => {
    const calls = Array.from({ length: FAILURE_STREAK_THRESHOLD }, (_, i) =>
      fail("apply_patch", patch("*** Add File: src/a.ts\n" + "+x\n".repeat(i + 1))),
    )
    expect(detectFailureStreak(calls)?.target).toBe("src/a.ts")
  })

  test("NEGATIVE CONTROL: the same run against DIFFERENT files does not trip", () => {
    const calls = Array.from({ length: FAILURE_STREAK_THRESHOLD }, (_, i) =>
      fail("apply_patch", patch(`*** Add File: src/${i}.ts\n+x`)),
    )
    expect(detectFailureStreak(calls)).toBeUndefined()
  })
})
