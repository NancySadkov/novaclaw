import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { SessionExecutionAttempt } from "@novaclaw/core/session/execution-attempt"
import { SessionQualityCheckTable } from "@novaclaw/core/session/quality-check.sql"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionTable, TodoTable } from "@novaclaw/core/session/sql"
import { SessionPolicyDecisionTable } from "@novaclaw/core/tool-policy.sql"
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
const it = testEffectShared(Layer.mergeAll(Database.defaultLayer, SessionExecutionAttempt.defaultLayer, httpApiLayer))

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

      // A pre-action policy intervention, seeded through the SAME table the gate writes
      // (`tool-policy.sql.ts`). This row is what proves the wire carries an intervention at all —
      // see the assertion at the bottom of this test for why nothing else could.
      yield* db
        .insert(SessionPolicyDecisionTable)
        .values({
          id: "pol_http",
          session_id: id,
          tool_call_id: "call_http",
          tool: "bash",
          decision: "patch",
          detail: "`git log` was rewritten to `git --no-pager log` before it ran.",
          // Both an intervening provider AND a silent one, deliberately: a receipt that listed only
          // the policy that acted cannot answer "was the other guard even running?".
          providers: [
            { id: "git-no-pager", outcome: "patch", detail: "rewritten to `git --no-pager log`" },
            { id: "irreversible-shell", outcome: "allow" },
          ],
          patched: { command: "git --no-pager log" },
          time_created: Date.now() + 6,
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
      // 🔴 The same class of defect as `servedBy` above, and it was REAL until 2026-08-19:
      // `SessionReceipt.Info` did not declare `policies`, so the composer read the row, the handler
      // returned it, and the success schema dropped it silently on the way out. A durable
      // intervention that no caller can see is the product rewriting a tool call and telling nobody
      // — the exact thing the receipt exists to prevent. Only a test at THIS level sees it.
      const policies = body.data["policies"] as Array<{
        toolCallID: string
        tool: string
        decision: string
        detail: string
        providers: Array<{ id: string; outcome: string; detail?: string }>
        patched?: Record<string, unknown>
      }>
      expect(policies).toHaveLength(1)
      expect(policies[0]?.toolCallID).toBe("call_http")
      expect(policies[0]?.tool).toBe("bash")
      expect(policies[0]?.decision).toBe("patch")
      expect(policies[0]?.detail).toContain("--no-pager")
      // The silent provider survives too. A schema that declared only `{id, outcome}` would drop
      // the per-policy `detail`, and a schema that dropped the `allow` row would make the receipt
      // unable to say the other guard ran.
      expect(policies[0]?.providers.map((entry) => `${entry.id}:${entry.outcome}`)).toEqual([
        "git-no-pager:patch",
        "irreversible-shell:allow",
      ])
      expect(policies[0]?.providers[0]?.detail).toContain("--no-pager")
      // ⚠️ The REWRITTEN arguments, as applied. `Schema.Record(String, Unknown)` is what lets an
      // arbitrary tool's field survive; a typed struct here would silently empty this object for
      // every tool but the one it was written for.
      expect(policies[0]?.patched).toEqual({ command: "git --no-pager log" })
    }),
  )

  it.instance("a receipt with no intervention carries an EMPTY policies list, not a missing one", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const id = SessionSchema.ID.make("ses_httpnopolicy")
      yield* seedSession(id, test.directory)
      const attempts = yield* SessionExecutionAttempt.Service
      yield* attempts.start(id, "owner-http")

      const res = yield* requestInDirectory(`/api/session/${id}/receipt`, test.directory)
      expect(res.status).toBe(200)
      const body = JSON.parse(yield* res.text) as { data: Record<string, unknown> }
      // 🔴 `[]` and `undefined` are different claims and a surface renders them differently: an
      // empty list says every installed policy allowed every call in time, where a missing field
      // says this build cannot tell you. The receipt is only allowed to make the first claim.
      expect(body.data["policies"]).toEqual([])
    }),
  )
})

describe("GET /api/session/execution", () => {
  it.instance("filters the durable execution ledger by session when requested", () =>
    Effect.gen(function* () {
      const test = yield* TestInstance
      const first = SessionSchema.ID.make("ses_httpfilter1")
      const second = SessionSchema.ID.make("ses_httpfilter2")
      yield* seedSession(first, test.directory)
      yield* seedSession(second, test.directory)

      const attempts = yield* SessionExecutionAttempt.Service
      const firstLease = yield* attempts.start(first, "owner-http")
      yield* attempts.start(second, "owner-http")

      const res = yield* requestInDirectory(`/api/session/execution?sessionID=${first}`, test.directory)
      expect(res.status).toBe(200)
      const body = JSON.parse(yield* res.text) as { data: Array<{ sessionID: string; attemptID: string }> }
      expect(body.data).toHaveLength(1)
      expect(body.data[0]).toEqual(expect.objectContaining({ sessionID: first, attemptID: firstLease.attemptID }))
    }),
  )
})
