import { describe, expect, test } from "bun:test"
import {
  detectDoomLoop,
  redirectMessage,
  DOOM_LOOP_THRESHOLD,
  toolTargetKey,
  detectFailureStreak,
  failureStreakMessage,
  detectRunaway,
  runawayMessage,
  FAILURE_STREAK_THRESHOLD,
  RUNAWAY_THRESHOLD,
} from "./doom-loop"

const call = (name: string, input: string) => ({ name, input })
const fail = (name: string, input: string, failed = true) => ({ name, input, failed })

describe("detectDoomLoop", () => {
  test("three identical consecutive calls trips it", () => {
    const c = call("bash", '{"command":"gcc x.c"}')
    expect(detectDoomLoop([c, c, c])).toEqual(c)
  })

  test("fewer than threshold does not trip", () => {
    const c = call("bash", '{"command":"gcc x.c"}')
    expect(detectDoomLoop([c, c])).toBeUndefined()
  })

  test("only the LAST threshold calls matter (recovers then loops)", () => {
    const a = call("read", '{"path":"a"}')
    const b = call("bash", '{"command":"make"}')
    expect(detectDoomLoop([a, b, b, b])).toEqual(b)
  })

  test("different args break the loop", () => {
    expect(
      detectDoomLoop([call("bash", '{"command":"a"}'), call("bash", '{"command":"b"}'), call("bash", '{"command":"a"}')]),
    ).toBeUndefined()
  })

  test("same args but different tool is not a loop", () => {
    expect(detectDoomLoop([call("read", "{}"), call("write", "{}"), call("read", "{}")])).toBeUndefined()
  })

  test("custom threshold of 2", () => {
    const c = call("glob", '{"pattern":"*.ts"}')
    expect(detectDoomLoop([c, c], 2)).toEqual(c)
  })

  test("trailing recent window after a long non-looping history", () => {
    const noise = Array.from({ length: 10 }, (_, i) => call("read", `{"path":"${i}"}`))
    const c = call("bash", '{"command":"loop"}')
    expect(detectDoomLoop([...noise, c, c, c])).toEqual(c)
  })
})

describe("redirectMessage", () => {
  test("names the offending tool and threshold and says stop", () => {
    const msg = redirectMessage(call("bash", "{}"))
    expect(msg).toContain("`bash`")
    expect(msg).toContain(String(DOOM_LOOP_THRESHOLD))
    expect(msg.toLowerCase()).toContain("loop")
  })
})

describe("toolTargetKey", () => {
  test("file tools key on path, ignoring other args", () => {
    expect(toolTargetKey("edit", '{"path":"src/a.ts","oldString":"x","newString":"y"}')).toBe(
      toolTargetKey("edit", '{"path":"src/a.ts","oldString":"p","newString":"q"}'),
    )
  })

  test("bash keys on the first line of the command", () => {
    expect(toolTargetKey("bash", '{"command":"make\\nmore"}')).toBe(toolTargetKey("bash", '{"command":"make\\nother"}'))
    expect(toolTargetKey("bash", '{"command":"make"}')).not.toBe(toolTargetKey("bash", '{"command":"gcc x.c"}'))
  })

  test("glob/grep key on pattern, not the surrounding path", () => {
    expect(toolTargetKey("grep", '{"pattern":"foo","path":"a"}')).toBe(toolTargetKey("grep", '{"pattern":"foo","path":"b"}'))
  })

  test("different tools with the same path are different targets", () => {
    expect(toolTargetKey("read", '{"path":"x"}')).not.toBe(toolTargetKey("write", '{"path":"x"}'))
  })

  test("unparseable input falls back to raw args, still keyed by tool", () => {
    expect(toolTargetKey("bash", "not json")).toBe(toolTargetKey("bash", "not json"))
    expect(toolTargetKey("bash", "not json")).not.toBe(toolTargetKey("read", "not json"))
  })
})

describe("detectFailureStreak", () => {
  test("five same-target failures trips it", () => {
    const calls = Array.from({ length: 5 }, () => fail("bash", '{"command":"gcc x.c"}'))
    const streak = detectFailureStreak(calls)
    expect(streak?.count).toBe(5)
    expect(streak?.name).toBe("bash")
  })

  test("cosmetic arg rewording still trips (the whole point of A2)", () => {
    // Same file, different content each retry — the exact-repeat detector would miss this.
    const calls = Array.from({ length: 6 }, (_, i) => fail("write", `{"path":"out.txt","content":"v${i}"}`))
    expect(detectFailureStreak(calls)?.count).toBe(6)
    expect(detectDoomLoop(calls.map(({ name, input }) => ({ name, input })))).toBeUndefined()
  })

  test("a success breaks the streak", () => {
    const calls = [
      fail("bash", '{"command":"make"}'),
      fail("bash", '{"command":"make"}'),
      fail("bash", '{"command":"make"}', false),
      fail("bash", '{"command":"make"}'),
      fail("bash", '{"command":"make"}'),
    ]
    expect(detectFailureStreak(calls)).toBeUndefined()
  })

  test("a different target breaks the streak", () => {
    const calls = [
      ...Array.from({ length: 4 }, () => fail("read", '{"path":"a"}')),
      fail("read", '{"path":"b"}'),
    ]
    expect(detectFailureStreak(calls)).toBeUndefined()
  })

  test("fewer than threshold does not trip", () => {
    const calls = Array.from({ length: 4 }, () => fail("read", '{"path":"a"}'))
    expect(detectFailureStreak(calls)).toBeUndefined()
  })

  test("newest call must be a failure", () => {
    const calls = [
      ...Array.from({ length: 5 }, () => fail("read", '{"path":"a"}')),
      fail("read", '{"path":"a"}', false),
    ]
    expect(detectFailureStreak(calls)).toBeUndefined()
  })

  test("only the trailing same-target run counts (recovers then loops)", () => {
    const calls = [
      fail("glob", '{"pattern":"*.md"}', false),
      ...Array.from({ length: FAILURE_STREAK_THRESHOLD }, () => fail("bash", '{"command":"loop"}')),
    ]
    expect(detectFailureStreak(calls)?.name).toBe("bash")
  })
})

describe("failureStreakMessage", () => {
  test("names count, tool, and target and says stop repeating", () => {
    const msg = failureStreakMessage({ name: "bash", target: "gcc x.c", count: 5 })
    expect(msg).toContain("5")
    expect(msg).toContain("`bash`")
    expect(msg).toContain("gcc x.c")
    expect(msg.toLowerCase()).toContain("stop repeating")
  })
})

describe("detectRunaway", () => {
  test("trips at the threshold with >=", () => {
    expect(detectRunaway(RUNAWAY_THRESHOLD - 1)).toBe(false)
    expect(detectRunaway(RUNAWAY_THRESHOLD)).toBe(true)
    expect(detectRunaway(RUNAWAY_THRESHOLD + 3)).toBe(true)
  })

  test("message is self-assessment, never a bare 'stop'", () => {
    const msg = runawayMessage(80)
    expect(msg).toContain("80")
    expect(msg.toLowerCase()).toContain("if you're still making real progress")
    expect(msg.toLowerCase()).not.toMatch(/^stop\b/)
  })
})
