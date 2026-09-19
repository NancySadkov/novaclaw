import { describe, expect, test } from "bun:test"
import { ContextBudget } from "@novaclaw/core/session/runner/context-budget"
import {
  ALLOCATION_CATEGORIES,
  ALLOCATION_PROFILES,
  DEFAULT_ALLOCATION,
  allocationRecord,
  allocationShares,
  moveBoundary,
} from "./context-allocation"

/**
 * The context-allocation split, as arithmetic.
 *
 * 🔴 Two properties carry the design: (1) the five parts always total 100, because the only edit is
 * a transfer between neighbours; (2) the app's mirror of the shipped defaults cannot drift from the
 * kernel's, which IS checked by importing the kernel's table rather than trusting a comment.
 */
describe("context allocation arithmetic", () => {
  test("the app's mirror equals the kernel's shipped profiles, key for key", () => {
    for (const profile of ALLOCATION_PROFILES) {
      expect(DEFAULT_ALLOCATION[profile]).toEqual(ContextBudget.DEFAULT_PROFILES[profile])
    }
  })

  test("moving a boundary transfers points between neighbours and preserves the total", () => {
    const shares = [25, 40, 10, 5, 20]
    expect(moveBoundary(shares, 0, 10)).toEqual([35, 30, 10, 5, 20])
    expect(moveBoundary(shares, 0, -10)).toEqual([15, 50, 10, 5, 20])
    expect(moveBoundary(shares, 0, 10).reduce((sum, share) => sum + share, 0)).toBe(100)
  })

  test("a drag cannot push either neighbour below zero", () => {
    const shares = [25, 40, 10, 5, 20]
    expect(moveBoundary(shares, 0, 999)).toEqual([65, 0, 10, 5, 20])
    expect(moveBoundary(shares, 0, -999)).toEqual([0, 65, 10, 5, 20])
    expect(moveBoundary(shares, 3, 999)).toEqual([25, 40, 10, 25, 0])
  })

  test("an out-of-range boundary is a no-op, never a throw", () => {
    const shares = [25, 40, 10, 5, 20]
    expect(moveBoundary(shares, 9, 5)).toBe(shares)
    expect(moveBoundary(shares, -1, 5)).toBe(shares)
  })

  test("every shipped profile totals exactly 100, and reads back to its own record", () => {
    for (const profile of ALLOCATION_PROFILES) {
      const shares = allocationShares(profile, undefined)
      expect(shares.reduce((sum, share) => sum + share, 0)).toBe(100)
      expect(allocationRecord(shares)).toEqual(DEFAULT_ALLOCATION[profile])
      expect(shares).toEqual(ALLOCATION_CATEGORIES.map((category) => DEFAULT_ALLOCATION[profile][category]))
    }
  })

  test("a stored partial profile wins per key over the default", () => {
    expect(allocationShares("interactive", { messages: 60 })).toEqual([25, 60, 10, 5, 20])
    expect(allocationShares("sub-agent", { system: 5, tool_output: 45 })).toEqual([5, 30, 10, 5, 45])
  })
})
