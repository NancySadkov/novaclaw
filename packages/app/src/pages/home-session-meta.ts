// Pure helpers for the Chats-list row meta (uix-improvement slice 1).

/**
 * Compact per-row timestamp for the day-grouped Chats list: the day is already conveyed
 * by the group header, so a row shows the TIME for anything within the last ~24h and a
 * short date beyond that (the "Older" group spans many days).
 */
export function homeSessionTimeLabel(updated: number, intlLocale: string, now = Date.now()): string {
  const date = new Date(updated)
  const sameDay = new Date(now).toDateString() === date.toDateString()
  const dayMs = 24 * 60 * 60 * 1000
  if (sameDay || now - updated < dayMs) {
    return new Intl.DateTimeFormat(intlLocale, { hour: "numeric", minute: "2-digit" }).format(date)
  }
  return new Intl.DateTimeFormat(intlLocale, { month: "short", day: "numeric" }).format(date)
}
