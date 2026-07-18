import { describe, expect } from "bun:test"
import { Duration, Effect, Layer, Stream } from "effect"
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

const command = { _tag: "StandardCommand" } as unknown as ChildProcess.Command

// A second harness with the REAL process node: proves the throttled flush lands output in the
// row WHILE a live child runs (the piece a mocked instant stream can never exercise).
const itLive = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, BashJobs.node])))

describe("BashJobs durability (live process)", () => {
  itLive.live("the throttled flush lands output in the row while the job still runs", () =>
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
