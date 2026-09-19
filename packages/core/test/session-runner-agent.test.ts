import { describe, expect, test } from "bun:test"
import { DateTime, Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { eq } from "drizzle-orm"
import { AgentV2 } from "@novaclaw/core/agent"
import { Database } from "@novaclaw/core/database/database"
import { SessionV2 } from "@novaclaw/core/session"
import { Prompt } from "@novaclaw/core/session/prompt"
import { SessionComponentRegistry } from "@novaclaw/core/session/component-registry"
import { Durable } from "@novaclaw/core/session/durable"
import { SessionTable } from "@novaclaw/core/session/sql"
import { SessionEvent } from "@novaclaw/core/session/event"
import { SessionMessage } from "@novaclaw/core/session/message"
import { EventV2 } from "@novaclaw/core/event"
import { Scratch } from "@novaclaw/core/scratch"
import { AbsolutePath } from "@novaclaw/core/schema"
import { tmpdir } from "./fixture/tmpdir"
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
  test("file and work-log changes stay frozen through turns and settings edits, then refresh at compaction", async () => {
    await using project = await tmpdir()
    await fs.writeFile(path.join(project.path, "initial.txt"), "first")
    const agentID = AgentV2.ID.make("prefix_reviewer")
    const scratch = Scratch.forAgent(String(agentID))
    const logs = [1, 2].map((n) => path.join(scratch, "tmp", `oldlog-9999-${Date.now()}-${n}.json`))
    await fs.mkdir(path.dirname(logs[0]!), { recursive: true })
    await fs.writeFile(logs[0]!, "{}")
    const harness = makeRunnerHarness({
      directory: AbsolutePath.make(project.path),
      turns: [1, 2, 3, 4].map((n) => completeTurn(`turn-${n}`, `Answer ${n}`)),
    })
    try {
      await drive(
        harness,
        Effect.gen(function* () {
          const { db } = yield* Database.Service
          const agents = yield* AgentV2.Service
          const session = yield* SessionV2.Service
          const events = yield* EventV2.Service
          yield* agents.transform((editor) =>
            editor.update(agentID, (agent) => {
              agent.system = "Initial job brief."
              agent.mode = "primary"
              agent.shortChat = false
            }),
          )
          yield* db
            .update(SessionTable)
            .set({ agent: String(agentID) })
            .where(eq(SessionTable.id, HARNESS_SESSION))
            .run()
            .pipe(Effect.orDie)
          const turn = (text: string) =>
            session
              .prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text }), resume: false })
              .pipe(Effect.andThen(session.resume(HARNESS_SESSION)))
          yield* turn("First")
          yield* Effect.promise(() => fs.writeFile(path.join(project.path, "new-file.txt"), "new"))
          yield* Effect.promise(() => fs.writeFile(logs[1]!, "{}"))
          yield* turn("Second")
          yield* agents.transform((editor) =>
            editor.update(agentID, (agent) => {
              agent.system = "Updated job brief."
            }),
          )
          yield* turn("Third")
          yield* events.publish(SessionEvent.Compaction.Ended, {
            sessionID: HARNESS_SESSION,
            messageID: SessionMessage.ID.create(),
            timestamp: yield* DateTime.now,
            reason: "auto",
            text: "The first three exchanges are summarized.",
            recent: "",
            ...(yield* harness.currentPrefix),
          })
          yield* turn("Fourth")
        }),
        "prompt observations belong to the context epoch",
      )
      const systems = harness.requests.map((request) => (request.system ?? []).map((part) => part.text).join("\n"))
      expect(systems).toHaveLength(4)
      expect(systems[0]).toContain("initial.txt")
      expect(systems[0]).toContain(path.basename(logs[0]!))
      expect(systems[1]).toBe(systems[0])
      expect(systems[2]).toContain("Updated job brief.")
      expect(systems[2]).not.toContain("new-file.txt")
      expect(systems[2]).toContain(path.basename(logs[0]!))
      expect(systems[3]).toContain("new-file.txt")
      expect(systems[3]).toContain(path.basename(logs[1]!))
    } finally {
      for (const log of logs) await fs.rm(log, { force: true })
    }
  })

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

  test("a memo write waits for the rewrite: the shadow changes no prompt, the materialised area appears", async () => {
    // 🔴 The regression this pins (owner, 2026-09-19): `renderPrompt` read the live `durable` items, so
    // every `memo_set`/`memo_clear` changed the system prompt on the next turn and threw away the
    // provider's prefix cache. The block the model reads is the kernel's `durable_prompt` copy, written
    // only at a context rewrite; until then the memo is still in the transcript the agent can see.
    const harness = makeRunnerHarness({
      turns: [completeTurn("first", "First"), completeTurn("second", "Second"), completeTurn("third", "Third")],
    })

    await drive(
      harness,
      Effect.gen(function* () {
        const components = yield* SessionComponentRegistry.Service
        const { db } = yield* Database.Service
        const agents = yield* AgentV2.Service
        yield* agents.transform((editor) =>
          editor.update(AgentV2.ID.make("reviewer"), (agent) => {
            agent.name = "Iris"
            agent.title = "Reviewer"
            agent.system = "Memo standing job brief."
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

        // The agent writes the SHADOW. No rewrite has happened, so the prompt must not move.
        yield* components.put({
          sessionID: HARNESS_SESSION,
          kind: "durable",
          id: "path",
          value: { name: "Path", value: "C:/books" },
        })
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Second" }), resume: false })
        yield* session.resume(HARNESS_SESSION)

        // The rewrite materialises the area from the shadow. Now the prompt carries it.
        yield* components.put({
          sessionID: HARNESS_SESSION,
          kind: "durable_prompt",
          value: { text: Durable.render([{ id: "path", name: "Path", value: "C:/books" }]) },
          system: true,
        })
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Third" }), resume: false })
        yield* session.resume(HARNESS_SESSION)
      }),
      "claim — a memo write waits for the rewrite",
    )

    const systems = harness.requests.map((request) => (request.system ?? []).map((part) => part.text).join("\n"))
    const first = systems[0]!
    const second = systems[1]!
    const third = systems[2]!
    expect(first).not.toContain("# memo_set memos")
    expect(second, "a memo write reached the prompt before the rewrite").toBe(first)
    expect(third, "the materialised memo area did not reach the post-rewrite prompt").toContain("# memo_set memos")
    expect(third).toContain("Path: C:/books")
  })
})
