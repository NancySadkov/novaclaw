export interface TerminalRevealPosition {
  /** Ghostty's viewport offset: zero is the live bottom, larger values walk backward through history. */
  viewportY: number
  /** Row within the newly positioned viewport, used to place NovaClaw's search-result highlight. */
  viewportRow: number
}

/** Convert an absolute `buffer.active` row into Ghostty's two different reveal coordinates.
 *
 * `buffer.active.getLine(row)` counts from the OLDEST scrollback line, while `scrollToLine` counts
 * BACKWARD from the live bottom. Treating those as one coordinate is why Search counted matches
 * correctly while revealing nothing. */
export function terminalRevealPosition(
  absoluteRow: number,
  bufferLength: number,
  viewportRows: number,
): TerminalRevealPosition {
  const rows = Math.max(1, Math.floor(viewportRows))
  const scrollback = Math.max(0, Math.floor(bufferLength) - rows)
  const row = Math.max(0, Math.min(Math.floor(absoluteRow), Math.max(0, Math.floor(bufferLength) - 1)))
  const center = Math.floor(rows / 2)
  const viewportY = Math.max(0, Math.min(scrollback, scrollback + center - row))
  const viewportRow = Math.max(0, Math.min(rows - 1, row - scrollback + viewportY))
  return { viewportY, viewportRow }
}
