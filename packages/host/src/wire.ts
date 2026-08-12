/**
 * The vocabulary and the wire format, shared by both runtime twins.
 *
 * Kept apart from either implementation because it must be importable WITHOUT `bun:ffi`. The Electron
 * sidecar is a Node utility process; a module graph that reaches a `bun:` import there dies at load
 * with `ERR_UNSUPPORTED_ESM_URL_SCHEME`, and that is a packaged-only failure a green suite cannot see.
 */

export type WatchEventType = "create" | "update" | "delete" | "overflow"

export interface WatchEvent {
  readonly type: WatchEventType
  /**
   * Absolute, in the platform's NATIVE separator — backslashes on Windows, so it compares equal to a
   * `path.join` result without normalising first. Empty only for `overflow`, which names no path.
   */
  readonly path: string
}

export interface Watch {
  /** Everything that happened since the last drain. */
  readonly poll: () => WatchEvent[]
  readonly close: () => void
}

export interface WatchOptions {
  readonly bufferBytes?: number
  /** Directory NAMES (not globs, not paths) dropped before an event is ever queued. */
  readonly ignoreDirectories?: readonly string[]
}

const TYPES: Readonly<Record<number, WatchEventType>> = {
  1: "create",
  2: "update",
  3: "delete",
  4: "overflow",
}

/**
 * Decode the poll buffer: `[type byte][UTF-8 path][NUL]`, repeated.
 *
 * Exported for its own test — the wire format is the one place a silent mistake turns into wrong
 * paths rather than an error, and it is pure, so it can be checked without touching a filesystem.
 */
export const decode = (buffer: Uint8Array, length: number): WatchEvent[] => {
  const events: WatchEvent[] = []
  const decoder = new TextDecoder()
  let index = 0
  while (index < length) {
    const type = TYPES[buffer[index]!]
    index += 1
    let end = index
    while (end < length && buffer[end] !== 0) end += 1
    const value = decoder.decode(buffer.subarray(index, end))
    index = end + 1
    // An unrecognised type byte is a version skew the ABI check should have caught; drop the record
    // rather than invent an event, and keep going so one bad byte is not a whole lost drain.
    if (type !== undefined) events.push({ type, path: value })
  }
  return events
}

/**
 * Should this absolute path be dropped, given directory names to ignore?
 *
 * ⚠️ Only segments BELOW `root`. Watching `/home/me/build/project` must not discard the whole tree
 * because an ancestor is named `build` — the caller asked to watch that directory, and an ignore rule
 * may not overrule the subject of the watch itself. The same rule the C side applies, restated here
 * for the runtime that has no C side.
 */
export const ignored = (names: ReadonlySet<string>, root: string, full: string): boolean => {
  if (names.size === 0) return false
  if (full.length <= root.length + 1) return false
  for (const segment of full.slice(root.length + 1).split(/[/\\]/)) if (names.has(segment)) return true
  return false
}
