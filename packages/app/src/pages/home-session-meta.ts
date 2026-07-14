// Pure helpers for the Chats-list row meta (uix-improvement slices 1 + 4).

type SessionLike = {
  id: string
  parentID?: string
  time: { created: number; updated?: number; archived?: number }
}

export type TokenTotals = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  /** input + output + reasoning — the full-traffic figure (details dialog breakdown). */
  total: number
  /**
   * output + reasoning — what the model actually PRODUCED. The Chats-row metric: mixing
   * prompt ingestion into one number is meaningless, and generation is the heavy part.
   */
  generated: number
}

/** Sum token usage across sessions (a chat + its sub-agent threads for the rollup). */
export function tokenTotals(
  sessions: readonly { tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } } }[],
): TokenTotals {
  const out = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0, generated: 0 }
  for (const session of sessions) {
    const tokens = session.tokens
    if (!tokens) continue
    out.input += tokens.input ?? 0
    out.output += tokens.output ?? 0
    out.reasoning += tokens.reasoning ?? 0
    out.cacheRead += tokens.cache?.read ?? 0
    out.cacheWrite += tokens.cache?.write ?? 0
  }
  out.total = out.input + out.output + out.reasoning
  out.generated = out.output + out.reasoning
  return out
}

/** Compact human token count for the Chats-list row badge: 950 · 9.5k · 12k · 1.2M. */
export function compactTokens(count: number): string {
  if (count >= 1e6) return `${(count / 1e6).toFixed(count >= 1e7 ? 0 : 1)}M`
  if (count >= 1e3) return `${(count / 1e3).toFixed(count >= 1e4 ? 0 : 1)}k`
  return String(count)
}

/**
 * A root's subtask subtree as depth-ordered rows (children indented under their parent,
 * newest first per level), skipping archived sessions. The Chats list day-groups ROOTS only;
 * children always render under their root regardless of their own updated day.
 */
export function subtreeRows<T extends SessionLike>(sessions: readonly T[], rootID: string): { session: T; depth: number }[] {
  const byParent = new Map<string, T[]>()
  for (const session of sessions) {
    if (!session.parentID || session.time.archived) continue
    const list = byParent.get(session.parentID) ?? []
    list.push(session)
    byParent.set(session.parentID, list)
  }
  const rows: { session: T; depth: number }[] = []
  const visit = (parentID: string, depth: number, seen: Set<string>) => {
    const children = (byParent.get(parentID) ?? [])
      .slice()
      .sort((a, b) => (b.time.updated ?? b.time.created) - (a.time.updated ?? a.time.created))
    for (const child of children) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      rows.push({ session: child, depth })
      visit(child.id, depth + 1, seen)
    }
  }
  visit(rootID, 1, new Set([rootID]))
  return rows
}

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
