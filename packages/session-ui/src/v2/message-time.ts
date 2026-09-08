import * as Timestamp from "@novaclaw/schema/time"

// WHEN a message was written, for the hover chrome beside Copy (owner, 2026-08-23).
//
// 🔴 **Two strings, not one.** A transcript row has almost no horizontal budget, and a full
// date-time on every hovered message would crowd the one control that row exists for. So the chip
// shows the SHORTEST form that is still unambiguous — the clock alone for something said today, the
// date added once it is not — and the complete, unabbreviated form lives in its `title`. The reader
// pays a hover for the precision only when they want it.
//
// ⚠️ **"Today" is the READER's today, not the server's.** These timestamps are epoch milliseconds,
// so the comparison has to happen in the viewer's own zone; comparing raw millisecond ranges (a
// `now - t < 86_400_000` window) would call a message from 23:50 last night "today" at 09:00 and
// would silently break for anyone whose day is not 24 hours long — every DST transition. Comparing
// the rendered Y/M/D triples is the only version that is right in every zone.
//
// Pure so `bun test` reaches it: the transcript itself is a `.tsx` the unit tier cannot load.

export interface MessageTime {
  /** Short label for the hover chip. */
  readonly label: string
  /** The full form, for the chip's `title` — always complete, never abbreviated. */
  readonly full: string
  /** Machine-readable form for the HTML `dateTime` attribute. */
  readonly iso: string
}

function parts(formatter: Intl.DateTimeFormat, date: Date): { y: string; m: string; d: string } {
  const out = { y: "", m: "", d: "" }
  for (const part of formatter.formatToParts(date)) {
    if (part.type === "year") out.y = part.value
    else if (part.type === "month") out.m = part.value
    else if (part.type === "day") out.d = part.value
  }
  return out
}

type MessageTimeFormatters = {
  readonly ymd: Intl.DateTimeFormat
  readonly clock: Intl.DateTimeFormat
  readonly dated: Intl.DateTimeFormat
  readonly complete: Intl.DateTimeFormat
}

/** Four formatters per locale, shared by every transcript row using that locale. */
const formatterCache = new Map<string, MessageTimeFormatters>()

const formattersFor = (locale: string | undefined): MessageTimeFormatters => {
  const key = locale ?? ""
  const cached = formatterCache.get(key)
  if (cached) return cached
  const value: MessageTimeFormatters = {
    ymd: new Intl.DateTimeFormat(locale, { year: "numeric", month: "numeric", day: "numeric" }),
    clock: new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }),
    dated: new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }),
    complete: new Intl.DateTimeFormat(locale, { dateStyle: "full", timeStyle: "medium" }),
  }
  formatterCache.set(key, value)
  return value
}

/** Test seam: clear the small locale cache between constructor-count assertions. */
export const resetMessageTimeFormatterCache = (): void => formatterCache.clear()

/**
 * Format one message's creation time.
 *
 * `locale` is the app's current locale (`language.intl()`); `now` is injected so this is testable
 * and so a row cannot disagree with its neighbour about what "today" is mid-render.
 */
export function messageTime(input: {
  readonly created: unknown
  readonly locale?: string | undefined
  readonly now?: number | undefined
}): MessageTime | undefined {
  const created = Timestamp.toEpochMillis(input.created)
  // ⚠️ Not `!created`: epoch 0 is a real instant, and a falsy check would drop it. `undefined` is
  // the only "we do not know", and a message we cannot date shows no chip rather than a wrong one.
  if (created === undefined) return undefined
  const date = Timestamp.toDate(created)!
  const locale = input.locale || undefined
  const now = new Date(input.now ?? Date.now())

  const { ymd, clock, dated, complete } = formattersFor(locale)
  const sameDay = (() => {
    const a = parts(ymd, date)
    const b = parts(ymd, now)
    return a.y === b.y && a.m === b.m && a.d === b.d
  })()

  return {
    label: sameDay ? clock.format(date) : dated.format(date),
    full: complete.format(date),
    iso: date.toISOString(),
  }
}
