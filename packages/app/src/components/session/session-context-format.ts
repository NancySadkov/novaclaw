import { DateTime } from "luxon"
import * as Timestamp from "@novaclaw/schema/time"

export function createSessionContextFormatter(locale: string) {
  return {
    number(value: number | null | undefined) {
      if (value === undefined) return "—"
      if (value === null) return "—"
      return value.toLocaleString(locale)
    },
    percent(value: number | null | undefined) {
      if (value === undefined) return "—"
      if (value === null) return "—"
      return value.toLocaleString(locale) + "%"
    },
    // Native message times do not pass through the session-store normalizer. Older event/cache
    // inputs and decoded in-process values may therefore differ from REST's epoch millis. Luxon
    // throws on those shapes, so normalize through the shared boundary before formatting.
    time(value: unknown) {
      const millis = Timestamp.toEpochMillis(value)
      if (millis === undefined) return "—"
      return DateTime.fromMillis(millis).setLocale(locale).toLocaleString(DateTime.DATETIME_MED)
    },
  }
}
