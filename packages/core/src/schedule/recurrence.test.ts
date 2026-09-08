// Pure recurrence engine (P0). Pins: strictly-after semantics, daily rollover, weekly multi-day wrap,
// monthly day-31 clamp across month lengths, yearly Jan-1 + Feb-29 leap/non-leap clamp, and tz offset.
import { describe, expect, test } from "bun:test"
import {
  Recurrence,
  daysInMonth,
  nextFire,
  sameRecurrence,
  zoneOffsetMinutes,
  type HM,
} from "@novaclaw/core/schedule/recurrence"

const at9: HM = { hour: 9, minute: 0 }
// All fixtures are in UTC (offset 0) unless a test passes an offset.
const utc = (y: number, m1: number, d: number, h = 0, min = 0) => Date.UTC(y, m1 - 1, d, h, min)

describe("daysInMonth", () => {
  test("month lengths incl. leap Feb", () => {
    expect(daysInMonth(2025, 1)).toBe(31)
    expect(daysInMonth(2025, 2)).toBe(28)
    expect(daysInMonth(2024, 2)).toBe(29) // leap
    expect(daysInMonth(2025, 4)).toBe(30)
    expect(daysInMonth(2025, 12)).toBe(31)
  })
})

describe("once", () => {
  test("future returns the instant; past and exactly-at return null", () => {
    const t = utc(2025, 6, 1, 12, 0)
    expect(nextFire({ kind: "once", at: t }, utc(2025, 5, 1))).toBe(t)
    expect(nextFire({ kind: "once", at: t }, utc(2025, 7, 1))).toBeNull()
    expect(nextFire({ kind: "once", at: t }, t)).toBeNull() // strictly-after
  })
})

describe("daily", () => {
  const rec = { kind: "daily", time: at9 } as const
  test("fires today when the time is still ahead", () => {
    expect(nextFire(rec, utc(2025, 3, 10, 8, 0))).toBe(utc(2025, 3, 10, 9, 0))
  })
  test("rolls to tomorrow when the time has passed", () => {
    expect(nextFire(rec, utc(2025, 3, 10, 10, 0))).toBe(utc(2025, 3, 11, 9, 0))
  })
  test("exactly at the fire instant returns the NEXT day (strictly-after)", () => {
    expect(nextFire(rec, utc(2025, 3, 10, 9, 0))).toBe(utc(2025, 3, 11, 9, 0))
  })
})

describe("weekly", () => {
  // 2025-03-10 is a Monday (weekday 1).
  test("single weekday: from Wed find next Mon", () => {
    const rec = { kind: "weekly", time: at9, weekdays: [1] } as const // Monday
    // 2025-03-12 is Wednesday
    expect(nextFire(rec, utc(2025, 3, 12, 12, 0))).toBe(utc(2025, 3, 17, 9, 0)) // next Monday
  })
  test("multi weekday wraps across the week boundary", () => {
    const rec = { kind: "weekly", time: at9, weekdays: [1, 5] } as const // Mon + Fri
    // From Fri 2025-03-14 10:00 (past today's fire) -> next is Mon 2025-03-17
    expect(nextFire(rec, utc(2025, 3, 14, 10, 0))).toBe(utc(2025, 3, 17, 9, 0))
    // From Tue 2025-03-11 -> next is Fri 2025-03-14
    expect(nextFire(rec, utc(2025, 3, 11, 0, 0))).toBe(utc(2025, 3, 14, 9, 0))
  })
  test("no weekdays never fires", () => {
    expect(nextFire({ kind: "weekly", time: at9, weekdays: [] }, utc(2025, 3, 10))).toBeNull()
  })
})

describe("monthly", () => {
  test("fires this month, then next month", () => {
    const rec = { kind: "monthly", time: at9, day: 15 } as const
    expect(nextFire(rec, utc(2025, 3, 10))).toBe(utc(2025, 3, 15, 9, 0))
    expect(nextFire(rec, utc(2025, 3, 20))).toBe(utc(2025, 4, 15, 9, 0))
  })
  test("day 31 clamps to the last day of shorter months", () => {
    const rec = { kind: "monthly", time: at9, day: 31 } as const
    // From Feb 2025 (28 days) -> Feb 28
    expect(nextFire(rec, utc(2025, 2, 1))).toBe(utc(2025, 2, 28, 9, 0))
    // From Apr 2025 (30 days) -> Apr 30
    expect(nextFire(rec, utc(2025, 4, 1))).toBe(utc(2025, 4, 30, 9, 0))
    // From Jan 31 10:00 (past) -> Feb 28
    expect(nextFire(rec, utc(2025, 1, 31, 10, 0))).toBe(utc(2025, 2, 28, 9, 0))
  })
})

describe("yearly", () => {
  test("Jan 1 from mid-year and from Dec 31", () => {
    const rec = { kind: "yearly", time: at9, month: 1, day: 1 } as const
    expect(nextFire(rec, utc(2025, 6, 15))).toBe(utc(2026, 1, 1, 9, 0))
    expect(nextFire(rec, utc(2025, 12, 31, 23, 59))).toBe(utc(2026, 1, 1, 9, 0))
  })
  test("Feb 29 fires on leap years and clamps to Feb 28 otherwise", () => {
    const rec = { kind: "yearly", time: at9, month: 2, day: 29 } as const
    // From 2024-01-01 -> 2024-02-29 (leap)
    expect(nextFire(rec, utc(2024, 1, 1))).toBe(utc(2024, 2, 29, 9, 0))
    // From 2025-01-01 -> 2025-02-28 (clamp, non-leap)
    expect(nextFire(rec, utc(2025, 1, 1))).toBe(utc(2025, 2, 28, 9, 0))
  })
})

describe("timezone offset", () => {
  test("daily 09:00 at UTC+3 fires at 06:00 UTC", () => {
    const rec = { kind: "daily", time: at9 } as const
    // after = 2025-03-10 05:00 UTC (= 08:00 wall) -> fire 09:00 wall = 06:00 UTC same day
    expect(nextFire(rec, utc(2025, 3, 10, 5, 0), 180)).toBe(utc(2025, 3, 10, 6, 0))
  })
  test("yearly Jan-1 09:00 at UTC+3 = 2025-12-31 06:00 UTC boundary", () => {
    const rec = { kind: "yearly", time: at9, month: 1, day: 1 } as const
    // Jan 1 2026 09:00 wall (UTC+3) = Jan 1 2026 06:00 UTC
    expect(nextFire(rec, utc(2025, 6, 1), 180)).toBe(utc(2026, 1, 1, 6, 0))
  })
})

// A REAL zone and REAL transition dates, never offset arithmetic — the whole defect is that an offset
// cannot express a zone, so a fixture built out of offsets could not tell the two apart.
// Europe/Amsterdam: CET (+60) <-> CEST (+120); clocks spring forward 2026-03-29 01:00 UTC (02:00 -> 03:00
// local) and fall back 2026-10-25 01:00 UTC (03:00 -> 02:00 local).
describe("daylight saving in a named zone", () => {
  const AMS = "Europe/Amsterdam"
  const at0230: HM = { hour: 2, minute: 30 }
  const daily9AMS = { kind: "daily", time: at9, zone: AMS } as const
  const daily0230AMS = { kind: "daily", time: at0230, zone: AMS } as const

  test("the runtime really resolves this zone (otherwise every case below silently tests the fallback)", () => {
    expect(zoneOffsetMinutes(AMS, utc(2026, 7, 1))).toBe(120) // CEST
    expect(zoneOffsetMinutes(AMS, utc(2026, 1, 1))).toBe(60) // CET
    expect(zoneOffsetMinutes("Mars/Olympus", utc(2026, 1, 1))).toBeUndefined()
  })

  test("09:00 local stays 09:00 local across the spring-forward", () => {
    // Sat 2026-03-28 09:00 CET = 08:00 UTC; Sun 2026-03-29 09:00 CEST = 07:00 UTC.
    expect(nextFire(daily9AMS, utc(2026, 3, 28, 0, 0))).toBe(utc(2026, 3, 28, 8, 0))
    expect(nextFire(daily9AMS, utc(2026, 3, 28, 8, 0))).toBe(utc(2026, 3, 29, 7, 0))
  })

  test("09:00 local stays 09:00 local across the autumn-back", () => {
    // Sat 2026-10-24 09:00 CEST = 07:00 UTC; Sun 2026-10-25 09:00 CET = 08:00 UTC.
    expect(nextFire(daily9AMS, utc(2026, 10, 24, 0, 0))).toBe(utc(2026, 10, 24, 7, 0))
    expect(nextFire(daily9AMS, utc(2026, 10, 24, 7, 0))).toBe(utc(2026, 10, 25, 8, 0))
  })

  test("the same schedule pinned to a FIXED offset shifts by an hour — the defect a zone removes", () => {
    const noZone = { kind: "daily", time: at9 } as const
    // +120 was captured in summer. The morning after the transition it still fires at 07:00 UTC, which
    // is now 08:00 local: an hour early, every day, until the next transition puts it back.
    expect(nextFire(noZone, utc(2026, 10, 24, 7, 0), 120)).toBe(utc(2026, 10, 25, 7, 0))
    expect(nextFire(daily9AMS, utc(2026, 10, 24, 7, 0))).toBe(utc(2026, 10, 25, 8, 0))
  })

  test("a wall time that never happens fires shifted forward by the gap, and stays 24h from its neighbour", () => {
    // 2026-03-29 02:30 local does not exist. The run happens, at 03:30 CEST = 01:30 UTC.
    const previous = nextFire(daily0230AMS, utc(2026, 3, 27, 12, 0))
    expect(previous).toBe(utc(2026, 3, 28, 1, 30)) // 02:30 CET
    const inTheGap = nextFire(daily0230AMS, utc(2026, 3, 28, 12, 0))
    expect(inTheGap).toBe(utc(2026, 3, 29, 1, 30))
    expect(inTheGap! - previous!).toBe(24 * 60 * 60_000)
  })

  test("a wall time that happens TWICE fires once, at the first of the two", () => {
    const first = utc(2026, 10, 25, 0, 30) // 02:30 CEST
    const second = utc(2026, 10, 25, 1, 30) // 02:30 CET — the same wall clock, an hour later
    expect(nextFire(daily0230AMS, utc(2026, 10, 24, 12, 0))).toBe(first)
    // Standing at the first occurrence, the repeat is NOT a second occurrence: the next fire is tomorrow.
    expect(nextFire(daily0230AMS, first)).not.toBe(second)
    expect(nextFire(daily0230AMS, first)).toBe(utc(2026, 10, 26, 1, 30))
  })

  test("a zone this runtime cannot resolve degrades to the fixed offset instead of throwing", () => {
    const rec = { kind: "daily", time: at9, zone: "Mars/Olympus" } as const
    expect(nextFire(rec, utc(2025, 3, 10, 5, 0), 180)).toBe(utc(2025, 3, 10, 6, 0))
  })
})

describe("sameRecurrence", () => {
  test("equal by VALUE, not by key order or object identity", () => {
    expect(sameRecurrence({ kind: "daily", time: at9 }, { time: { minute: 0, hour: 9 }, kind: "daily" })).toBe(true)
    expect(
      sameRecurrence({ kind: "weekly", time: at9, weekdays: [1, 5] }, { kind: "weekly", time: at9, weekdays: [1, 5] }),
    ).toBe(true)
  })
  test("a real change in any field is a change", () => {
    expect(sameRecurrence({ kind: "daily", time: at9 }, { kind: "daily", time: { hour: 18, minute: 0 } })).toBe(false)
    expect(sameRecurrence({ kind: "daily", time: at9 }, { kind: "weekly", time: at9, weekdays: [1] })).toBe(false)
    expect(
      sameRecurrence({ kind: "weekly", time: at9, weekdays: [1, 5] }, { kind: "weekly", time: at9, weekdays: [1] }),
    ).toBe(false)
    expect(sameRecurrence({ kind: "monthly", time: at9, day: 1 }, { kind: "monthly", time: at9, day: 2 })).toBe(false)
    expect(
      sameRecurrence({ kind: "yearly", time: at9, month: 1, day: 1 }, { kind: "yearly", time: at9, month: 2, day: 1 }),
    ).toBe(false)
    expect(sameRecurrence({ kind: "once", at: 1 }, { kind: "once", at: 2 })).toBe(false)
    // The zone is part of the rule: moving a schedule to another zone reschedules it.
    expect(sameRecurrence({ kind: "daily", time: at9 }, { kind: "daily", time: at9, zone: "Europe/Amsterdam" })).toBe(
      false,
    )
  })
})

describe("namespace export", () => {
  test("Recurrence.nextFire is the same function", () => {
    expect(Recurrence.nextFire({ kind: "daily", time: at9 }, utc(2025, 3, 10, 8, 0))).toBe(utc(2025, 3, 10, 9, 0))
  })
})
