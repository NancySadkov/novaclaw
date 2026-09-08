/**
 * **A real boot of `Observability.layer`, reporting what landed in the log and how many writers
 * were open while it landed.**
 *
 * `` Phase 2 → Phase 3: the writer's 8 MB / 256 MB / 30 d defaults ship with their
 * own author's confession that they are *"a guess dressed in a measurement"*, and the thing that
 * fixes it is one line per boot saying how big this instance's log is and how fast it grows.
 *
 * ⚠️ **A subprocess for the same reason `fixture/boot-degrade.ts` is one:** `Global.dirs()` caches
 * its answer in a module-level variable and the logger layer caches its open handle, both once per
 * process. An in-process test cannot arrange a home, and it cannot arrange a log file with a
 * FIRST LINE from three hours ago — which is the whole input to the rate measurement.
 *
 * ⚠️ **The writer count is taken while the scope is still OPEN**, which is the only moment it means
 * anything: after the scope closes every writer has been released and the answer is 0 whether the
 * layer built one writer or five.
 *
 * Usage: `bun run log-usage-boot.ts` with `NOVACLAW_HOME` set, and `NOVACLAW_LOG_DOUBLE=1` to run
 * the NEGATIVE CONTROL composition instead of the production one. Prints one JSON line on stdout.
 */
import fsSync from "node:fs"
import path from "node:path"
import { Effect, Layer, Logger, References } from "effect"
import { Global } from "@novaclaw/core/global"
import { Observability } from "@novaclaw/core/observability"
import { LogFile } from "@novaclaw/core/observability/log-file"
import { Logging } from "@novaclaw/core/observability/logging"

const paths = Global.make()
const logFile = path.join(paths.log, "novaclaw.log")

/**
 * The control composition. It is the SAME shape as `observability.ts`'s — a logger layer, plus the
 * usage report provided that layer — with exactly one thing changed: the report is given its own,
 * structurally identical logger layer instead of the one the app gets. If the production number is
 * 1 because layers memoize, this number must be 2; if it is 2 as well, the production assertion was
 * measuring nothing.
 */
const doubled = Layer.unwrap(
  Effect.sync(() => {
    const forApp = Logger.layer([...Logging.loggers()], { mergeWithExisting: false }).pipe(
      Layer.merge(Layer.succeed(References.MinimumLogLevel, Logging.minimumLogLevel())),
    )
    const forReport = Logger.layer([...Logging.loggers()], { mergeWithExisting: false }).pipe(
      Layer.merge(Layer.succeed(References.MinimumLogLevel, Logging.minimumLogLevel())),
    )
    return Layer.merge(forApp, Layer.effectDiscard(Logging.reportUsage()).pipe(Layer.provide(forReport)))
  }),
)

const layer = process.env["NOVACLAW_LOG_DOUBLE"] === "1" ? doubled : Observability.layer

// The count has to be read from INSIDE the scope, so the effect provided with the layer is the probe
// itself rather than `Effect.void`.
const writers = await Effect.runPromise(
  Effect.sync(() => LogFile.openWriters()).pipe(Effect.provide(layer), Effect.scoped),
)

process.stdout.write(
  JSON.stringify({
    log: paths.log,
    writers,
    // Read AFTER the scope closed, so the release has flushed.
    content: fsSync.existsSync(logFile) ? fsSync.readFileSync(logFile, "utf8") : null,
  }) + "\n",
)
