// P0 of the Calendar / cron-session creator (notes/calendar-cron-plan.md).
//
// Pure recurrence engine: `nextFire` returns the next fire instant STRICTLY AFTER `after`, computed in a
// fixed UTC offset (minutes) — wall-clock = UTC(after + offset). This is deterministic and unit-testable:
// `after` is always passed in, and only the millis-arg `Date` constructor / `Date.UTC` are used — never
// `Date.now()` or argless `new Date()`. IANA-zone / DST-correct resolution is a later phase; here the
// schedule's HH:MM is interpreted as wall-clock in its own offset.
//
// Semantics are legible-by-design (AGENTS.md anti-obscurantist): a structured `Recurrence`, never a cron
// string. Clamp rules: `monthly` day 31 fires on the month's last day (Feb-28/29, Apr-30, …); `yearly`
// Feb-29 clamps to Feb-28 in non-leap years.

export type EpochMillis = number

export interface HM {
  readonly hour: number // 0..23
  readonly minute: number // 0..59
}

/** 0 = Sunday … 6 = Saturday (matches `Date#getUTCDay`). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

export type Recurrence =
  | { readonly kind: "once"; readonly at: EpochMillis }
  | { readonly kind: "daily"; readonly time: HM }
  | { readonly kind: "weekly"; readonly time: HM; readonly weekdays: ReadonlyArray<Weekday> }
  | { readonly kind: "monthly"; readonly time: HM; readonly day: number } // 1..31, clamped to month length
  | { readonly kind: "yearly"; readonly time: HM; readonly month: number; readonly day: number } // month 1..12

const MINUTE = 60_000
const MAX_SCAN_DAYS = 800 // covers `yearly` (incl. a Feb-29 gap) with headroom

/** Days in a 1-based month of a given year (handles leap Feb). */
export const daysInMonth = (year: number, month1: number): number =>
  new Date(Date.UTC(year, month1, 0)).getUTCDate()

/** Does the recurrence fire on this wall-clock calendar day? (time-of-day is applied by the caller.) */
const matchesDay = (
  rec: Recurrence,
  year: number,
  month1: number,
  day: number,
  weekday: Weekday,
): boolean => {
  switch (rec.kind) {
    case "once":
      return false // handled directly in nextFire
    case "daily":
      return true
    case "weekly":
      return rec.weekdays.includes(weekday)
    case "monthly":
      return day === Math.min(rec.day, daysInMonth(year, month1))
    case "yearly":
      return month1 === rec.month && day === Math.min(rec.day, daysInMonth(year, month1))
  }
}

/**
 * The next fire instant strictly after `after`, or `null` when there is none (a `once` already in the past,
 * or a degenerate recurrence that never matches — e.g. `weekly` with no weekdays).
 *
 * @param tzOffsetMin minutes east of UTC (e.g. +180 for UTC+3). The schedule's HH:MM is wall-clock here.
 */
export const nextFire = (rec: Recurrence, after: EpochMillis, tzOffsetMin = 0): EpochMillis | null => {
  if (rec.kind === "once") return rec.at > after ? rec.at : null

  const off = tzOffsetMin * MINUTE
  const wall = new Date(after + off)
  let year = wall.getUTCFullYear()
  let month0 = wall.getUTCMonth()
  let day = wall.getUTCDate()

  for (let i = 0; i < MAX_SCAN_DAYS; i++) {
    const weekday = new Date(Date.UTC(year, month0, day)).getUTCDay() as Weekday
    if (matchesDay(rec, year, month0 + 1, day, weekday)) {
      const fire = Date.UTC(year, month0, day, rec.time.hour, rec.time.minute) - off
      if (fire > after) return fire
    }
    const next = new Date(Date.UTC(year, month0, day + 1))
    year = next.getUTCFullYear()
    month0 = next.getUTCMonth()
    day = next.getUTCDate()
  }
  return null
}

export * as Recurrence from "./recurrence"
