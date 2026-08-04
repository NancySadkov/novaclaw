import { Effect } from "effect"
import { type Attributes, type EventKey, EVENTS } from "./log-events"

/**
 * **The keyed log call — a thin wrapper over `Effect.log*`, and nothing else.**
 *
 * `todo/logging.md` item 1b, pass 1. There is exactly one line of behaviour in this module, and the
 * important thing about it is what it does NOT do: it opens no file, holds no state, starts no
 * daemon and adds no sink. A keyed record goes through the same `Effect.log*` entry point, the same
 * `Logger` layer, core's same logfmt formatter (`observability/logging.ts`) and into the same
 * `novaclaw.log` as the 172 un-keyed sites do today. §0.2 of that document is explicit that a
 * second writer beside
 * `novaclaw.log` is the defect class this project keeps re-finding; this is a column, not a channel.
 *
 * ── what the line looks like ────────────────────────────────────────────────────────────────────
 *
 *   timestamp=… level=INFO run=d66de246 event=filesystem.watcher.start message="watcher backend" …
 *
 * `event=` rides in as a structured message part, so it lands immediately after `run=` and before
 * `message=`, with **no change to the formatter at all**. ⚠️ That is one field later than
 * `todo/logging.md` 1a's "immediately after `level=`", and the deviation is deliberate: putting it
 * there means editing the one function every existing log line in the product flows through, for a
 * column position that no `grep`, `cut -d= -f2` or logfmt reader can observe. `grep 'event=mcp\.'`
 * is identical either way. The formatter change is real risk for cosmetic gain, so it is not taken.
 *
 * ── two properties worth stating, because both are checked ──────────────────────────────────────
 *
 * 1. **`message=` is unchanged.** The English is the declaration's, verbatim, so today's
 *    `grep "MCP server log"` keeps working for the whole of 1b's migration. Nothing is taken away;
 *    a stable column is added.
 * 2. **The emitted line has no duplicate key.** Attribute names are declared and are checked
 *    against the line's own columns, and the message is a single constant — so a keyed line always
 *    parses cleanly as `key=value` pairs. ⚠️ The raw `Effect.log*` path does not have this property:
 *    `Effect.logInfo("a", cause)` emits `message=` TWICE, because the formatter maps every non-plain
 *    message part onto that one name. The test drives both and shows the difference.
 *
 * ── the level is not a parameter ────────────────────────────────────────────────────────────────
 *
 * It comes from the declaration (`EVENTS[key].level`), which is fix 1d: a debug print cannot ship at
 * `error` without a key that says `error`, and a foreign process's severity becomes an attribute
 * rather than a promotion into our severity space. An event with two endings is two keys with two
 * levels, which is what the optional fourth `outcome` segment is for.
 */
/**
 * The four wire levels onto Effect's four log entry points. A lookup rather than a `switch` so the
 * mapping is total by construction — there is no arm to forget and no fallback that could quietly
 * mis-level an event.
 */
const LOG_AT = {
  debug: Effect.logDebug,
  info: Effect.logInfo,
  warn: Effect.logWarning,
  error: Effect.logError,
} as const

export const event = <K extends EventKey>(key: K, attributes: Attributes<K>): Effect.Effect<void> => {
  const declaration = EVENTS[key]
  // The `{ event }` part is a plain object, so the formatter flattens it to a bare `event=<key>`
  // column; `message` is a string, so it becomes `message="…"`; `attributes` is plain and flattens
  // to one `name=value` per field. Three parts, one call, no formatter change.
  return LOG_AT[declaration.level]({ event: key }, declaration.message, attributes)
}

export * as Log from "./log"
