import { describe, expect, test } from "bun:test"
import { systemLoadStats, type SystemLoad } from "./system-load"

// The hero tile is the one surface that reports whether this machine is in trouble, and the state
// that matters most — memory strained — is the one a test rig can reach and a person cannot stage on
// demand. So the formatting rules are pinned here rather than checked by looking at a healthy laptop.

// A translator that echoes the key's last segment, so a test asserts on the WORDING slot without
// hard-coding English (and a typo'd key shows up as the wrong word rather than silently passing).
const t = (key: string) => key.split(".").pop()!

const load = (over: Partial<SystemLoad> = {}): SystemLoad => ({ running: 0, tps: 0, memory: undefined, ...over })
const byId = (input: SystemLoad, id: string) => systemLoadStats(input, t).find((stat) => stat.id === id)!

describe("the hero readout", () => {
  test("an idle instance still reports, dimmed rather than hidden", () => {
    const running = byId(load(), "running")
    expect(running.value).toBe("0")
    // Dimmed, NOT absent: a monitor that vanishes when quiet cannot answer "is it idle or broken?"
    expect(running.tone).toBe("idle")
  })

  test("work in flight reads at full strength", () => {
    const stats = systemLoadStats(load({ running: 3, tps: 47 }), t)
    expect(stats.find((stat) => stat.id === "running")).toMatchObject({ value: "3", tone: undefined })
    expect(stats.find((stat) => stat.id === "throughput")).toMatchObject({ value: "47", tone: undefined })
  })

  test("slow real output stays fractional instead of rounding up to one", () => {
    expect(byId(load({ running: 1, tps: 9 / 37.9 }), "throughput")).toMatchObject({
      value: "0.2",
      tone: undefined,
    })
  })

  test("a running agent between steps shows a dash, never a stalled-looking zero", () => {
    // 0 t/s with an agent running is normal (it is in a tool call). Printing "0" would read as hung.
    expect(byId(load({ running: 1, tps: 0 }), "throughput")).toMatchObject({ value: "—", tone: "idle" })
  })

  test("memory is a percentage, and a healthy host is NOT painted as a warning", () => {
    const memory = byId(load({ memory: { fraction: 0.653, strained: false } }), "memory")
    expect(memory.value).toBe("65%")
    expect(memory.tone).toBeUndefined()
  })

  test("memory warns only when the INSTANCE says it is strained", () => {
    // The fraction alone must not decide it: the instance's rule weighs absolute headroom too, and a
    // client that re-derived "high percentage = trouble" would light up on a healthy 46 GB host.
    expect(byId(load({ memory: { fraction: 0.93, strained: false } }), "memory").tone).toBeUndefined()
    expect(byId(load({ memory: { fraction: 0.93, strained: true } }), "memory").tone).toBe("warn")
  })

  test("an unmeasurable host shows a dash, never a reassuring zero", () => {
    // `pressure.ts`: unknown is a value, not a zero. "0%" would claim the machine is empty.
    const memory = byId(load(), "memory")
    expect(memory.value).toBe("—")
    expect(memory.tone).toBeUndefined()
  })

  test("every stat carries a label slot", () => {
    expect(systemLoadStats(load(), t).map((stat) => stat.label)).toEqual(["running", "throughput", "memory"])
  })
})
