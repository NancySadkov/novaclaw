// P0 of the Calendar / cron-session creator.
//
// Pure recurrence engine: `nextFire` returns the next fire instant STRICTLY AFTER `after`. This is
// deterministic and unit-testable: `after` is always passed in, and only the millis-arg `Date`
// constructor / `Date.UTC` / a zone-pinned `Intl.DateTimeFormat` are used — never `Date.now()` or an
// argless `new Date()`.
//
// 🔴 WHAT A SCHEDULE MEANS: a WALL CLOCK in a named place. "daily 09:00" is 09:00 where the user lives,
// on every side of a daylight-saving transition — so the UTC instant MOVES twice a year and the local
// hour does not. The alternative reading (a fixed interval, so the local hour drifts) is what a stored
// offset actually implements, and it is not what anyone means by "every morning at nine".
//
// A fixed `tzOffsetMin` cannot express that, because an offset is a zone's answer at ONE instant, not
// the zone. It is kept as the DEGRADED fallback for a schedule whose zone was never captured; when
// `zone` is set it WINS, and `zoningOf` is the single place that decides. The two DST edges are
// answered explicitly rather than falling out of the arithmetic:
//
//   - a wall time that does NOT EXIST (clocks spring forward over it) fires shifted forward by the gap,
//     so the run happens that day and stays 24h from its neighbours. Skipping it would be a silent
//     dropped occurrence, which is the one outcome an unattended schedule must never produce.
//   - a wall time that happens TWICE (clocks fall back over it) fires ONCE, at the FIRST of the two.
//     A duplicated unattended run is worse than a late one, and the fire ledger keys on the instant, so
//     without this rule both instants would be separate, both due, and both fired.
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

/**
 * `zone` is an IANA name ("Europe/Amsterdam"). It belongs to the RULE, not beside it: "09:00 daily" is
 * not a set of instants until you say where 09:00 is read, exactly as an iCalendar rule carries its
 * TZID. Absent = fall back to the schedule's fixed offset, which is DST-blind.
 */
export type Recurrence =
  | { readonly kind: "once"; readonly at: EpochMillis }
  | { readonly kind: "daily"; readonly time: HM; readonly zone?: string }
  | { readonly kind: "weekly"; readonly time: HM; readonly weekdays: ReadonlyArray<Weekday>; readonly zone?: string }
  | { readonly kind: "monthly"; readonly time: HM; readonly day: number; readonly zone?: string } // day 1..31, clamped
  | {
      readonly kind: "yearly"
      readonly time: HM
      readonly month: number // 1..12
      readonly day: number
      readonly zone?: string
    }

const MINUTE = 60_000
const HALF_DAY = 12 * 60 * MINUTE
const MAX_SCAN_DAYS = 800 // covers `yearly` (incl. a Feb-29 gap) with headroom

/** Days in a 1-based month of a given year (handles leap Feb). */
export const daysInMonth = (year: number, month1: number): number => new Date(Date.UTC(year, month1, 0)).getUTCDate()

/** The zone a recurrence reads its wall clock in, or undefined (`once` is an absolute instant). */
export const zoneOf = (rec: Recurrence): string | undefined => (rec.kind === "once" ? undefined : rec.zone)

/** Return `rec` carrying `zone`, unless it is an absolute instant or already names one. */
export const withZone = (rec: Recurrence, zone: string | undefined): Recurrence =>
  rec.kind === "once" || zone === undefined || rec.zone !== undefined ? rec : { ...rec, zone }

/**
 * Structural equality — the test for "did this patch actually change WHEN it fires?".
 *
 * ⚠️ Deliberately not `JSON.stringify` equality: two payloads that mean the same rule can differ by key
 * order, and a false "changed" here moves the next fire forward past an occurrence that is already due.
 */
export const sameRecurrence = (a: Recurrence, b: Recurrence): boolean => {
  if (a.kind !== b.kind) return false
  if (a.kind === "once") return a.at === (b as typeof a).at
  const other = b as Exclude<Recurrence, { kind: "once" }>
  if (a.time.hour !== other.time.hour || a.time.minute !== other.time.minute) return false
  if (a.zone !== other.zone) return false
  switch (a.kind) {
    case "daily":
      return true
    case "weekly": {
      const mine = a.weekdays
      const theirs = (other as typeof a).weekdays
      return mine.length === theirs.length && mine.every((d, i) => d === theirs[i])
    }
    case "monthly":
      return a.day === (other as typeof a).day
    case "yearly":
      return a.day === (other as typeof a).day && a.month === (other as typeof a).month
  }
}

/**
 * One `Intl.DateTimeFormat` per zone, built once. `null` records a name this runtime cannot resolve, so
 * an unknown zone costs one throw ever and then degrades to the fixed offset instead of throwing at
 * every fire computation.
 */
const formatters = new Map<string, Intl.DateTimeFormat | null>()
const formatterFor = (zone: string): Intl.DateTimeFormat | null => {
  const cached = formatters.get(zone)
  if (cached !== undefined) return cached
  let made: Intl.DateTimeFormat | null = null
  try {
    made = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
  } catch {
    made = null
  }
  formatters.set(zone, made)
  return made
}

interface WallParts {
  readonly year: number
  readonly month0: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
}

const wallPartsAt = (fmt: Intl.DateTimeFormat, instant: EpochMillis): WallParts => {
  const parts = fmt.formatToParts(new Date(instant))
  const read = (type: string): number => {
    const found = parts.find((part) => part.type === type)
    return found === undefined ? 0 : Number(found.value)
  }
  return {
    year: read("year"),
    month0: read("month") - 1,
    day: read("day"),
    hour: read("hour"),
    minute: read("minute"),
    second: read("second"),
  }
}

/** Minutes east of UTC that `zone` was at `instant`. */
const offsetMinAt = (fmt: Intl.DateTimeFormat, instant: EpochMillis): number => {
  const wall = wallPartsAt(fmt, instant)
  const asUtc = Date.UTC(wall.year, wall.month0, wall.day, wall.hour, wall.minute, wall.second)
  return Math.round((asUtc - Math.floor(instant / 1000) * 1000) / MINUTE)
}

/** Minutes east of UTC that a named zone was at `instant`, or undefined when the name is unusable. */
export const zoneOffsetMinutes = (zone: string, instant: EpochMillis): number | undefined => {
  const fmt = formatterFor(zone)
  return fmt === null ? undefined : offsetMinAt(fmt, instant)
}

/**
 * The instant whose wall clock in this zone is `year-month0-day hour:minute`.
 *
 * Both offsets that could apply are tried and VERIFIED by reading the zone back at the candidate. Two
 * valid candidates means the wall time happens twice (fall back) → the earlier one. Neither valid means
 * it never happens (spring forward) → the later one, which is the nominal time shifted forward by the
 * size of the gap.
 */
const instantForWall = (
  fmt: Intl.DateTimeFormat,
  year: number,
  month0: number,
  day: number,
  hour: number,
  minute: number,
): EpochMillis => {
  const nominal = Date.UTC(year, month0, day, hour, minute)
  const estimate = nominal - offsetMinAt(fmt, nominal) * MINUTE
  const earlyOffset = offsetMinAt(fmt, estimate - HALF_DAY)
  const lateOffset = offsetMinAt(fmt, estimate + HALF_DAY)
  const early = nominal - earlyOffset * MINUTE
  const late = nominal - lateOffset * MINUTE
  const earlyValid = offsetMinAt(fmt, early) === earlyOffset
  const lateValid = offsetMinAt(fmt, late) === lateOffset
  if (earlyValid && lateValid) return Math.min(early, late)
  if (earlyValid) return early
  if (lateValid) return late
  return Math.max(early, late)
}

/** Does the recurrence fire on this wall-clock calendar day? (time-of-day is applied by the caller.) */
const matchesDay = (rec: Recurrence, year: number, month1: number, day: number, weekday: Weekday): boolean => {
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

/** How a schedule's wall clock is resolved. A named zone is DST-correct; a fixed offset is not. */
export type Zoning =
  | { readonly kind: "zone"; readonly name: string; readonly format: Intl.DateTimeFormat }
  | { readonly kind: "offset"; readonly minutes: number }

/**
 * THE ONE PLACE that decides which of the two answers is in force, so no caller has to remember the
 * precedence: a usable zone on the rule wins, and the stored offset is what is left when there is none.
 */
export const zoningOf = (rec: Recurrence, tzOffsetMin: number): Zoning => {
  const zone = zoneOf(rec)
  if (zone !== undefined) {
    const format = formatterFor(zone)
    if (format !== null) return { kind: "zone", name: zone, format }
  }
  return { kind: "offset", minutes: tzOffsetMin }
}

/**
 * The next fire instant strictly after `after`, or `null` when there is none (a `once` already in the past,
 * or a degenerate recurrence that never matches — e.g. `weekly` with no weekdays).
 *
 * @param tzOffsetMin minutes east of UTC (e.g. +180 for UTC+3), used only when the rule names no zone.
 */
export const nextFire = (rec: Recurrence, after: EpochMillis, tzOffsetMin = 0): EpochMillis | null => {
  if (rec.kind === "once") return rec.at > after ? rec.at : null

  const zoning = zoningOf(rec, tzOffsetMin)
  const off = zoning.kind === "offset" ? zoning.minutes * MINUTE : 0
  const start =
    zoning.kind === "zone"
      ? wallPartsAt(zoning.format, after)
      : (() => {
          const wall = new Date(after + off)
          return { year: wall.getUTCFullYear(), month0: wall.getUTCMonth(), day: wall.getUTCDate() }
        })()
  let year = start.year
  let month0 = start.month0
  let day = start.day

  for (let i = 0; i < MAX_SCAN_DAYS; i++) {
    const weekday = new Date(Date.UTC(year, month0, day)).getUTCDay() as Weekday
    if (matchesDay(rec, year, month0 + 1, day, weekday)) {
      const fire =
        zoning.kind === "zone"
          ? instantForWall(zoning.format, year, month0, day, rec.time.hour, rec.time.minute)
          : Date.UTC(year, month0, day, rec.time.hour, rec.time.minute) - off
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
