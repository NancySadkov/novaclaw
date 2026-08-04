import { DateTime } from "luxon"
import { sessionTimeMillis } from "@/utils/session-time"

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
    // A `time.created` fed here can be epoch millis (REST/replay) OR an ISO string: native message
    // times aren't run through `normalizeSessionTimes`, and the live SSE mirror carries Type-side
    // DateTime as an ISO string (see utils/session-time.ts). `DateTime.fromMillis` throws on a
    // string, which crashed the whole context tab — so tolerate both, like `sessionTimeMillis`.
    time(value: number | string | null | undefined) {
      if (value === undefined || value === null || value === "") return "—"
      const millis = typeof value === "number" ? value : sessionTimeMillis(value)
      if (!millis) return "—"
      return DateTime.fromMillis(millis).setLocale(locale).toLocaleString(DateTime.DATETIME_MED)
    },
  }
}
