export * as BashJobs from "./bash-jobs"

// 1H — long-running bash: hand control back, don't kill. Every bash command runs
// as a JOB here; the tool waits up to its soft deadline and, when the command is
// still running, YIELDS to the model (job id + output-so-far + controls) instead
// of killing the process. Owner-bound: only the starting session can observe or
// stop its jobs.
//
// Durability (small-tails T6): the in-memory map stays the hot path, but every job
// write-throughs to the `bash_job` table (insert on start, throttled output flush
// while running, final update on finish). A process that dies mid-job leaves a
// `running` row; the next PROCESS boot marks those `interrupted` (recovery is a
// global once-per-process node — a location boot must never touch another live
// location's rows) and prunes rows older than seven days. status/wait/stop fall
// back to the table when the memory entry is gone (finished long ago, or a
// pre-restart job) — no re-attach to dead PIDs, just honest status + output.

import { and, eq, lt } from "drizzle-orm"
import { Context, Data, Deferred, Duration, Effect, Fiber, Layer, Stream } from "effect"
import type { ChildProcess } from "effect/unstable/process"
import { ascending } from "@novaclaw/schema/identifier"
import { Database } from "../database/database"
import { makeGlobalNode, makeLocationNode } from "../effect/app-node"
import { AppProcess } from "../process"
import { BashJobTable } from "./bash-jobs.sql"

export const MAX_JOBS_PER_SESSION = 5
export const FINISHED_JOB_TTL_MS = 10 * 60 * 1_000
export const ROW_TTL_MS = 7 * 24 * 60 * 60 * 1_000
const FLUSH_INTERVAL_MS = 2_000

export interface Snapshot {
  readonly id: string
  readonly command: string
  readonly running: boolean
  readonly elapsedMs: number
  /** Combined output captured so far (bounded by the byte cap). */
  readonly output: string
  readonly truncated: boolean
  readonly exit?: number
  /** True when a previous process died while this job ran (recovery marked it). */
  readonly interrupted?: boolean
}

export class JobNotFoundError extends Data.TaggedError("BashJobs.NotFoundError")<{ id: string }> {}
export class JobLimitError extends Data.TaggedError("BashJobs.LimitError")<{ limit: number }> {}

interface JobState {
  readonly id: string
  readonly owner: string
  readonly command: string
  readonly startedAt: number
  readonly chunks: Buffer[]
  bytes: number
  truncated: boolean
  exit?: number
  doneAt?: number
  readonly done: Deferred.Deferred<void>
  fiber?: Fiber.Fiber<unknown, unknown>
}

export interface Interface {
  readonly start: (input: {
    readonly owner: string
    readonly command: ChildProcess.Command
    readonly commandText: string
    readonly maxOutputBytes: number
  }) => Effect.Effect<{ id: string }, JobLimitError>
  /** Block up to timeoutMs for completion, then report (running or done). */
  readonly wait: (id: string, owner: string, timeoutMs: number) => Effect.Effect<Snapshot, JobNotFoundError>
  readonly status: (id: string, owner: string) => Effect.Effect<Snapshot, JobNotFoundError>
  readonly stop: (id: string, owner: string) => Effect.Effect<Snapshot, JobNotFoundError>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/BashJobs") {}

const snapshot = (job: JobState): Snapshot => ({
  id: job.id,
  command: job.command,
  running: job.doneAt === undefined,
  elapsedMs: (job.doneAt ?? Date.now()) - job.startedAt,
  output: Buffer.concat(job.chunks).toString("utf8"),
  truncated: job.truncated,
  ...(job.exit !== undefined ? { exit: job.exit } : {}),
})

const rowSnapshot = (row: typeof BashJobTable.$inferSelect): Snapshot => ({
  id: row.id,
  command: row.command,
  // A `running` row reached through the fallback means its process died before this one's
  // recovery ran (impossible within one process) — report it not-running either way.
  running: false,
  elapsedMs: (row.time_done ?? row.time_started) - row.time_started,
  output: row.output,
  truncated: row.truncated,
  ...(row.exit !== null ? { exit: row.exit } : {}),
  ...(row.status === "interrupted" ? { interrupted: true } : {}),
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const appProcess = yield* AppProcess.Service
    const { db } = yield* Database.Service
    const scope = yield* Effect.scope
    const jobs = new Map<string, JobState>()

    const purge = () => {
      const now = Date.now()
      for (const [id, job] of jobs)
        if (job.doneAt !== undefined && now - job.doneAt > FINISHED_JOB_TTL_MS) jobs.delete(id)
    }

    /** The durable fallback: rows survive the map's TTL purge and process restarts. */
    const findRow = (id: string, owner: string) =>
      db
        .select()
        .from(BashJobTable)
        .where(and(eq(BashJobTable.id, id), eq(BashJobTable.owner, owner)))
        .get()
        .pipe(
          Effect.orDie,
          // Owner mismatch reads as not-found — a session can never probe another
          // session's jobs, not even for existence.
          Effect.flatMap((row) => (row ? Effect.succeed(row) : Effect.fail(new JobNotFoundError({ id })))),
        )

    const flushRow = (job: JobState) =>
      db
        .update(BashJobTable)
        .set({
          output: Buffer.concat(job.chunks).toString("utf8"),
          truncated: job.truncated,
          ...(job.doneAt !== undefined
            ? { status: "done" as const, time_done: job.doneAt, ...(job.exit !== undefined ? { exit: job.exit } : {}) }
            : {}),
        })
        .where(eq(BashJobTable.id, job.id))
        .run()
        // Durability is best-effort beside a live job — a flush failure must never kill it.
        .pipe(Effect.ignore)

    const start: Interface["start"] = Effect.fn("BashJobs.start")(function* (input) {
      purge()
      const active = [...jobs.values()].filter((job) => job.owner === input.owner && job.doneAt === undefined)
      if (active.length >= MAX_JOBS_PER_SESSION) return yield* new JobLimitError({ limit: MAX_JOBS_PER_SESSION })
      const done = yield* Deferred.make<void>()
      const state: JobState = {
        id: "job_" + ascending(),
        owner: input.owner,
        command: input.commandText,
        startedAt: Date.now(),
        chunks: [],
        bytes: 0,
        truncated: false,
        done,
      }
      jobs.set(state.id, state)
      yield* db
        .insert(BashJobTable)
        .values({
          id: state.id,
          owner: state.owner,
          command: state.command,
          status: "running",
          time_started: state.startedAt,
        })
        .run()
        .pipe(Effect.ignore)
      const runJob = Effect.gen(function* () {
        const handle = yield* appProcess.spawn(input.command)
        const consume = Stream.runForEach(handle.all, (chunk: Uint8Array) =>
          Effect.sync(() => {
            const remaining = input.maxOutputBytes - state.bytes
            if (remaining > 0)
              state.chunks.push(Buffer.from(remaining >= chunk.length ? chunk : chunk.slice(0, remaining)))
            state.bytes += chunk.length
            state.truncated = state.truncated || state.bytes > input.maxOutputBytes
          }),
        )
        const [, exit] = yield* Effect.all([consume, handle.exitCode], { concurrency: "unbounded" })
        state.exit = Number(exit)
      }).pipe(
        Effect.scoped,
        // A spawn/stream failure just finishes the job (exit stays undefined);
        // the model sees "stopped without an exit code" in the snapshot text.
        Effect.catchCause(() => Effect.void),
        Effect.ensuring(
          // Stamp, flush the FINAL row, then settle — a waiter that wakes on `done` must be able
          // to read the durable row immediately (the settle is guarded so it always happens).
          Effect.sync(() => {
            state.doneAt = Date.now()
          }).pipe(
            // suspend: the drizzle update must be BUILT after doneAt is stamped, not at pipe construction.
            Effect.andThen(Effect.suspend(() => flushRow(state))),
            Effect.ensuring(Effect.sync(() => Deferred.doneUnsafe(state.done, Effect.void))),
          ),
        ),
      )
      // Forked into the SERVICE scope: the job outlives the tool call and the
      // turn. Interrupting the fiber unwinds the spawn scope → the child is
      // killed (forceKillAfter applies) — that IS the `stop` implementation.
      state.fiber = yield* runJob.pipe(Effect.forkIn(scope, { startImmediately: true }))
      // Throttled output flush: while the job runs, land output-so-far in the row every
      // couple of seconds, so a hard process death still leaves readable output behind.
      yield* Effect.gen(function* () {
        let flushed = 0
        while (state.doneAt === undefined) {
          yield* Effect.race(Deferred.await(state.done), Effect.sleep(Duration.millis(FLUSH_INTERVAL_MS)))
          if (state.doneAt !== undefined) return
          if (state.bytes !== flushed) {
            flushed = state.bytes
            yield* flushRow(state)
          }
        }
      }).pipe(Effect.forkIn(scope, { startImmediately: true }))
      return { id: state.id }
    })

    const wait: Interface["wait"] = Effect.fn("BashJobs.wait")(function* (id, owner, timeoutMs) {
      const job = jobs.get(id)
      if (!job || job.owner !== owner) return rowSnapshot(yield* findRow(id, owner))
      yield* Effect.race(Deferred.await(job.done), Effect.sleep(Duration.millis(Math.max(0, timeoutMs))))
      return snapshot(job)
    })

    const status: Interface["status"] = Effect.fn("BashJobs.status")(function* (id, owner) {
      purge()
      const job = jobs.get(id)
      if (!job || job.owner !== owner) return rowSnapshot(yield* findRow(id, owner))
      return snapshot(job)
    })

    const stop: Interface["stop"] = Effect.fn("BashJobs.stop")(function* (id, owner) {
      const job = jobs.get(id)
      // Not in memory → nothing is running to stop; report the durable status.
      if (!job || job.owner !== owner) return rowSnapshot(yield* findRow(id, owner))
      if (job.doneAt === undefined && job.fiber) yield* Fiber.interrupt(job.fiber)
      // The ensuring above stamps doneAt + settles the deferred.
      yield* Deferred.await(job.done)
      return snapshot(job)
    })

    return Service.of({ start, wait, status, stop })
  }),
)

// Once per PROCESS: rows still `running` belong to a dead process — mark them interrupted
// (honest status; no re-attach), and prune rows past the retention window.
export const recover = (db: Database.Interface["db"]) =>
  Effect.gen(function* () {
    yield* db
      .update(BashJobTable)
      .set({ status: "interrupted" })
      .where(eq(BashJobTable.status, "running"))
      .run()
      .pipe(Effect.orDie)
    yield* db
      .delete(BashJobTable)
      .where(lt(BashJobTable.time_started, Date.now() - ROW_TTL_MS))
      .run()
      .pipe(Effect.orDie)
  })

export const recoveryLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* recover(db)
  }),
)

export const recoveryNode = makeGlobalNode({ name: "bash-jobs-recovery", layer: recoveryLayer, deps: [Database.node] })

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [AppProcess.node, Database.node, recoveryNode],
})
