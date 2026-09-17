import { describe, expect } from "bun:test"
import { Duration, Effect, Exit, Layer, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { AppProcess } from "@novaclaw/core/process"
import { BashJobs } from "@novaclaw/core/tool/bash-jobs"
import { BashJobTable } from "@novaclaw/core/tool/bash-jobs.sql"
import { testEffect } from "./lib/effect"

// T6 durable jobs: write-through on finish, the DB fallback for evicted/pre-restart jobs, and
// process-boot recovery (running rows → interrupted; ancient rows pruned).

const appProcess = Layer.succeed(
  AppProcess.Service,
  AppProcess.Service.of({
    spawn: () =>
      Effect.sync(() => ({
        all: Stream.fromIterable([Buffer.from("hello from the job\n")]),
        stdout: Stream.empty,
        stderr: Stream.empty,
        exitCode: Effect.succeed(0),
      })) as never,
    run: () => Effect.die("unused"),
  } as never),
)

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, BashJobs.node]), [[AppProcess.node, appProcess]]),
)

const hangingProcess = Layer.succeed(
  AppProcess.Service,
  AppProcess.Service.of({
    spawn: () =>
      Effect.succeed({
        all: Stream.never,
        stdout: Stream.empty,
        stderr: Stream.empty,
        exitCode: Effect.never,
      }) as never,
    run: () => Effect.die("unused"),
  } as never),
)
const itHanging = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, BashJobs.node]), [[AppProcess.node, hangingProcess]]),
)

const launchFailure = Layer.succeed(
  AppProcess.Service,
  AppProcess.Service.of({
    spawn: () => Effect.fail(new Error("ENOENT: renderer executable was not found")) as never,
    run: () => Effect.die("unused"),
  } as never),
)
const itLaunchFailure = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, BashJobs.node]), [[AppProcess.node, launchFailure]]),
)

const command = { _tag: "StandardCommand" } as unknown as ChildProcess.Command

// A second harness with the REAL process node: proves the throttled flush lands output in the
// row WHILE a live child runs (the piece a mocked instant stream can never exercise).
const itLive = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, BashJobs.node])))

describe("BashJobs durability (live process)", () => {
  itLive.live(
    "the throttled flush lands output in the row while the job still runs",
    () =>
      Effect.gen(function* () {
        const bashJobs = yield* BashJobs.Service
        const { db } = yield* Database.Service
        const live = ChildProcess.make("bun", ["-e", "console.log('flushing'); await Bun.sleep(8000)"], {
          stdin: "ignore",
        })
        const { id } = yield* bashJobs.start({
          owner: "ses_live",
          command: live,
          commandText: "bun -e flush-probe",
          maxOutputBytes: 4096,
        })
        let row: typeof BashJobTable.$inferSelect | undefined
        for (let i = 0; i < 20; i++) {
          yield* Effect.sleep(Duration.millis(400))
          row = (yield* db.select().from(BashJobTable).all().pipe(Effect.orDie)).find((r) => r.id === id)
          if (row && row.status === "running" && row.output.includes("flushing")) break
        }
        expect(row?.status).toBe("running")
        expect(row?.output).toContain("flushing")
        const stopped = yield* bashJobs.stop(id, "ses_live")
        expect(stopped.running).toBe(false)
      }),
    20_000,
  )
})

describe("BashJobs durability", () => {
  itHanging.effect("lists running jobs only for the requested session tree", () =>
    Effect.gen(function* () {
      const jobs = yield* BashJobs.Service
      const { db } = yield* Database.Service
      const root = yield* jobs.start({
        owner: "ses_root",
        command,
        commandText: "root command",
        maxOutputBytes: 4096,
      })
      const worker = yield* jobs.start({
        owner: "ses_worker",
        command,
        commandText: "worker command",
        maxOutputBytes: 4096,
      })
      const foreign = yield* jobs.start({
        owner: "ses_foreign",
        command,
        commandText: "foreign command",
        maxOutputBytes: 4096,
      })

      expect((yield* BashJobs.listRunning(db, ["ses_root", "ses_worker"])).map((job) => job.command).sort()).toEqual([
        "root command",
        "worker command",
      ])

      yield* jobs.stop(root.id, "ses_root")
      yield* jobs.stop(worker.id, "ses_worker")
      yield* jobs.stop(foreign.id, "ses_foreign")
    }),
  )

  itHanging.effect("a command stop resolves either the job id or the tool-call id, and records its reason", () =>
    Effect.gen(function* () {
      const jobs = yield* BashJobs.Service
      const { db } = yield* Database.Service
      const byJob = yield* jobs.start({
        owner: "ses_command_stop",
        callID: "call_by_job",
        command,
        commandText: "long command",
        maxOutputBytes: 4096,
      })
      const byCall = yield* jobs.start({
        owner: "ses_command_stop",
        callID: "call_by_call",
        command,
        commandText: "another command",
        maxOutputBytes: 4096,
      })
      // An owner can never stop another session's job: the lookup fails instead of stopping it.
      expect(Exit.isFailure(yield* Effect.exit(jobs.stop(byJob.id, "ses_other_owner", "wrong one")))).toBe(true)
      // The command list shows job ids; an in-flight transcript card only knows its call id. Both
      // name the same running job and must both reach it.
      const stoppedByJob = yield* jobs.stop(byJob.id, "ses_command_stop", "No longer needed")
      expect(stoppedByJob).toMatchObject({
        running: false,
        interrupted: true,
        interruptionReason: "No longer needed",
      })
      const stoppedByCall = yield* jobs.stop("call_by_call", "ses_command_stop", "Provider is down")
      expect(stoppedByCall).toMatchObject({
        running: false,
        interrupted: true,
        interruptionReason: "Provider is down",
      })
      const rows = yield* db.select().from(BashJobTable).all().pipe(Effect.orDie)
      expect(
        rows.filter((item) => item.owner === "ses_command_stop").every((item) => item.status === "interrupted"),
      ).toBe(true)
    }),
  )

  itLaunchFailure.effect("returns an OS process launch failure immediately with its cause", () =>
    Effect.gen(function* () {
      const bashJobs = yield* BashJobs.Service
      const before = Date.now()
      const error = yield* bashJobs
        .start({ owner: "ses_launch_failure", command, commandText: "missing-renderer", maxOutputBytes: 4096 })
        .pipe(Effect.flip)

      expect(error._tag).toBe("BashJobs.LaunchError")
      if (error._tag !== "BashJobs.LaunchError") throw new Error(`unexpected launch error: ${error._tag}`)
      expect(error.reason).toContain("ENOENT: renderer executable was not found")
      expect(Date.now() - before).toBeLessThan(500)
    }),
  )

  it.effect("write-through: a finished job lands as a done row with output and exit", () =>
    Effect.gen(function* () {
      const bashJobs = yield* BashJobs.Service
      const { db } = yield* Database.Service
      const { id } = yield* bashJobs.start({ owner: "ses_a", command, commandText: "echo hi", maxOutputBytes: 4096 })
      const done = yield* bashJobs.wait(id, "ses_a", 5_000)
      expect(done.running).toBe(false)
      expect(done.exit).toBe(0)

      const row = (yield* db.select().from(BashJobTable).all().pipe(Effect.orDie)).find((r) => r.id === id)!
      expect(row.status).toBe("done")
      expect(row.exit).toBe(0)
      expect(row.output).toContain("hello from the job")
      expect(row.command).toBe("echo hi")
    }),
  )

  it.effect("fallback: a row-only job reports its durable status; wrong owner reads not-found", () =>
    Effect.gen(function* () {
      const bashJobs = yield* BashJobs.Service
      const { db } = yield* Database.Service
      yield* db
        .insert(BashJobTable)
        .values({
          id: "job_evicted",
          owner: "ses_b",
          command: "sleep 999",
          status: "interrupted",
          output: "partial output",
          truncated: false,
          time_started: Date.now() - 60_000,
        })
        .run()
        .pipe(Effect.orDie)

      const fromRow = yield* bashJobs.status("job_evicted", "ses_b")
      expect(fromRow.running).toBe(false)
      expect(fromRow.interrupted).toBe(true)
      expect(fromRow.output).toBe("partial output")

      const stopped = yield* bashJobs.stop("job_evicted", "ses_b")
      expect(stopped.interrupted).toBe(true)

      const denied = yield* bashJobs.status("job_evicted", "ses_intruder").pipe(Effect.flip)
      expect(denied._tag).toBe("BashJobs.NotFoundError")
    }),
  )

  it.effect("recovery: running rows flip to interrupted; ancient rows are pruned", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(BashJobTable)
        .values([
          {
            id: "job_stale_running",
            owner: "ses_c",
            command: "npm run dev",
            status: "running",
            output: "booting…",
            truncated: false,
            time_started: Date.now() - 5_000,
          },
          {
            id: "job_ancient",
            owner: "ses_c",
            command: "old",
            status: "done",
            output: "",
            truncated: false,
            time_started: Date.now() - BashJobs.ROW_TTL_MS - 1_000,
          },
        ])
        .run()
        .pipe(Effect.orDie)

      yield* BashJobs.recover(db)

      const rows = yield* db.select().from(BashJobTable).all().pipe(Effect.orDie)
      const stale = rows.find((r) => r.id === "job_stale_running")!
      expect(stale.status).toBe("interrupted")
      expect(stale.output).toBe("booting…")
      expect(rows.find((r) => r.id === "job_ancient")).toBeUndefined()
    }),
  )
})
