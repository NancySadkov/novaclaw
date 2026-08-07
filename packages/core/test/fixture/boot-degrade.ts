/**
 * **A real boot of the two subsystems that used to kill it, run in its own process.**
 *
 * `Global.dirs()` and `Observability.layer` both resolve ONCE per process and cache — `Global`'s in a
 * module-level `cached`, the logger's in the layer it builds. So a test cannot poison the home in
 * process: whichever test ran first has already fixed the answer for every other. This fixture is
 * therefore the honest instrument. The parent sets `NOVACLAW_HOME` and arranges the filesystem; this
 * script imports the real modules, in the real order, and prints what happened as JSON.
 *
 * ⚠️ **Every guarded arm has an UNGUARDED twin in the same run.** A test that only asserts "the boot
 * survived" cannot distinguish a fix from a fixture that stopped biting — the poison could be
 * neutralised by a permissions change or a typo in the parent, and the test would stay green while
 * asserting nothing. So the fixture also performs the pre-fix operation against the SAME paths and
 * reports whether it failed. The parent asserts both halves.
 *
 * Usage: `bun run boot-degrade.ts` with `NOVACLAW_HOME` already set. Prints one JSON line on stdout;
 * every warning goes to stderr, which the parent also reads.
 */
import fsSync from "node:fs"
import path from "node:path"
import { Effect, Exit, Logger } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { Global } from "@novaclaw/core/global"
import { Observability } from "@novaclaw/core/observability"
import { Logging } from "@novaclaw/core/observability/logging"

const report: Record<string, unknown> = {}

// ── 1. Global: the seven directories ────────────────────────────────────────────────────────────
// `Global.make()` is exactly what `Global.layer` runs inside `Effect.sync`, so reaching the next
// line at all is the claim under test.
const paths = Global.make()
report["status"] = Global.directoryStatus()
report["data"] = paths.data
report["log"] = paths.log

// The unguarded twin: the loop this module used to run, over the directories the boot actually
// wanted. It is recomputed from the ORIGINAL home rather than from wherever the instance ended up,
// so a relocation cannot mask it.
const original = process.env["NOVACLAW_HOME"]
report["unguarded"] = (original === undefined ? [] : [path.join(original, "data"), path.join(original, "data", "log")])
  .map((directory) => {
    try {
      fsSync.mkdirSync(directory, { recursive: true })
      return { directory, threw: false }
    } catch (cause) {
      return { directory, threw: true, message: cause instanceof Error ? cause.message : String(cause) }
    }
  })

// ── 2. Observability: the file logger ───────────────────────────────────────────────────────────
const logFile = path.join(paths.log, "novaclaw.log")

// The unguarded twin: `Logger.toFile` on its own, which is what `Layer.orDie` used to sit over.
//
// ⚠️ It is spelled out here rather than reached through `Logging.fileLogger`, and that is the whole
// point of a control: `fileLogger` IS the fix now (Phase 2 replaced `Logger.toFile` with a writer
// that has no error channel), so calling it here would make the "unguarded" arm the guarded one and
// the test would pass while asserting nothing. The control has to be the operation being replaced.
const raw = await Effect.runPromise(
  Effect.exit(Logger.toFile(Logging.formatter(), logFile, { flag: "a" })).pipe(
    Effect.provide(NodeFileSystem.layer),
    Effect.scoped,
  ),
)
report["unguardedLogger"] = Exit.isFailure(raw) ? "failed" : "opened"

// The guarded one. It must produce a logger either way, and when the file leg is dead it must be the
// SAME stderr object the print path uses — otherwise `NOVACLAW_PRINT_LOGS=1` would double every line.
const guarded = await Effect.runPromiseExit(
  Logging.fileLoggerOrStderr(logFile).pipe(
    Effect.map((logger) => (logger === Logging.stderrLogger ? "stderr" : "file")),
    Effect.provide(NodeFileSystem.layer),
    Effect.scoped,
  ),
)
report["guardedLogger"] = Exit.isSuccess(guarded) ? guarded.value : "DIED"

// ── 3. The whole composition, as the server provides it ─────────────────────────────────────────
// `Observability.layer` is what `server.ts` pipes above the graph. Building it AND emitting through
// it is the end-to-end claim: the boot reaches a working logger with the log directory destroyed.
const booted = await Effect.runPromiseExit(
  Effect.logInfo("boot-degrade probe reached the logger").pipe(Effect.provide(Observability.layer), Effect.scoped),
)
report["booted"] = Exit.isSuccess(booted)

// …and what actually landed IN THE FILE. `Effect.scoped` above released the writer, which flushes.
// ⚠️ Reporting only `booted` would assert that the layer BUILT — the healthy case would stay green
// with a sink that writes nowhere, which is exactly the failure Phase 2's writer could introduce and
// exactly the shape a "green suite proves nothing about the packaged app" pitfall takes. Read the
// bytes.
report["logFileContent"] = fsSync.existsSync(logFile) ? fsSync.readFileSync(logFile, "utf8") : null

process.stdout.write(JSON.stringify(report) + "\n")
