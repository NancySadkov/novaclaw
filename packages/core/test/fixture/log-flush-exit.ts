/**
 * **The short-lived-CLI flush defect, reproduced and fixed, in one process.**
 *
 * 🔴 The filed defect (``): `Logger.toFile` batches into a `setTimeout`, so a process
 * that exits before the batch window writes NOTHING — `novaclaw.log` was empty for the CLI entry
 * point, for every event, while a long-lived `serve` flushed fine. A log nobody can read after a
 * crash is the same defect as a crash-telemetry packet that is issued and then lost.
 *
 * ⚠️ This has to be a real child process. `bun test` does not run `process.on("exit")` handlers
 * (AGENTS.md pitfall #8), so the fix is invisible to an in-process assertion — and so is the defect.
 *
 * ⚠️ **The control runs in the same process, against the same clock, in the same instant.** Both
 * arms log one line and then the process exits inside the scope, which is exactly what a CLI does.
 * Asserting only "the new writer's file has the line" would stay green if the batch window simply
 * got shorter; the control is what proves the poison still bites.
 *
 * Usage: `bun log-flush-exit.ts <writer.log> <control.log>`. Prints one JSON line BEFORE exiting.
 */
import fsSync from "node:fs"
import { Effect, Logger } from "effect"
import { NodeFileSystem } from "@effect/platform-node"
import { LogFile } from "@novaclaw/core/observability/log-file"
import { Logging } from "@novaclaw/core/observability/logging"

const writerFile = process.argv[2]!
const controlFile = process.argv[3]!

const sizeOf = (file: string) => {
  try {
    return fsSync.statSync(file).size
  } catch {
    return -1
  }
}

// ── the arm under test: the production writer + the production sink ─────────────────────────────
const writer = LogFile.open({ file: writerFile })
await Effect.runPromise(
  Effect.logInfo("flush-on-exit probe").pipe(Effect.provide(Logger.layer([Logging.sink(writer, "exitrun")]))),
)

// ── the control: `Logger.toFile`, the thing this replaced, exited out of the same way ───────────
await Effect.gen(function* () {
  const logger = yield* Logger.toFile(Logging.formatter("exitrun"), controlFile, { flag: "a" })
  yield* Effect.logInfo("flush-on-exit control").pipe(Effect.provide(Logger.layer([logger])))

  // Both files are still empty here: the writer has buffered, `Logger.toFile` has batched. That the
  // sizes are reported BEFORE the exit is what makes the parent's assertion about the exit hook
  // rather than about eager writing.
  process.stdout.write(
    JSON.stringify({ writerBeforeExit: sizeOf(writerFile), controlBeforeExit: sizeOf(controlFile) }) + "\n",
  )

  // Exiting INSIDE the scope — no finalizer runs. This is the CLI, verbatim.
  process.exit(0)
}).pipe(Effect.scoped, Effect.provide(NodeFileSystem.layer), Effect.runPromise)
