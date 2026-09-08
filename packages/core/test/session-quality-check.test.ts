import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { SessionQualityCheck } from "@novaclaw/core/session/quality-check"
import { testEffect } from "./lib/effect"

/**
 * 🔴 `` V1: *"`checks` are LOG EVENTS, not evidence."*
 *
 * The program rests on *mechanical evidence is authoritative*, and the only record that a check had
 * run was a line in a rotating text log — not queryable per attempt, and unable to say what the exit
 * code was. This is the durable half, and the item asks for it FIRST because its shape constrains
 * everything the receipt later reads.
 *
 * Every test below pins a decision that would otherwise produce a receipt that reads well and is
 * wrong.
 */
const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node])))

const at = 1_786_000_000_000

describe("SessionQualityCheck", () => {
  it.effect("records a run and reads it back whole", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* SessionQualityCheck.record(db, {
        sessionID: "ses_a",
        label: "typecheck",
        command: "bun run typecheck",
        outcome: "failed",
        exitCode: 2,
        durationMs: 4321,
        at,
      })
      const rows = yield* SessionQualityCheck.forSession(db, "ses_a")
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        session_id: "ses_a",
        label: "typecheck",
        // The COMMAND, not just its label. A label is a name the user chose; a receipt that says
        // "typecheck failed" without saying what typecheck was is a claim, not evidence.
        command: "bun run typecheck",
        outcome: "failed",
        exit_code: 2,
        timed_out: false,
        duration_ms: 4321,
      })
    }),
  )

  it.effect("🔴 an absent exit code stays NULL — never 0", () =>
    Effect.gen(function* () {
      // The ambiguous blank the item names as its second gap. `refused` ran no process at all, and a
      // 0 there would say "exited cleanly" — on an evidence document a blank that reads as zero reads
      // as SUCCESS.
      const { db } = yield* Database.Service
      yield* SessionQualityCheck.record(db, {
        sessionID: "ses_b",
        label: "test",
        command: "bun test",
        outcome: "refused",
        at,
      })
      const rows = yield* SessionQualityCheck.forSession(db, "ses_b")
      expect(rows[0]?.exit_code).toBeNull()
      expect(rows[0]?.duration_ms).toBeNull()
      expect(rows[0]?.exit_code).not.toBe(0)
    }),
  )

  it.effect("a refusal is its OWN outcome, not a failure", () =>
    Effect.gen(function* () {
      // `llm.ts` already draws this line for the steer ("a policy refusal is not a broken check").
      // An evidence table that spelled both `failed` would let a receipt report the user's own
      // permission posture as a defect in their code.
      const { db } = yield* Database.Service
      for (const outcome of ["passed", "failed", "refused", "errored"] as const)
        yield* SessionQualityCheck.record(db, {
          sessionID: "ses_c",
          label: outcome,
          command: `cmd ${outcome}`,
          outcome,
          at: at + ["passed", "failed", "refused", "errored"].indexOf(outcome),
        })
      const rows = yield* SessionQualityCheck.forSession(db, "ses_c")
      expect(rows.map((row) => row.outcome).sort()).toEqual(["errored", "failed", "passed", "refused"])
    }),
  )

  it.effect("the SAME label run many times keeps every row — the drain fires it per file", () =>
    Effect.gen(function* () {
      // ⚠️ `dueMidLoop` runs one label once per touched file. Collapsing them would answer "did
      // typecheck pass?" with the last one, which is exactly what a receipt must not guess at.
      const { db } = yield* Database.Service
      for (let i = 0; i < 3; i++)
        yield* SessionQualityCheck.record(db, {
          sessionID: "ses_d",
          label: "syntax",
          command: "check a.ts",
          outcome: i === 1 ? "failed" : "passed",
          at: at + i,
        })
      const rows = yield* SessionQualityCheck.forSession(db, "ses_d")
      expect(rows).toHaveLength(3)
      // …newest first, so a reader takes the latest without sorting.
      expect(rows.map((row) => row.time_created)).toEqual([at + 2, at + 1, at])
      expect(rows.filter((row) => row.outcome === "failed")).toHaveLength(1)
    }),
  )

  it.effect("re-recording ONE run is idempotent, so a retried write cannot double-count", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const row = {
        sessionID: "ses_e",
        label: "test",
        command: "bun test",
        outcome: "passed" as const,
        at,
      }
      yield* SessionQualityCheck.record(db, row)
      yield* SessionQualityCheck.record(db, row)
      expect(yield* SessionQualityCheck.forSession(db, "ses_e")).toHaveLength(1)
    }),
  )

  it.effect("rows are scoped to their session, and `since` brackets a window", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* SessionQualityCheck.record(db, {
        sessionID: "ses_f",
        label: "old",
        command: "c",
        outcome: "passed",
        at: at - 10_000,
      })
      yield* SessionQualityCheck.record(db, {
        sessionID: "ses_f",
        label: "new",
        command: "c",
        outcome: "passed",
        at,
      })
      yield* SessionQualityCheck.record(db, {
        sessionID: "ses_other",
        label: "elsewhere",
        command: "c",
        outcome: "passed",
        at,
      })
      // The bracket that stands in for an attempt id until V1 threads one down.
      const windowed = yield* SessionQualityCheck.forSession(db, "ses_f", at - 1)
      expect(windowed.map((row) => row.label)).toEqual(["new"])
      expect((yield* SessionQualityCheck.forSession(db, "ses_f")).map((row) => row.label)).toEqual(["new", "old"])
    }),
  )
})
