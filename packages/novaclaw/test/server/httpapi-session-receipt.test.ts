import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { SessionExecutionAttempt } from "@novaclaw/core/session/execution-attempt"
import { SessionQualityCheckTable } from "@novaclaw/core/session/quality-check.sql"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionTable, TodoTable } from "@novaclaw/core/session/sql"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"
import { httpApiLayer, requestInDirectory } from "./httpapi-layer"

/**
 * **`GET /api/session/:sessionID/receipt`** — "What Nova checked", over the wire.
 *
 * The composer has its own unit tests; what can only fail HERE is the wiring — the route existing,
 * the service reaching the handler's layer, and the deliberate 404 for a session that never ran.
 *
 * 🔴 That 404 is the point of the endpoint's contract. An empty receipt asserts that nothing
 * happened; "this session has not run yet" is a different claim, and a caller cannot tell them apart
 * once they are spelled the same.
 */

// `SessionExecutionAttempt` is merged in because the test OPENS an attempt itself — the server has
// its own copy inside the routed instance graph, and this one is the seeder, not the subject.
const it = testEffectShared(
  Layer.mergeAll(Database.defaultLayer, SessionExecutionAttempt.defaultLayer, httpApiLayer),
)

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const seedSession = (id: SessionSchema.ID, directory: string) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({ id, slug: id, directory, title: id, version: "test" })
      .run()
      .pipe(Effect.orDie)
  })

describe("GET /api/session/:id/receipt", () => {
  it.instance("🔴 a session that never ran answers 404, not an empty receipt", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const id = SessionSchema.ID.make("ses_httpnorun")
      yield* seedSession(id, test.directory)

      const res = yield* requestInDirectory(`/api/session/${id}/receipt`, test.directory)
      expect(res.status).toBe(404)
      // And it says WHY — a bare 404 reads as "no such session", which is a different fault with a
      // different fix.
      expect(yield* res.text).toContain("no receipt")
    }),
  )

  it.instance("returns the attempt, the frozen plan and the checks that ran", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const id = SessionSchema.ID.make("ses_httpreceipt")
      yield* seedSession(id, test.directory)

      const { db } = yield* Database.Service
      const now = Date.now()
      yield* db
        .insert(TodoTable)
        .values({
          session_id: id,
          content: "ship the receipt",
          status: "pending",
          priority: "medium",
          position: 0,
          time_created: now,
          time_updated: now,
        })
        .run()
        .pipe(Effect.orDie)

      const attempts = yield* SessionExecutionAttempt.Service
      const lease = yield* attempts.start(id, "owner-http")
      yield* attempts.servedBy(lease, "vllm-0.9.2-a44fe734")
      yield* db
        .insert(SessionQualityCheckTable)
        .values({
          id: "chk_http",
          session_id: id,
          label: "typecheck",
          command: "bun run typecheck",
          outcome: "refused",
          // ⚠️ NULL survives the wire. A refusal ran no process, so a `0` here would report a clean
          // exit for a check that never started — the receipt's central distinction.
          exit_code: null,
          timed_out: false,
          duration_ms: 12,
          time_created: Date.now() + 5,
        })
        .run()
        .pipe(Effect.orDie)

      const res = yield* requestInDirectory(`/api/session/${id}/receipt`, test.directory)
      expect(res.status).toBe(200)
      const body = JSON.parse(yield* res.text) as { data: Record<string, unknown> }
      expect(body.data["attemptID"]).toBe(lease.attemptID)
      expect((body.data["declaredPlan"] as Array<{ content: string }>).map((item) => item.content)).toEqual([
        "ship the receipt",
      ])
      const checks = body.data["checks"] as Array<{ label: string; command: string; exitCode: number | null }>
      expect(checks.map((check) => check.label)).toEqual(["typecheck"])
      expect(checks[0]?.command).toBe("bun run typecheck")
      expect(checks[0]?.exitCode).toBeNull()
      // 🔴 Only THIS level can catch it: a field the success schema does not declare is dropped from
      // the response body, and the composer's own tests pass either way. Serving provenance would
      // then be present in the database, correct in every unit test, and invisible to every caller.
      expect(body.data["servedBy"]).toEqual(["vllm-0.9.2-a44fe734"])
    }),
  )
})
