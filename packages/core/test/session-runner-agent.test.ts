import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { AgentV2 } from "@novaclaw/core/agent"
import { Database } from "@novaclaw/core/database/database"
import { SessionV2 } from "@novaclaw/core/session"
import { Prompt } from "@novaclaw/core/session/prompt"
import { SessionTable } from "@novaclaw/core/session/sql"
import { HARNESS_SESSION, completeTurn, drive, makeRunnerHarness } from "./fixture/runner-harness"

/**
 * THE ONE SYSTEM PROMPT (owner, 2026-09-17).
 *
 * The old assertion was a five-part system array (role-neutral baseline, officer identity, the
 * agent's own system, project scope, durable context). `PromptManager` retires that: every officer
 * turn now carries exactly ONE `role: "system"` message.
 *
 * Two claims, and they are the two halves of the cadence:
 *   · a CHANGED component (the job brief) regenerates the prompt on the next turn — it must not wait
 *     for a compaction, or the session sends stale text and every inspector shows it;
 *   · an UNCHANGED component leaves it byte-identical, because `prepareTurn` only forces a replace
 *     when the rendered prompt actually differs, so a casual turn keeps the server's prefix cache.
 */
describe("SessionRunnerLLM — the one system prompt", () => {
  test("a component change regenerates the prompt next turn; no change reuses it byte-for-byte", async () => {
    const harness = makeRunnerHarness({
      turns: [completeTurn("ordinary", "First"), completeTurn("second", "Second"), completeTurn("third", "Third")],
    })

    await drive(
      harness,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const agents = yield* AgentV2.Service
        yield* agents.transform((editor) =>
          editor.update(AgentV2.ID.make("reviewer"), (agent) => {
            agent.name = "Iris"
            agent.title = "Reviewer"
            agent.system = "Review standing job brief."
            agent.mode = "primary"
            agent.shortChat = false
          }),
        )
        yield* db
          .update(SessionTable)
          .set({ agent: "reviewer" })
          .where(eq(SessionTable.id, HARNESS_SESSION))
          .run()
          .pipe(Effect.orDie)
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "First" }), resume: false })
        yield* session.resume(HARNESS_SESSION)

        // A component changes (the brief). The next turn MUST carry the new text.
        yield* agents.transform((editor) =>
          editor.update(AgentV2.ID.make("reviewer"), (agent) => {
            agent.system = "A DIFFERENT brief that the next turn must carry."
          }),
        )
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Second" }), resume: false })
        yield* session.resume(HARNESS_SESSION)

        // Nothing changes. The prompt must be byte-identical to the previous turn's.
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Third" }), resume: false })
        yield* session.resume(HARNESS_SESSION)
      }),
      "claim — a changed component regenerates the prompt; an unchanged turn reuses it",
    )

    const systems = harness.requests.map((request) => (request.system ?? []).map((part) => part.text))
    expect(systems.length).toBeGreaterThanOrEqual(3)
    for (const system of systems) {
      // ONE monolithic system message, never a part array.
      expect(system).toHaveLength(1)
    }
    const first = systems[0]![0]!
    expect(first).toContain("Your name is Iris")
    expect(first).toContain("Your job title is Reviewer")
    expect(first).toContain("Job Instructions: Review standing job brief.")
    expect(first).toContain("Your superior is Nova")
    // The identity block that duplicated the brief is gone.
    expect(first).not.toContain("personality and standing instructions")

    const second = systems[1]![0]!
    expect(second, "a changed job brief did not reach the next turn's prompt").toContain(
      "A DIFFERENT brief that the next turn must carry.",
    )
    expect(second).not.toContain("Job Instructions: Review standing job brief.")

    const third = systems[2]![0]!
    expect(third, "an unchanged turn re-rendered the prompt instead of reusing the bytes").toBe(second)
  })
})
