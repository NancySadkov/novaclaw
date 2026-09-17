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
 * turn now carries exactly ONE `role: "system"` message, and it is frozen for the life of the
 * context epoch — regenerated only at a new session and after a compaction.
 *
 * The second half is the claim that would silently rot otherwise: a mid-session job-brief edit must
 * NOT change the prompt, because a casual turn may never rebuild it.
 */
describe("SessionRunnerLLM — the one system prompt", () => {
  test("an officer's identity and job instructions are one system message, frozen for the epoch", async () => {
    const harness = makeRunnerHarness({ turns: [completeTurn("ordinary", "First"), completeTurn("second", "Second")] })

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

        // A mid-session edit to the brief. The epoch prompt must not move for it.
        yield* agents.transform((editor) =>
          editor.update(AgentV2.ID.make("reviewer"), (agent) => {
            agent.system = "A DIFFERENT brief that must not reach this epoch."
          }),
        )
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Second" }), resume: false })
        yield* session.resume(HARNESS_SESSION)
      }),
      "claim — the one system prompt carries identity and brief, and a casual turn cannot change it",
    )

    const systems = harness.requests.map((request) => (request.system ?? []).map((part) => part.text))
    expect(systems.length).toBeGreaterThanOrEqual(2)
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

    const last = systems.at(-1)![0]!
    expect(last).toContain("Review standing job brief.")
    expect(last).not.toContain("A DIFFERENT brief")
  })
})
