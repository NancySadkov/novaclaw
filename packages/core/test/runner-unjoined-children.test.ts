import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { SessionV2 } from "@novaclaw/core/session"
import { Prompt } from "@novaclaw/core/session/prompt"
import { UnjoinedChildren } from "@novaclaw/core/session/runner/unjoined-children"
import { SessionTable } from "@novaclaw/core/session/sql"
import { HARNESS_SESSION, completeTurn, drive, makeRunnerHarness } from "./fixture/runner-harness"

/**
 * 🔴 **THE CALL SITE, not the module.** `unjoined-children.test.ts` beside the source pins every
 * decision the pure module makes; NOTHING there proves the runner ever asks it. That gap is the one
 * `notes/` names outright — *a feature can be built, tested, and NEVER CALLED* — and it is the
 * likeliest way this work would have shipped inert: module green, typecheck green, drain never
 * reaching the branch.
 *
 * The runner's own suite cannot close it either. `test/session-runner.test.ts` is win32-skipped, so
 * on this box the finish block inside `runner/llm.ts` goes unexecuted by the default gate. This
 * harness is the one that drives the REAL drain on win32 (see `runner-harness-drain.test.ts`'s
 * admission test), which makes it the only place the wiring is observable here.
 *
 * ⚠️ **Asserted on the TRANSCRIPT, not on the log event.** `Log.event` writes to the Effect logger,
 * not to `EventV2` — a first version of this file listened on the event bus, saw nothing, and read as
 * *"the branch never ran"* while the branch was in fact running and steering correctly. The
 * transcript is also the stronger claim: it says the model was actually TOLD, where a log line only
 * says the harness noticed. A version that logs and never speaks passes the log assertion and fails
 * every one of these.
 */

/** The 1N provenance prefix every harness steer carries. */
const STEER_PREFIX = "[Automated NovaClaw check"

const runWithChildren = async (children: { exited: boolean }[], label: string, drives?: { children?: boolean }) => {
  const harness = makeRunnerHarness({ turns: [completeTurn("text-1", "All done — every slice is covered.")] })
  if (drives !== undefined) harness.controls.harnessDrives = drives
  let transcript: { type: string; text?: string }[] = []

  await drive(
    harness,
    Effect.gen(function* () {
      // 🔴 The fan-out, made real: each child is an ACTUAL ROW carrying HARNESS_SESSION as its
      // `parent_id`, which is exactly the column `SessionStore.children` selects on. A stubbed list
      // would test the stub, and whether the runner reaches the store is the entire question.
      //
      // ⚠️ Seeded by direct insert, the way the fixture seeds its own session. `SessionV2.create`
      // resolves a project from `input.location.directory`, which this deliberately partial graph
      // does not supply, so it fails inside `projects.resolve` before a row is ever written.
      const { db } = yield* Database.Service
      for (const [index, child] of children.entries()) {
        yield* db
          .insert(SessionTable)
          .values({
            id: SessionV2.ID.make(`ses_child_${index}`),
            parent_id: HARNESS_SESSION,
            slug: `ses_child_${index}`,
            directory: process.cwd(),
            // A REAL title, because the supervisor quotes the slice back from it and
            // `SessionTitle.isDefault` rejects "New session" — under a default title the message
            // would name no slice, which is a different assertion from the one made below.
            title: `describe icons ${index * 10 + 1}-${index * 10 + 10}`,
            version: "test",
            // `result` IS the `exit(result)` payload the exit tool records, and it is what the
            // supervisor reads to tell a child that FINISHED from one that never reported back.
            // Written here rather than through the tool, which would need a whole scripted child turn.
            ...(child.exited ? { result: `slice ${index} done` } : {}),
          })
          .onConflictDoNothing()
          .run()
          .pipe(Effect.orDie)
      }
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID: HARNESS_SESSION,
        prompt: Prompt.make({ text: "Merge what the children found." }),
        resume: false,
      })
      yield* session.resume(HARNESS_SESSION)
      transcript = (yield* session.context(HARNESS_SESSION)) as typeof transcript
    }),
    label,
  )

  const steers = transcript
    .filter((message) => message.type === "user" && (message.text ?? "").startsWith(STEER_PREFIX))
    .map((message) => message.text ?? "")
  return { transcript, steers }
}

describe("the runner asks the fan-out supervisor", () => {
  // 🔴 THE MEASURED RUN, driven through the real drain: two children exist, neither was joined —
  // the `spawn:10 / wait:9` shape from `4623-S2`, reduced to its smallest reproducible form.
  test("a turn that finishes with an unjoined child is steered back to it", async () => {
    const { steers } = await runWithChildren([{ exited: true }, { exited: true }], "unjoined children steer")

    expect(steers.length, "an unaccounted child must reach the model as a steer").toBeGreaterThan(0)
    // ① The ARITHMETIC — the fact the harness counted and the model demonstrably could not.
    expect(steers[0]).toContain("you spawned 2 child sessions and read the result of 0")
    // ② Both children NAMED with the call that closes them. "You missed some" is not actionable.
    expect(steers[0]).toContain('wait("ses_child_0")')
    expect(steers[0]).toContain('wait("ses_child_1")')
    // ③ The SLICE, quoted from the child's own durable title — the thing `wait` cannot supply,
    //    because the spawn prompt was never its to hold.
    expect(steers[0]).toContain("describe icons 1-10")
    // ④ And the two cheap answers are forbidden in the words the model actually receives.
    expect(steers[0]).toContain("Do not summarise a slice from what the other children reported")
  })

  /**
   * 🔴 THE BOUND, end to end: *"A restart that itself fails must not loop."*
   *
   * ⭐ This is the assertion the pure module CANNOT make. `shouldRestart` is a predicate over a round
   * counter; whether that counter actually advances depends on where it LIVES, and the set drive was
   * corrected three separate times for putting exactly this state in a drain local — where every
   * steer starts a new drain, the counter resets to 0, and the bound is never reached. Here the
   * children are never joined, so nothing converges and only the ceiling can stop it: the number of
   * steers in the transcript IS the proof that the session-scoped counter survives a drain boundary.
   */
  test("it stops at MAX_RESTART_ROUNDS rather than steering forever", async () => {
    const { steers } = await runWithChildren([{ exited: false }], "restart bound")
    expect(steers).toHaveLength(UnjoinedChildren.MAX_RESTART_ROUNDS)
  })

  /**
   * ⚠️ THE NEGATIVE CONTROL. *"No steer fired"* is also what a completely unwired branch looks like,
   * so silence alone would pass against deleted code. The paired assertion is that the drain DID
   * reach its finish — an assistant message was written — which is the same point in the code where
   * the branch sits. Together: the drain got there, and declined.
   */
  /**
   * 🔴 THE SWITCH, PROVEN AT ITS CALL SITE — not merely resolved.
   *
   * `config/harness-drives.test.ts` pins what `resolve` returns; NOTHING there proves the runner
   * reads it. A config value nothing consumes is the same *built, tested, never called* shape this
   * whole file exists to rule out, one layer up — and it would be worse here, because the operator
   * would believe they had measured an unaided model while the drive kept firing.
   *
   * ⚠️ The pair is what makes it a measurement: the SAME fan-out that steers three times with the
   * drive on must steer ZERO times with it off. Asserting only the zero would pass against a broken
   * fixture that never created the children.
   */
  test("harness_drives.children = false silences the drive that otherwise fires", async () => {
    const on = await runWithChildren([{ exited: false }], "drive on")
    expect(on.steers.length, "control: with the drive ON this fan-out steers").toBeGreaterThan(0)

    const off = await runWithChildren([{ exited: false }], "drive off", { children: false })
    expect(off.steers, "with the drive OFF the identical fan-out must say nothing").toHaveLength(0)
    expect(
      off.transcript.some((message) => message.type === "assistant"),
      "the drain must still reach finish — silence from a crashed drain proves nothing",
    ).toBe(true)
  })

  test("a session with no children reaches finish and says nothing", async () => {
    const { transcript, steers } = await runWithChildren([], "no children")
    expect(steers).toHaveLength(0)
    expect(
      transcript.some((message) => message.type === "assistant"),
      "the drain must reach finish, or the silence above proves nothing",
    ).toBe(true)
  })
})
