import { Effect, Formatter, Logger, type LogLevel } from "effect"
import path from "path"
import { Global } from "../global"
import { LogFile } from "./log-file"
import { runID } from "./shared"

/**
 * The one logfmt renderer. Every sink below is this function plus a destination, which is why it is
 * the only honest place to assert what a log LINE looks like.
 *
 * ⚠️ Exported for that reason and no other: `packages/core/test/log-events.test.ts` drives real
 * `Effect.log*` records through it to prove that a keyed event (`@novaclaw/schema/log`) lands in
 * THIS line rather than in a channel of its own, and that an un-keyed record is byte-identical to
 * what it was before the key set existed. A test that re-implemented the format would assert
 * against a copy and pass while production drifted.
 */
export function formatter(id: string = runID) {
  return Logger.map(Logger.formatStructured, (output) => {
    const messages = Array.isArray(output.message) ? output.message : [output.message]
    return [
      ["timestamp", output.timestamp],
      ["level", output.level],
      ["run", id],
      ...messages.flatMap((value) => (plain(value) ? flatten(value) : [["message", value] as const])),
      ...(output.cause === undefined ? [] : [["cause", output.cause] as const]),
      ...flatten(output.spans),
      ...flatten(output.annotations),
    ]
      .map(([key, value]) => `${key}=${format(value)}`)
      .join(" ")
  })
}

function flatten(
  input: Record<string, unknown>,
  prefix = "",
  seen = new WeakSet<object>(),
): Array<readonly [string, unknown]> {
  if (seen.has(input)) return [[prefix, "[Circular]"]]
  seen.add(input)
  const entries = Object.entries(input)
  if (entries.length === 0 && prefix) return [[prefix, input]]
  return entries.flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return plain(value) ? flatten(value, path, seen) : [[path, value] as const]
  })
}

function plain(input: unknown): input is Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false
  const prototype = Object.getPrototypeOf(input)
  return prototype === Object.prototype || prototype === null
}

function format(input: unknown) {
  const value = typeof input === "string" ? input : Formatter.format(input)
  return /^[^\s="\\]+$/.test(value) ? value : JSON.stringify(value)
}

/** The active segment. Inside the instance home (principle 11) because `Global.Path.log` is. */
export const defaultLogFile = () => path.join(Global.Path.log, "novaclaw.log")

/**
 * The stderr sink. Exported because it is also the FALLBACK below, and the fallback has to be this
 * exact object: `Logger.layer` collects its loggers into a `Set`, so returning the same instance is
 * what stops `NOVACLAW_PRINT_LOGS=1` printing every line twice when the file leg has degraded.
 */
export const stderrLogger = Logger.make<unknown, void>((options) => {
  process.stderr.write(formatter().log(options) + "\n")
})

/** Whether this run already prints every line to stderr, so a fallback must not double it. */
const mirrored = () => process.env.NOVACLAW_PRINT_LOGS === "1"

/**
 * `error` and above skip the batch window. The defaults table calls this *"durability where it is
 * worth it, nowhere else"*: the lines you need after a crash are the ones a batch window loses.
 */
const IMMEDIATE = new Set<LogLevel.LogLevel>(["Error", "Fatal"])

/**
 * **The scoped writer** — `todo/logging.md` Phase 2. Acquiring it cannot fail (see
 * {@link LogFile}), and releasing it flushes: the long-lived `serve` path loses nothing on a clean
 * shutdown, and the short-lived CLI is covered by the writer's own `process.on("exit")` hook.
 */
export function writer(file = defaultLogFile(), options: Partial<LogFile.Options> = {}) {
  return Effect.acquireRelease(
    Effect.sync(() =>
      LogFile.open({
        file,
        mirrored: mirrored(),
        // ⚠️ `console.error`, not `Log.event`: this IS the log sink, so a keyed event about its own
        // death would either recurse or vanish into the thing that just failed. Same shape
        // `global.ts` uses for an unresolvable home.
        onDegrade: (reason, target) =>
          console.error(
            `[novaclaw] WARNING: could not write the log file ${target} (${reason}), so this run ` +
              `logs to stderr instead. Nothing else is disabled. Pass --home <dir> (or set ` +
              `NOVACLAW_HOME) to put the instance somewhere writable.`,
          ),
        ...options,
      }),
    ),
    (open) => Effect.sync(() => open.close()),
  )
}

/**
 * The file sink over a writer.
 *
 * ⚠️ **It checks availability per LINE, not once at boot.** A disk fills up mid-run, and the
 * previous design decided the file-vs-stderr question at layer-build time and never again — so a
 * writer that died an hour in would have silently swallowed everything after.
 */
export function sink(open: LogFile.Writer, id: string = runID) {
  const format = formatter(id)
  return Logger.make<unknown, void>((options) => {
    const line = format.log(options) + "\n"
    if (!open.write(line, IMMEDIATE.has(options.logLevel)) && !mirrored()) process.stderr.write(line)
  })
}

/**
 * **The file leg, unfailable BY CONSTRUCTION — an unwritable log directory must not kill the boot.**
 *
 * The defect this replaced: `Logger.toFile` opens the file at layer-BUILD time and its error channel
 * is `PlatformError`, and `observability.ts` piped `Layer.orDie` over the layer carrying it. So
 * EACCES/EROFS/ENOSPC on `<data>/log` was a boot defect — in the one subsystem you most need when a
 * boot is failing, and against `todo/logging.md` phase 2's own rule that logging must never take the
 * instance down (`notes/reports/startup-classification-2026-08-07.md` §5, finding 2).
 *
 * ⭐ **The first fix absorbed that failure; this one deletes it.** `LogFile.open` has no error
 * channel at all, so there is no longer a `PlatformError` for a future `orDie` to re-arm — the
 * boot-killer is not guarded against, it is unexpressible.
 */
export function fileLoggerOrStderr(file = defaultLogFile(), id: string = runID) {
  return writer(file).pipe(Effect.map((open) => (open.available ? sink(open, id) : stderrLogger)))
}

/** The production file sink. Scoped: the release flushes and closes the segment. */
export function fileLogger(file = defaultLogFile(), id: string = runID) {
  return writer(file).pipe(Effect.map((open) => sink(open, id)))
}

export function minimumLogLevel() {
  const value = process.env.NOVACLAW_LOG_LEVEL?.toUpperCase()
  const levels = {
    DEBUG: "Debug",
    INFO: "Info",
    WARN: "Warn",
    ERROR: "Error",
  } as const satisfies Record<string, LogLevel.LogLevel>
  return value && value in levels ? levels[value as keyof typeof levels] : levels.INFO
}

export function loggers() {
  return process.env.NOVACLAW_PRINT_LOGS === "1" ? [fileLoggerOrStderr(), stderrLogger] : [fileLoggerOrStderr()]
}

export * as Logging from "./logging"
