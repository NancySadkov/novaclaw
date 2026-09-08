export * as Shutdown from "./shutdown"

import { Cause, Duration, Effect, Exit } from "effect"

/**
 * Settle everything that can be settled, inside ONE deadline, and say what was forced.
 *
 * The requirement: *"settle sessions, children, terminals, downloads and model workers within a
 * bounded deadline, then NAME anything forced."* Today each subsystem has a finalizer, there is no
 * deadline over them, and nothing is named — so closing the app mid-work is the one routine action
 * that can lose work, and it does so silently.
 *
 * Three properties, each of which is a way shutdown goes wrong in practice:
 *
 * 1. **A hung task cannot hold the process open.** The deadline is over the whole set, so the caller
 *    knows the worst case before it starts. Without this a single stuck terminal makes "quit" hang.
 * 2. **A failing task cannot cancel its siblings.** Shutdown is the moment where "abort the rest on
 *    the first error" is most expensive: the subsystems after it are exactly the ones holding
 *    unflushed state. Every task runs; failures are recorded, not propagated.
 * 3. **Anything not settled is NAMED.** "Shutting down…" that silently gave up is a false report,
 *    and the name is what turns "I lost my work" into a bug someone can find.
 *
 * ⚠️ This does not itself kill anything. It reports; forcing is the caller's decision, because only
 * the caller knows whether a forced subsystem means "log it" or "do not exit yet".
 */

export type Outcome = "settled" | "timed-out" | "failed"

export interface Task {
  /** Appears verbatim in the report, so it must name a thing a person recognises. */
  readonly name: string
  readonly settle: Effect.Effect<unknown, unknown>
}

export interface Result {
  readonly name: string
  readonly outcome: Outcome
  readonly ms: number
  /** Present on `failed`; the fault, already rendered. */
  readonly detail?: string
}

export interface Report {
  readonly results: readonly Result[]
  /** Everything that did NOT settle, by name — timed out or failed. The line worth logging. */
  readonly forced: readonly string[]
  readonly settledAll: boolean
  readonly ms: number
}

/**
 * Run every task concurrently under one deadline.
 *
 * Concurrent because the deadline is a promise to the user about total wait: run sequentially and
 * five subsystems with a 2 s budget each can take 10 s, which is a different promise than the one
 * the caller made.
 */
export const settleAll = (
  tasks: readonly Task[],
  deadline: Duration.Input,
  now: () => number = Date.now,
): Effect.Effect<Report> =>
  Effect.gen(function* () {
    const started = now()
    if (tasks.length === 0) return { results: [], forced: [], settledAll: true, ms: 0 }

    const results = yield* Effect.forEach(
      tasks,
      (task) =>
        Effect.gen(function* () {
          const taskStarted = now()
          // `exit` rather than a failure channel: a task that dies must not take the report with it.
          const exit = yield* task.settle.pipe(
            Effect.timeoutOrElse({
              duration: deadline,
              orElse: () => Effect.succeed(TIMED_OUT),
            }),
            Effect.exit,
          )
          const ms = now() - taskStarted
          if (Exit.isFailure(exit))
            return { name: task.name, outcome: "failed" as const, ms, detail: Cause.pretty(exit.cause).slice(0, 500) }
          return exit.value === TIMED_OUT
            ? { name: task.name, outcome: "timed-out" as const, ms }
            : { name: task.name, outcome: "settled" as const, ms }
        }),
      { concurrency: "unbounded" },
    )

    const forced = results.filter((result) => result.outcome !== "settled").map((result) => result.name)
    return { results, forced, settledAll: forced.length === 0, ms: now() - started }
  })

/** A private sentinel, so a task legitimately returning `undefined` is not read as a timeout. */
const TIMED_OUT = Symbol.for("@novaclaw/Shutdown/timed-out")

/**
 * One line for the log or the console. Says what happened in the order a person cares about: was
 * anything lost, and if so what.
 */
export const describe = (report: Report): string =>
  report.settledAll
    ? `Everything settled in ${report.ms} ms.`
    : `Forced after ${report.ms} ms: ${report.forced.join(", ")}.` +
      ` Settled: ${report.results.filter((r) => r.outcome === "settled").length}/${report.results.length}.`
