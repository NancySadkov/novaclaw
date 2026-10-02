import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { LLMEvent } from "@novaclaw/llm"
import { Database } from "@novaclaw/core/database/database"
import { Nudge } from "@novaclaw/core/nudge"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionTable } from "@novaclaw/core/session/sql"
import { Prompt } from "@novaclaw/core/session/prompt"
import { HARNESS_SESSION, completeTurn, drive, makeRunnerHarness } from "./fixture/runner-harness"

/**
 * ── THE TOOL-CALL NUDGES AT THEIR CALL SITE — BOTH DIRECTIONS ───────────────────────────────────
 *
 * The Xenia defect (owner report 2026-09-09): a Pure Chat officer whose reply merely ENDED with an
 * intent phrase ("Let me open the first one.") was steered with the announced-tool nudge — a demand
 * to issue a tool call in a session that is offered ZERO tools (`ShortChat.offered` withdraws every
 * name). `short-chat-no-tool-nudges.test.ts` pins the premise and the source gates; THIS file is the
 * behaviour under the real drain, because a gate nobody can watch fire is a gate that can rot.
 *
 * ⚠️ **BOTH DIRECTIONS.** The ON case is the control: it proves
 * this turn shape CAN trigger the nudge at all. Without it, the shortChat silence would be
 * indistinguishable from a broken detector, and "fixed" would mean "disabled for everyone".
 *
 * Asserted on the TRANSCRIPT, not the log: a `Log.event` line says the harness noticed; a steer
 * landing in the model's next request says the model was actually TOLD — which is the claim.
 */

/**
 * A text-only finish whose LAST sentence is the dangling intent — the exact Xenia shape.
 *
 * ⚠️ "open" is deliberately chosen: it matches the announced-tool tail regex but NOT
 * `TextualCall.promisedTool`'s verb list (call/invoke/use/run/execute/apply/write/read/create/edit/
 * define), so the ON case proves the announced arm specifically fired, not the textual-call one.
 */
const announcedFinish = (id: string): LLMEvent[] =>
  completeTurn(id, "Lovely set of files here. Let me open the first one.")

/** The shipped nudge's own text is the source of truth now — the runner no longer injects a constant. */
const ANNOUNCED_TOOL_TEXT = Nudge.defaults().find((nudge) => nudge.id === Nudge.ANNOUNCED_TOOL_ID)!.text

/** The reply to the nudge — calm, final, and matching no detector (it must not re-steer). */
const calmFinish = completeTurn("finish-2", "All covered — nothing further is pending.")

/** The completion an interactive session now must reach: an `exit` the audit accepts. */
const exitTurn = (result: string): LLMEvent[] => [
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolCall({ id: "exit-call", name: "exit", input: { result } }),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
  LLMEvent.finish({ reason: "tool-calls" }),
]

const runShape = async (label: string, pureChat: boolean) => {
  const harness = makeRunnerHarness({
    withExitTool: true,
    // 🔴 An interactive session now self-drives until `exit` (`drive.ts` `INTERACTIVE_CONTINUE`), which
    // is the completion mechanism for a non-chat officer. The reply to the nudge must therefore be
    // followed by the exit the completion path requires; without it `resume` never settles and this
    // claim hangs instead of asserting. (Pure Chat below breaks out early, before the drive, so its
    // extra scripted turns are simply unused.)
    turns: [announcedFinish("finish-1"), calmFinish, exitTurn("nothing further is pending")],
    utilityTurns: [completeTurn("audit", "YES")],
  })
  let transcript: { type: string; text?: string }[] = []
  await drive(
    harness,
    Effect.gen(function* () {
      if (pureChat) {
        // The stance's durable home: the session row's `short_chat` column, which is exactly what
        // `config-resolve` reads (`shortChat: { column: "short_chat", … }`).
        const { db } = yield* Database.Service
        yield* db
          .update(SessionTable)
          .set({ short_chat: true })
          .where(eq(SessionTable.id, HARNESS_SESSION))
          .run()
          .pipe(Effect.orDie)
      }
      const session = yield* SessionV2.Service
      yield* session.prompt({
        sessionID: HARNESS_SESSION,
        prompt: Prompt.make({ text: "Tell me about this folder." }),
        resume: false,
      })
      yield* session.resume(HARNESS_SESSION)
      transcript = (yield* session.context(HARNESS_SESSION)) as typeof transcript
    }),
    label,
  )
  return transcript.filter(
    (message) => message.type === "user" && (message.text ?? "").includes(ANNOUNCED_TOOL_TEXT.slice(0, 40)),
  )
}

describe("the announced-tool recovery respects the tool horizon", () => {
  test("CONTROL — a tool-bearing session ending on an intent phrase IS steered", async () => {
    const nudges = await runShape("announced-on-agent", false)
    expect(nudges.length).toBe(1)
  })

  test("a Pure Chat (shortChat) session ending on the SAME phrase is NOT steered", async () => {
    const nudges = await runShape("announced-on-pure-chat", true)
    expect(nudges.length).toBe(0)
  })
})
