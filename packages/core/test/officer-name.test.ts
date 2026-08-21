import { describe, expect, test } from "bun:test"
import { OfficerName } from "@novaclaw/core/agent/officer-name"

// Naming the colleagues Nova hires (owner, 2026-08-21). The properties worth pinning are the ones a
// roster's readability depends on: a name is drawn from the pool, a taken one is re-rolled, and a
// roster full of Therons still terminates with a name rather than a hang or a throw.

const cycle = (values: readonly number[]) => {
  let index = 0
  return () => values[index++ % values.length]!
}

const POOL = ["theron", "kallias", "nikias"] as const

describe("picking an officer's name", () => {
  test("draws from the pool", () => {
    expect(OfficerName.pick({ taken: [], random: () => 0, pool: POOL })).toBe("theron")
    expect(OfficerName.pick({ taken: [], random: () => 0.99, pool: POOL })).toBe("nikias")
  })

  test("re-rolls past a name already on the roster", () => {
    // First draw lands on the taken one, second on a free one.
    expect(OfficerName.pick({ taken: ["theron"], random: cycle([0, 0.5]), pool: POOL })).toBe("kallias")
  })

  test("matching is case-insensitive, because the confusion is a READING one", () => {
    // "Theron" the display name and "theron" the id are the same name to a person reading a hand-off.
    expect(OfficerName.pick({ taken: ["  THERON "], random: cycle([0, 0.5]), pool: POOL })).toBe("kallias")
  })

  test("numbers the name when every re-roll lands on a taken one", () => {
    const taken = ["theron", "kallias", "nikias"]
    // A pool entirely spoken for: this must still return a usable name rather than loop or throw.
    expect(OfficerName.pick({ taken, random: () => 0, pool: POOL })).toBe("theron-2")
  })

  test("counts up past existing numbered names", () => {
    const taken = ["theron", "kallias", "nikias", "theron-2", "theron-3"]
    expect(OfficerName.pick({ taken, random: () => 0, pool: POOL })).toBe("theron-4")
  })

  test("a full roster of one name still terminates", () => {
    // The pathological case, asserted rather than assumed: 60 Therons, and the 61st is named.
    const taken = ["theron", "kallias", "nikias", ...Array.from({ length: 60 }, (_, i) => `theron-${i + 2}`)]
    expect(OfficerName.pick({ taken, random: () => 0, pool: POOL })).toBe("theron-62")
  })
})

describe("the shipped pool", () => {
  test("is large, lowercase, unique and slug-shaped", () => {
    expect(OfficerName.POOL.length).toBeGreaterThan(500)
    expect(new Set(OfficerName.POOL).size).toBe(OfficerName.POOL.length)
    for (const name of OfficerName.POOL) expect(name).toMatch(/^[a-z][a-z-]*$/)
  })

  test("does not contain the governing agent's name", () => {
    // Nova is seeded in code. Drawing "nova" for a new hire would put two of them in the roster.
    expect(OfficerName.POOL).not.toContain("nova")
  })
})

describe("display form", () => {
  test("capitalises the slug the store holds", () => {
    expect(OfficerName.display("theron")).toBe("Theron")
    expect(OfficerName.display("theron-2")).toBe("Theron 2")
  })
})
