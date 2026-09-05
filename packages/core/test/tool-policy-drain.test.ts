import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { LLMEvent } from "@novaclaw/llm"
import { Database } from "@novaclaw/core/database/database"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionTable } from "@novaclaw/core/session/sql"
import { Prompt } from "@novaclaw/core/session/prompt"
import type { ToolPolicy } from "@novaclaw/core/tool-policy"
import { HARNESS_SESSION, drive, makeRunnerHarness } from "./fixture/runner-harness"

/**
 * `` → **Typed pre-action policies**: what makes `halt` DIFFERENT from `deny`.
 *
 * 🔴 The seam proves the call was refused (`tool-policy.test.ts`); that is the half a deny already
 * has. The half only a halt has is that the drain STOPS — and a latch nothing reads is a latch that
 * does not exist, which is the whole point of running this through the real runner rather than
 * asserting on `settlement.halted` and calling it done.
 *
 * ⚠️ The A/B: delete `|| policyHalted` from the drain-loop break in `session/runner/llm.ts` (or the
 * `settlement.halted` assignment above it) and the "does not continue" case goes red while the
 * "deny does continue" control stays green. Both were run; results are in the report.
 */

const toolCallTurn = (id: string, text: string) => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolCall({ id, name: "echo", input: { text } }),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
  LLMEvent.finish({ reason: "tool-calls" }),
]

const policy = (id: string, outcome: ToolPolicy.Outcome): ToolPolicy.Provider => ({
  id,
  describe: id,
  evaluate: () => Effect.succeed(outcome),
})

const runWith = async (policies: readonly ToolPolicy.Provider[], label: string, queued = 0) => {
  const harness = makeRunnerHarness({
    // Two tool-calling turns: if the drain continues after the refusal it will issue the second
    // request, and if it stops it will not. The COUNT is the claim.
    turns: [toolCallTurn("call-1", "first"), toolCallTurn("call-2", "second")],
    policies,
  })
  await drive(
    harness,
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      for (let index = 0; index <= queued; index++)
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: `Do the work ${index}` }),
          resume: false,
        })
      yield* session.resume(HARNESS_SESSION)
      return yield* session.context(HARNESS_SESSION)
    }),
    label,
  )
  return harness
}

/** The same drain, with the session declared auto-prompting so it self-drives when its queue is dry. */
const runSelfDriving = async (policies: readonly ToolPolicy.Provider[]) => {
  const harness = makeRunnerHarness({
    turns: [toolCallTurn("call-1", "first"), toolCallTurn("call-2", "second"), toolCallTurn("call-3", "third")],
    policies,
  })
  await drive(
    harness,
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID: HARNESS_SESSION,
        prompt: Prompt.make({ text: "Work until done" }),
        resume: false,
      })
      yield* db
        .update(SessionTable)
        .set({ type: "auto-prompting" })
        .where(eq(SessionTable.id, HARNESS_SESSION))
        .run()
        .pipe(Effect.orDie)
      yield* session.resume(HARNESS_SESSION)
    }),
    "self-driving policy drain",
  )
  return harness
}

describe("a halt stops the drain; a deny does not", () => {
  test("🔴 halt — the refused call is the LAST provider request of the drain", async () => {
    const harness = await runWith(
      [policy("stopper", { type: "halt", reason: "the operator revoked this" })],
      "policy halt",
    )
    // One interactive request: the turn that made the refused call. A drain that continued would
    // have asked the model what to do next and consumed the second scripted turn.
    expect(harness.requests, "a halt must end the drain, not just the call").toHaveLength(1)
  })

  test("the control — a DENY leaves the drain running, so the count above is about halt", async () => {
    const harness = await runWith([policy("refuser", { type: "deny", reason: "not allowed" })], "policy deny")
    // 🔴 Without this control the test above would pass just as well if policies broke the drain
    // outright, or if the harness only ever issued one request. A deny is a refusal the model routes
    // around, so the drain continues and the second scripted turn is consumed.
    //
    // ⚠️ A lower bound rather than an exact count, deliberately: a scripted turn that says nothing
    // earns an automated re-ground and one more request (`RunnerScript.turns` documents it), so an
    // exact number here would be a claim about the FIXTURE's nudge machinery rather than about the
    // policy. What the halt case asserts is exact, because "one" leaves no room for a nudge.
    expect(harness.requests.length, "a deny is an observation, not a stop").toBeGreaterThan(1)
  })

  test("the second control — with no policy installed the drain also continues", async () => {
    const harness = await runWith([], "no policy")
    expect(harness.requests.length).toBeGreaterThan(1)
  })

  test("🔴 a QUEUED prompt does not restart a halted drain", async () => {
    /**
     * The step loop ending is not enough on its own. After it, the drain asks whether input is
     * queued and starts over if it is — so a halt that only cut the continuation would be undone by
     * the very next thing in the inbox, which is the same reason `truncationHalted` is a drain-level
     * latch rather than a step-level one.
     *
     * ⚠️ Stopping a QUEUED USER PROMPT is the deliberate reading of "halt". The run is over; the
     * prompt is still in the inbox, and any new input wakes a FRESH drain through the coordinator,
     * where the policy is consulted again. A halt ends a run, it does not disable a session.
     */
    const harness = await runWith(
      [policy("stopper", { type: "halt", reason: "the operator revoked this" })],
      "policy halt with queued input",
      1,
    )
    expect(harness.requests, "a queued prompt must not resume a halted drain").toHaveLength(1)
  })

  test("the control for the queued case — a deny lets the queued prompt through", async () => {
    const harness = await runWith([policy("refuser", { type: "deny", reason: "not allowed" })], "policy deny queued", 1)
    expect(harness.requests.length).toBeGreaterThan(1)
  })

  test("🔴 an AUTO-PROMPTING session does not self-drive past a halt", async () => {
    /**
     * The path the drain-level latch actually exists for. An auto-prompting session whose queue runs
     * dry injects its own next prompt and keeps going ("run until `exit()`"), so cutting only the
     * step loop would hand the halted session straight back to the model — the halt undone by the
     * mechanism that makes autonomy work.
     */
    const harness = await runSelfDriving([policy("stopper", { type: "halt", reason: "the operator revoked this" })])
    expect(harness.requests, "self-drive must not resume a halted drain").toHaveLength(1)
  })

  test("the control — an auto-prompting session DOES self-drive past a deny", async () => {
    const harness = await runSelfDriving([policy("refuser", { type: "deny", reason: "not allowed" })])
    expect(harness.requests.length, "without a halt the session keeps working").toBeGreaterThan(1)
  })
})
