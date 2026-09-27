import { describe, expect, test } from "bun:test"
import { MACHINE_ALLOWANCE_MB, MIN_KILL_CAP_MB, unitCapMb } from "./commit-cap"

describe("unitCapMb", () => {
  test("small profiles tighten the ceiling", () => {
    expect(unitCapMb({ profilePeakMb: 3000 })).toBe(6000)
    expect(unitCapMb({ profilePeakMb: 100 })).toBe(MIN_KILL_CAP_MB)
  })

  test("large profiles and large machines cannot raise the allowance", () => {
    expect(unitCapMb({ profilePeakMb: 10822, commitLimitMb: 131072 })).toBe(8192)
    expect(MACHINE_ALLOWANCE_MB).toBe(8192)
  })

  test("unprofiled units remain bounded", () => {
    expect(unitCapMb({})).toBe(8192)
    expect(unitCapMb({ commitLimitMb: 32768 })).toBe(8192)
  })

  test("invalid profiles never remove protection", () => {
    for (const profilePeakMb of [0, -5, NaN, Infinity]) expect(unitCapMb({ profilePeakMb })).toBe(8192)
  })

  test("test overrides and declared ceilings can only tighten", () => {
    expect(unitCapMb({ requestedCapMb: 128 })).toBe(128)
    expect(unitCapMb({ requestedCapMb: 99999 })).toBe(8192)
    expect(unitCapMb({ profilePeakMb: 100, requestedCapMb: 99999 })).toBe(MIN_KILL_CAP_MB)
  })

  test("invalid overrides retain the fixed allowance", () => {
    for (const requestedCapMb of [0, -5, NaN, Infinity]) expect(unitCapMb({ requestedCapMb })).toBe(8192)
  })

  test("small machines tighten the cap", () => {
    expect(unitCapMb({ commitLimitMb: 8192 })).toBe(5120)
  })

  test("invalid machine readings retain the fixed allowance", () => {
    for (const commitLimitMb of [0, -5, NaN, Infinity]) expect(unitCapMb({ commitLimitMb })).toBe(8192)
  })
})
