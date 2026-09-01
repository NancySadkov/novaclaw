import { Cause, Effect } from "effect"
import { ATTRIBUTE_CLASSES, type Attributes, encodeList, type EventKey, EVENTS } from "./log-events"

/**
 * **The keyed log call — a thin wrapper over `Effect.log*`, and nothing else.**
 *
 * There is exactly one line of behaviour in this module, and the
 * important thing about it is what it does NOT do: it opens no file, holds no state, starts no
 * daemon and adds no sink. A keyed record goes through the same `Effect.log*` entry point, the same
 * `Logger` layer, core's same logfmt formatter (`observability/logging.ts`) and into the same
 * `novaclaw.log` as the 172 un-keyed sites do today. 🔴 A second writer beside
 * `novaclaw.log` is the defect class this project keeps re-finding; this is a column, not a channel.
 *
 * ── what the line looks like ────────────────────────────────────────────────────────────────────
 *
 *   timestamp=… level=INFO run=d66de246 event=filesystem.watcher.start message="watcher backend" …
 *
 * `event=` rides in as a structured message part, so it lands immediately after `run=` and before
 * `message=`, with **no change to the formatter at all**. ⚠️ That is one field later than
 * the "immediately after `level=`" the design sketch asked for, and the deviation is deliberate: putting it
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

/**
 * **THE one normalization of a caught error into a `fault` attribute** — the first of the three
 * fault-normalization seams.
 *
 * The seam it closes, measured at app HEAD `34e45a066` by parsing every `Log.event` call: **100
 * assignments to a `fault`-class attribute, in 21 distinct expression shapes** — `Cause.pretty(c)`
 * ×39, `String(e)` ×18, `errorFormat(e)` ×9, `e instanceof Error ? e.message : String(e)` ×7, and a
 * long tail of `.message`, `.stderr` and bare strings. Every one of them is somebody deciding, at a
 * call site, what an error looks like in the log. That is the *copy-pasted normalization will
 * drift* the item names, and it had already drifted into three incompatible answers for the same
 * question: a stack, a message, or `[object Object]`.
 *
 * ⚠️ **The three shapes are not equivalent, which is why "they all produce a string" is not a
 * defence.** `String(cause)` on an Effect `Cause` yields a wrapper's `toString`, losing the failure;
 * `e.message` throws away the stack that makes a fault repairable; `JSON.stringify` on an `Error`
 * yields `{}` because its own properties are non-enumerable. One function, chosen once.
 *
 * ⚠️ **`errorFormat` in `packages/novaclaw/src/util/error.ts` is now an ALIAS of this**, not a
 * second implementation — the CLI's stderr renderer and the log's `fault` column had independently
 * grown the same object/`{}`/`toString` ladder, and two copies of one description is the defect
 * class this batch keeps finding. Aliasing means they cannot disagree.
 */
export const fault = (error: unknown): string => {
  // An Effect `Cause` first: it is the shape 39 of the 100 sites pass, and it is the one where the
  // generic branches below are actively wrong (a `Cause` is an object, and stringifying it hides the
  // failure inside a wrapper).
  if (Cause.isCause(error)) return Cause.pretty(error)

  if (error instanceof Error) return error.stack ?? `${error.name}: ${error.message}`

  if (typeof error === "object" && error !== null) {
    try {
      const json = JSON.stringify(error, null, 2)
      // Plain objects whose own properties are all non-enumerable (or empty) serialize to "{}",
      // which is a useless bare `{}` in a log column. Fall back to a custom toString first, then to
      // ctor name + own property names.
      if (json === "{}") {
        const rendered = String(error)
        if (rendered && rendered !== "[object Object]") return rendered
        const ctor = error.constructor?.name
        const prefix = ctor && ctor !== "Object" ? ctor : "Error"
        const names = Object.getOwnPropertyNames(error)
        return names.length === 0 ? `${prefix} (no message)` : `${prefix} { ${names.join(", ")} }`
      }
      return json
    } catch {
      return "Unexpected error (unserializable)"
    }
  }

  return String(error)
}

/**
 * The wire form of one attribute. Every class but `list` passes through untouched — the wrapper
 * hands its attributes to the same formatter the un-keyed path uses and does not re-encode them.
 *
 * `list` is the exception and it is 1h's second seam: the call site passes a `readonly string[]`,
 * and {@link encodeList} — declared beside the class, in `log-events.ts` — owns the single bounded
 * encoding. Before this, twenty call sites each wrote their own `JSON.stringify(…)`, which preserved
 * the bytes, discarded the type, and left the truncation policy nowhere.
 */
const encode = (key: EventKey, name: string, value: unknown): unknown => {
  const cls = (EVENTS[key].attributes as Readonly<Record<string, keyof typeof ATTRIBUTE_CLASSES>>)[name]
  return cls === "list" ? encodeList(value as ReadonlyArray<string>) : value
}

export const event = <K extends EventKey>(key: K, attributes: Attributes<K>): Effect.Effect<void> => {
  const declaration = EVENTS[key]
  const encoded: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(attributes as Readonly<Record<string, unknown>>))
    encoded[name] = encode(key, name, value)
  // The `{ event }` part is a plain object, so the formatter flattens it to a bare `event=<key>`
  // column; `message` is a string, so it becomes `message="…"`; the attributes are plain and flatten
  // to one `name=value` per field. Three parts, one call, no formatter change.
  return LOG_AT[declaration.level]({ event: key }, declaration.message, encoded)
}

export * as Log from "./log"
