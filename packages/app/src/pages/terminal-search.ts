/** Finding text in a terminal.
 *
 * ⚠️ The route matters, and the obvious one is wrong. ghostty-web exposes `getScrollbackLine()`, which
 * is the API a search reaches for first — and it is HISTORY ONLY, explicitly "not including the active
 * screen". A search built on it cannot find text the user is looking at, which is the single most
 * likely thing they are searching for. `buffer.active` (xterm.js-compatible) spans scrollback AND the
 * active screen in one absolute coordinate space. Ghostty's reveal APIs do NOT share that space:
 * `scrollToLine` counts backward from the live bottom and `select` takes a viewport row, so
 * `components/terminal-reveal.ts` performs the required conversion.
 *
 * The matching itself lives here, away from the renderer, because it is the part with edge cases.
 */
export interface TerminalMatch {
  /** Absolute `buffer.active` row, oldest scrollback first. */
  row: number
  column: number
  length: number
}

/** Every occurrence, in reading order, case-insensitively. Overlapping matches are not reported —
 * searching "aa" in "aaa" gives one match, like every editor's find. */
export function findMatches(lines: readonly string[], query: string): TerminalMatch[] {
  if (!query) return []
  const needle = query.toLowerCase()
  const matches: TerminalMatch[] = []
  for (let row = 0; row < lines.length; row++) {
    const haystack = (lines[row] ?? "").toLowerCase()
    let from = 0
    for (;;) {
      const column = haystack.indexOf(needle, from)
      if (column === -1) break
      matches.push({ row, column, length: query.length })
      from = column + needle.length
    }
  }
  return matches
}

/** Which match to reveal next.
 *
 * Wraps deliberately — a find bar that stops dead at the last match makes the user guess whether there
 * are no more or they have hit the end. `current` may be out of range (the buffer grows under a live
 * shell while the bar is open), so it is treated as "no position yet" rather than clamped: clamping
 * would silently jump to an unrelated match after the buffer moved.
 */
export function stepMatch(total: number, current: number | undefined, direction: "next" | "previous"): number {
  if (total <= 0) return -1
  if (current === undefined || current < 0 || current >= total) return direction === "next" ? 0 : total - 1
  return direction === "next" ? (current + 1) % total : (current - 1 + total) % total
}
