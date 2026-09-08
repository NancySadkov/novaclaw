// 1H — the bash job store: yield-don't-kill semantics, owner binding, stop, caps.
// Uses real child processes (bun -e) — no shell, Windows-safe.
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { BashJobs } from "@novaclaw/core/tool/bash-jobs"
import { AppProcess } from "@novaclaw/core/process"
import { Database } from "@novaclaw/core/database/database"
import { testEffect } from "../lib/effect"

// T6: BashJobs write-throughs to the bash_job table now — an isolated in-memory DB keeps the
// real instance database out of test reach.
const it = testEffect(
  Layer.mergeAll(
    BashJobs.layer.pipe(Layer.provide(AppProcess.defaultLayer), Layer.provide(Database.layerFromPath(":memory:"))),
  ),
)

const bunEval = (code: string) => ChildProcess.make("bun", ["-e", code], { stdin: "ignore" })

describe("BashJobs (1H)", () => {
  it.live("fast command completes within the soft deadline", () =>
    Effect.gen(function* () {
      const jobs = yield* BashJobs.Service
      const { id } = yield* jobs.start({
        owner: "ses_a",
        command: bunEval("console.log('quick-ok')"),
        commandText: "quick",
        maxOutputBytes: 65536,
      })
      const done = yield* jobs.wait(id, "ses_a", 15_000)
      expect(done.running).toBe(false)
      expect(done.exit).toBe(0)
      expect(done.output).toContain("quick-ok")
    }),
  )

  it.live("slow command YIELDS (still running, partial output) then completes on a longer wait", () =>
    Effect.gen(function* () {
      const jobs = yield* BashJobs.Service
      const { id } = yield* jobs.start({
        owner: "ses_a",
        command: bunEval("console.log('started'); await new Promise(r=>setTimeout(r,6000)); console.log('finished')"),
        commandText: "slow",
        maxOutputBytes: 65536,
      })
      const early = yield* jobs.wait(id, "ses_a", 2_000)
      expect(early.running).toBe(true)
      expect(early.exit).toBeUndefined()
      expect(early.output).toContain("started") // partial capture while running
      expect(early.output).not.toContain("finished")
      const done = yield* jobs.wait(id, "ses_a", 20_000)
      expect(done.running).toBe(false)
      expect(done.exit).toBe(0)
      expect(done.output).toContain("finished")
    }),
  )

  it.live("stop terminates a running job (no exit code, not running)", () =>
    Effect.gen(function* () {
      const jobs = yield* BashJobs.Service
      const { id } = yield* jobs.start({
        owner: "ses_a",
        command: bunEval("await new Promise(r=>setTimeout(r,60000))"),
        commandText: "sleeper",
        maxOutputBytes: 65536,
      })
      const early = yield* jobs.wait(id, "ses_a", 500)
      expect(early.running).toBe(true)
      const stopped = yield* jobs.stop(id, "ses_a")
      expect(stopped.running).toBe(false)
      expect(stopped.exit).toBeUndefined()
    }),
  )

  it.live("owner binding: another session's poll reads as not-found", () =>
    Effect.gen(function* () {
      const jobs = yield* BashJobs.Service
      const { id } = yield* jobs.start({
        owner: "ses_a",
        command: bunEval("await new Promise(r=>setTimeout(r,30000))"),
        commandText: "private",
        maxOutputBytes: 65536,
      })
      const denied = yield* jobs.status(id, "ses_b").pipe(Effect.flip)
      expect(denied).toBeInstanceOf(BashJobs.JobNotFoundError)
      yield* jobs.stop(id, "ses_a")
    }),
  )

  it.live("per-session cap: the 6th concurrent job is refused", () =>
    Effect.gen(function* () {
      const jobs = yield* BashJobs.Service
      const ids: string[] = []
      for (let i = 0; i < BashJobs.MAX_JOBS_PER_SESSION; i++) {
        const { id } = yield* jobs.start({
          owner: "ses_cap",
          command: bunEval("await new Promise(r=>setTimeout(r,30000))"),
          commandText: `sleeper-${i}`,
          maxOutputBytes: 65536,
        })
        ids.push(id)
      }
      const refused = yield* jobs
        .start({
          owner: "ses_cap",
          command: bunEval("console.log('nope')"),
          commandText: "overflow",
          maxOutputBytes: 65536,
        })
        .pipe(Effect.flip)
      expect(refused).toBeInstanceOf(BashJobs.JobLimitError)
      // ⚠️ These five stops are the reason this case existed as a HANG for a while, and the reason
      // it is worth keeping exactly as it is. Root-caused 2026-07-31: `stop` unwinds the job's fiber,
      // which closes the spawn scope, which used to wait for the child's `'close'` event — and a
      // killed child's overlapped pipes can be left un-closed on Windows, so the wait never ended.
      // Bisected by tracing the phases apart: all five STARTS and the refusal completed in ~1.2 s and
      // `stop[0]` never returned. Fixed in `core/src/cross-spawn-spawner.ts` (teardown now waits on
      // process EXIT, not pipe close) and pinned by `core/test/spawner-teardown-bounded.test.ts`.
      // This case only reproduced under CONTENTION (~1 run in 10 with five suites competing), so it
      // is a witness, not the mechanical check.
      for (const id of ids) yield* jobs.stop(id, "ses_cap")
    }),
  )
})
