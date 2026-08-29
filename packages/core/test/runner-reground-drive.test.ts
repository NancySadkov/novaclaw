import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LLMEvent } from "@novaclaw/llm"
import { REGROUND_NUDGE, REGROUND_TOOL_CALLS } from "@novaclaw/core/session/runner/doom-loop"
import { SessionV2 } from "@novaclaw/core/session"
import { Prompt } from "@novaclaw/core/session/prompt"
import { HARNESS_SESSION, completeTurn, drive, makeRunnerHarness } from "./fixture/runner-harness"

/**
 * ── THE REGROUND DRIVE, AT ITS CALL SITE ─────────────────────────────────────────────────────────
 *
 * 🔴 **This switch is the blocker on the programme's headline question.** Every earlier batch-file
 * measurement was taken with `session.finish.reground`
 * live — it fires in every session and no prompt gates it — so *"can the model do this alone?"* has
 * never been asked. `harness_drives.reground` exists to ask it, and until something exercises the
 * runner's branch, a switch that silently failed would produce a "baseline" that is nothing of the
 * kind: a measurement of the model PLUS the harness that marched it, labelled as the model alone.
 *
 * `src/config/harness-drives.test.ts` proves `resolve` returns `false` when told to. That is the
 * MODULE. Nothing there proves `runner/llm.ts` asks it, which is the whole question — the same
 * built-tested-never-called gap `runner-unjoined-children.test.ts` was written to close for the other
 * drive.
 *
 * ⚠️ **Asserted on the TRANSCRIPT, not on `Log.event`.** `Log.event` writes to the Effect logger, not
 * to `EventV2`; a version of the sibling test listened on the bus, saw nothing, and read as *"the
 * branch never ran"* while it was running correctly. The transcript is also the stronger claim: it
 * says the model was actually TOLD, where a log line only says the harness noticed.
 *
 * ⚠️ **BOTH DIRECTIONS.** A test that only shows silence-when-off passes just as well when the drive
 * is broken and never fires at all — half a control, which is the shape `notes/` names outright. The
 * ON case is what proves this turn can trigger a reground in the first place.
 */

/** One turn that makes `calls` real tool calls — the gate counts tool PARTS, not a number we assert. */
const toolTurn = (calls: number): LLMEvent[] => [
  LLMEvent.stepStart({ index: 0 }),
  ...Array.from({ length: calls }, (_, i) =>
    LLMEvent.toolCall({ id: `call-${i}`, name: "echo", input: { text: `slice ${i}` } }),
  ),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
  LLMEvent.finish({ reason: "tool-calls" }),
]

/**
 * The finish the drive judges.
 *
 * 🔴 Confident and caveat-free ON PURPOSE. `shouldReground` refuses to fire on a hedged summary
 * (`containsUnverified`), so a turn that admitted doubt would make the OFF case pass for the wrong
 * reason — silent because the TEXT disqualified it, not because the switch worked.
 */
const confidentFinish = (id: string): LLMEvent[] =>
  completeTurn(id, "All done — every file in the set has been described.")

const runWithDrive = async (label: string, drives?: { reground?: boolean }) => {
  const harness = makeRunnerHarness({
    turns: [
      // The batch sweeps' real shape: a substantial run of tool calls, then a confident summary.
      toolTurn(REGROUND_TOOL_CALLS),
      confidentFinish("finish-1"),
      // The reground RE-PROMPTS, so the runner asks for one more turn. Without this the ON case would
      // fail on an exhausted script rather than on its assertion.
      confidentFinish("finish-2"),
    ],
  })
  if (drives !== undefined) harness.controls.harnessDrives = drives
  let transcript: { type: string; text?: string }[] = []

  await drive(
    harness,
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID: HARNESS_SESSION,
        prompt: Prompt.make({ text: "Describe every file in the set." }),
        resume: false,
      })
      yield* session.resume(HARNESS_SESSION)
      transcript = (yield* session.context(HARNESS_SESSION)) as typeof transcript
    }),
    label,
  )

  const nudges = transcript.filter(
    (message) => message.type === "user" && (message.text ?? "").includes(REGROUND_NUDGE.slice(0, 40)),
  )
  return { transcript, nudges }
}

describe("the runner asks harness_drives before re-grounding", () => {
  // ⭐ THE CONTROL. Everything below is meaningless without it: this is the turn shape the batch
  // sweeps actually produce — a substantial run of tool calls ending in a confident summary — and it
  // proves the drive CAN fire here.
  test("ON (the default): a confident finish after a busy turn is re-grounded", async () => {
    const { nudges } = await runWithDrive("reground default on")
    expect(nudges.length, "the default must still march the model — turning this off is opt-in").toBe(1)
  })

  // 🔴 THE MEASUREMENT THIS EXISTS FOR.
  test("OFF: the same turn is left alone, so an unaided sample is actually unaided", async () => {
    const { nudges } = await runWithDrive("reground off", { reground: false })
    expect(nudges.length, "with the drive off NOTHING may steer the model — this is the baseline").toBe(0)
  })

  // ⚠️ `resolve` reads an absent switch as ON. Pinned here at the call site too, because the OFF test
  // above would pass identically if the runner treated ANY supplied block as "all drives off".
  test("an empty drives block is not read as OFF", async () => {
    const { nudges } = await runWithDrive("reground empty block", {})
    expect(nudges.length).toBe(1)
  })
})
