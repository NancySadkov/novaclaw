import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { SessionExecutionAttempt } from "@novaclaw/core/session/execution-attempt"
import { SessionReceipt } from "@novaclaw/core/session/receipt"
import { SessionQualityCheckTable } from "@novaclaw/core/session/quality-check.sql"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionTable, TodoTable } from "@novaclaw/core/session/sql"
import { testEffect } from "./lib/effect"

/**
 * "What Nova checked" — `todo/verified-autonomy.md` V1.
 *
 * 🔴 The claim the whole programme rests on is *mechanical evidence is authoritative*, so what is
 * tested here is that every field came from a table something else wrote as it happened — and, above
 * all, that a check belonging to a DIFFERENT attempt cannot appear on this one's receipt.
 */

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, SessionExecutionAttempt.node, SessionReceipt.node])),
)

const makeSession = (id: SessionSchema.ID) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({ id, slug: id, directory: "/project", title: id, version: "test" })
      .run()
      .pipe(Effect.orDie)
  })

const addPlan = (id: SessionSchema.ID, items: string[]) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const now = Date.now()
    for (const [position, content] of items.entries())
      yield* db
        .insert(TodoTable)
        .values({
          session_id: id,
          content,
          status: "pending",
          priority: "medium",
          position,
          time_created: now,
          time_updated: now,
        })
        .run()
        .pipe(Effect.orDie)
  })

const addCheck = (
  id: SessionSchema.ID,
  input: { label: string; outcome: string; exitCode: number | null; at: number },
) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionQualityCheckTable)
      .values({
        id: `chk_${input.label}_${input.at}`,
        session_id: id,
        label: input.label,
        command: `bun run ${input.label}`,
        outcome: input.outcome,
        exit_code: input.exitCode,
        timed_out: false,
        duration_ms: 10,
        time_created: input.at,
      })
      .run()
      .pipe(Effect.orDie)
  })

describe("the task receipt", () => {
  it.effect("a session that never ran has NO receipt — not an empty one", () =>
    Effect.gen(function* () {
      // An empty receipt asserts that nothing happened. "Nothing ran yet" is a different claim, and
      // a reader cannot tell them apart once they are spelled the same.
      const id = SessionSchema.ID.make("ses_never")
      yield* makeSession(id)
      const receipt = yield* SessionReceipt.Service
      expect(yield* receipt.forSession(id)).toBeUndefined()
    }),
  )

  it.effect("carries the attempt fence, the frozen plan, and the checks that ran", () =>
    Effect.gen(function* () {
      const id = SessionSchema.ID.make("ses_full")
      yield* makeSession(id)
      yield* addPlan(id, ["read the failing test", "fix the parser"])
      const attempt = yield* SessionExecutionAttempt.Service
      const lease = yield* attempt.start(id, "owner-1")
      yield* addCheck(id, { label: "typecheck", outcome: "passed", exitCode: 0, at: Date.now() + 5 })

      const receipt = yield* (yield* SessionReceipt.Service).forSession(id)
      expect(receipt?.attemptID).toBe(lease.attemptID)
      expect(receipt?.generation).toBe(lease.generation)
      expect(receipt?.declaredPlan.map((item) => item.content)).toEqual(["read the failing test", "fix the parser"])
      expect(receipt?.checks.map((check) => check.label)).toEqual(["typecheck"])
      // The command, not just the label: a label is a name the user chose, and provisioned commands
      // change. A receipt naming `typecheck` without saying what ran is a claim, not evidence.
      expect(receipt?.checks[0]?.command).toBe("bun run typecheck")
    }),
  )

  it.effect("🔴 a check from a PREVIOUS attempt does not appear on this one", () =>
    Effect.gen(function* () {
      // The bracket is the only thing standing between this receipt and the last attempt's evidence.
      // `session_quality_check` is deliberately not keyed to `attempt_id`, so if the window were
      // wrong the receipt would silently claim work it did not do — which is the one failure this
      // whole programme exists to prevent.
      const id = SessionSchema.ID.make("ses_two_attempts")
      yield* makeSession(id)
      const attempt = yield* SessionExecutionAttempt.Service

      yield* attempt.start(id, "owner-1")
      // ⚠️ An explicitly OLD timestamp rather than a sleep. `Effect.sleep` under `it.effect` runs on a
      // TestClock that nothing advances, so the test hangs forever — and a real sleep would make the
      // assertion depend on millisecond resolution, which is how a bracket test becomes flaky.
      yield* addCheck(id, { label: "old-check", outcome: "failed", exitCode: 1, at: Date.now() - 10_000 })
      const second = yield* attempt.start(id, "owner-2")
      yield* addCheck(id, { label: "new-check", outcome: "passed", exitCode: 0, at: Date.now() + 50 })

      const receipt = yield* (yield* SessionReceipt.Service).forSession(id)
      expect(receipt?.attemptID).toBe(second.attemptID)
      expect(receipt?.checks.map((check) => check.label)).toEqual(["new-check"])
    }),
  )

  it.effect("🔴 a refusal keeps its NULL exit code — never a zero", () =>
    Effect.gen(function* () {
      // `refused` never ran a process. A `0` would report a clean exit for a check that never
      // started, which is the explicit-unknowns half of V1 arrived at from the read side.
      const id = SessionSchema.ID.make("ses_refused")
      yield* makeSession(id)
      const attempt = yield* SessionExecutionAttempt.Service
      yield* attempt.start(id, "owner-1")
      yield* addCheck(id, { label: "test", outcome: "refused", exitCode: null, at: Date.now() + 5 })

      const receipt = yield* (yield* SessionReceipt.Service).forSession(id)
      expect(receipt?.checks[0]?.outcome).toBe("refused")
      expect(receipt?.checks[0]?.exitCode).toBeNull()
    }),
  )

  it.effect("lists spawned children by id, and none when there are none", () =>
    Effect.gen(function* () {
      const parent = SessionSchema.ID.make("ses_parent")
      yield* makeSession(parent)
      const attempt = yield* SessionExecutionAttempt.Service
      yield* attempt.start(parent, "owner-1")

      const service = yield* SessionReceipt.Service
      expect((yield* service.forSession(parent))?.children).toEqual([])

      const { db } = yield* Database.Service
      for (const child of ["ses_child_b", "ses_child_a"])
        yield* db
          .insert(SessionTable)
          .values({
            id: SessionSchema.ID.make(child),
            slug: child,
            directory: "/project",
            title: child,
            version: "test",
            parent_id: parent,
          })
          .run()
          .pipe(Effect.orDie)

      // Ids only, and ordered — a receipt that inlined its children's receipts would recurse to
      // whatever depth the run reached, and a reader handed the whole tree cannot stop.
      expect((yield* service.forSession(parent))?.children).toEqual(["ses_child_a", "ses_child_b"])
    }),
  )

  it.effect("the plan is the FROZEN one, not the live list", () =>
    Effect.gen(function* () {
      const id = SessionSchema.ID.make("ses_frozen")
      yield* makeSession(id)
      yield* addPlan(id, ["as declared"])
      const attempt = yield* SessionExecutionAttempt.Service
      yield* attempt.start(id, "owner-1")

      const { db } = yield* Database.Service
      yield* db
        .update(TodoTable)
        .set({ content: "rewritten mid-run", status: "completed" })
        .where(eq(TodoTable.session_id, id))
        .run()
        .pipe(Effect.orDie)

      const receipt = yield* (yield* SessionReceipt.Service).forSession(id)
      expect(receipt?.declaredPlan.map((item) => item.content)).toEqual(["as declared"])
    }),
  )
})
