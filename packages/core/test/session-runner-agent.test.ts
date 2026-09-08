import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Fiber } from "effect"
import { eq } from "drizzle-orm"
import { AgentV2 } from "@novaclaw/core/agent"
import { EventV2 } from "@novaclaw/core/event"
import { ModelV2 } from "@novaclaw/core/model"
import { ProviderV2 } from "@novaclaw/core/provider"
import { SessionEvent } from "@novaclaw/core/session/event"
import { SessionMessage } from "@novaclaw/core/session/message"
import { Database } from "@novaclaw/core/database/database"
import { SessionV2 } from "@novaclaw/core/session"
import { Prompt } from "@novaclaw/core/session/prompt"
import { ShortChat } from "@novaclaw/core/session/runner/short-chat"
import { SessionTable } from "@novaclaw/core/session/sql"
import { LLMEvent } from "@novaclaw/llm"
import { HARNESS_SESSION, completeTurn, drive, makeLatch, makeRunnerHarness } from "./fixture/runner-harness"

/**
 * PORTED CLAIMS — which agent's system prompt reaches the provider, and in what order.
 *
 * Rewritten against the current runner on a harness that runs on **win32** (S3; ledger in
 * `session-runner-claims.test.ts`, ruling in ). Titles are carried verbatim so the
 * ledger can match them; expectations were re-derived rather than copied — the old fixture counted
 * post-drain memory extraction as an interactive request, so its assertions are not automatically
 * trustworthy.
 *
 * All three make the same claim — the agent's instructions reach the provider and the durable system
 * context follows them. **That ordering is the claim**; the agent identity is what varies.
 *
 * 🔴 **These do NOT assert the old `["<agent>", "Initial context"]` pair, and the reason is the third
 * instance of one pattern.** Measured: the request now carries **five** system parts, not two —
 *
 *   [0] the role-neutral harness         [1] the resolved officer identity
 *   [2] the agent's own system           [3] the project-scope guidance
 *   [4] the durable context + ad-hoc-tool guidance
 *
 * — because the **non-YOLO filesystem instruction** (the unattended-bash ruling) and the
 * **`<tool_catalogue>` manifest** (Tool Scale T1/T2) were both added *after* these tests were written,
 * exactly as post-drain memory extraction was added after the request-count assertions were written.
 * **The suite's expectations encode a tree that has moved on under them.** A port that copies them
 * reports a regression that is not one, and pinning that prose would make every future guidance edit
 * break three agent tests for nothing.
 *
 * So each claim is asserted AS ITS TITLE STATES IT: the agent's system is present, the durable context
 * is present, and the agent's system comes **before** it. Where two agents are configured, the losing
 * one must be **absent** — that is what makes the claim discriminating rather than merely satisfied.
 */

/** The claim these three share, stated once, positionally rather than by exact composition. */
const expectAgentSystemBeforeContext = (parts: readonly string[] | undefined, agentSystem: string) => {
  const texts = parts ?? []
  const agentIndex = texts.indexOf(agentSystem)
  const contextIndex = texts.findIndex((text) => text.startsWith("Initial context"))
  expect(agentIndex, `the system prompt must carry "${agentSystem}"`).toBeGreaterThanOrEqual(0)
  expect(contextIndex, "the system prompt must carry the durable context").toBeGreaterThanOrEqual(0)
  expect(agentIndex, "the agent system must come BEFORE the durable context").toBeLessThan(contextIndex)
}

describe("SessionRunnerLLM — agent system prompt", () => {
  test("projects live officer identity and job brief through ordinary and Short Chat turns", async () => {
    const harness = makeRunnerHarness({
      turns: [
        completeTurn("ordinary", "First"),
        completeTurn("personality-only", "Second"),
        completeTurn("short", "Third"),
      ],
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
            agent.personality = "Calm identity marker."
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

        yield* agents.transform((editor) =>
          editor.update(AgentV2.ID.make("reviewer"), (agent) => {
            agent.personality = "Brisk identity marker."
          }),
        )
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Second" }), resume: false })
        yield* session.resume(HARNESS_SESSION)

        yield* agents.transform((editor) =>
          editor.update(AgentV2.ID.make("reviewer"), (agent) => {
            agent.name = "Aster"
          }),
        )
        yield* db
          .update(SessionTable)
          .set({ short_chat: true })
          .where(eq(SessionTable.id, HARNESS_SESSION))
          .run()
          .pipe(Effect.orDie)
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Third" }), resume: false })
        yield* session.resume(HARNESS_SESSION)
      }),
      "claim — current officer identity survives the Short Chat posture",
    )

    const systems = harness.requests.map((request) => (request.system ?? []).map((part) => part.text))
    expect(systems).toHaveLength(3)
    const ordinary = systems[0]!
    const ordinaryText = ordinary.join("\n")
    expect(ordinaryText.split("Iris")).toHaveLength(2)
    expect(ordinaryText.split("Calm identity marker.")).toHaveLength(2)
    expect(ordinary.indexOf("Review standing job brief.")).toBeGreaterThan(
      ordinary.findIndex((part) => part.includes("<agent_identity>")),
    )
    expect(ordinaryText).toContain("Your superior is Nova")

    const personalityOnly = systems[1]!
    const personalityOnlyText = personalityOnly.join("\n")
    expect(personalityOnlyText.split("Iris")).toHaveLength(2)
    expect(personalityOnlyText.split("Brisk identity marker.")).toHaveLength(2)
    expect(personalityOnlyText).not.toContain("Calm identity marker.")
    expect(personalityOnly).toContain("Review standing job brief.")

    const short = systems[2]!
    const shortText = short.join("\n")
    expect(shortText.split("Aster")).toHaveLength(2)
    expect(shortText.split("Brisk identity marker.")).toHaveLength(2)
    expect(shortText).not.toContain("Iris")
    expect(shortText).not.toContain("Calm identity marker.")
    expect(short).toContain("Review standing job brief.")
    expect(short).toContain(ShortChat.GUIDANCE)
  })

  test("includes the effective default agent system before durable context", async () => {
    const harness = makeRunnerHarness({ turns: [completeTurn("text-build", "Done")] })

    await drive(
      harness,
      Effect.gen(function* () {
        const agent = yield* AgentV2.Service
        yield* agent.transform((editor) =>
          editor.update(AgentV2.ID.make("build"), (agent) => {
            agent.system = "Build agent instructions"
            agent.mode = "primary"
          }),
        )
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "First" }), resume: false })
        yield* session.resume(HARNESS_SESSION)
      }),
      "claim — default agent system before durable context",
    )

    expectAgentSystemBeforeContext(
      harness.requests.at(-1)?.system.map((part) => part.text),
      "Build agent instructions",
    )
  })

  test("uses the configured default agent system for omitted-agent sessions", async () => {
    // The session names no agent, so the editor's DEFAULT decides — and the assistant message must be
    // attributed to that agent, not to `build`.
    const harness = makeRunnerHarness({ turns: [completeTurn("text-reviewer", "Done")] })

    const messages = await drive(
      harness,
      Effect.gen(function* () {
        const agent = yield* AgentV2.Service
        yield* agent.transform((editor) => {
          editor.update(AgentV2.ID.make("build"), (agent) => {
            agent.system = "Build agent instructions"
            agent.mode = "primary"
          })
          editor.update(AgentV2.ID.make("reviewer"), (agent) => {
            agent.system = "Reviewer instructions"
            agent.mode = "primary"
          })
          editor.default(AgentV2.ID.make("reviewer"))
        })
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "First" }), resume: false })
        yield* session.resume(HARNESS_SESSION)
        return yield* session.messages({ sessionID: HARNESS_SESSION })
      }),
      "claim — configured default agent for omitted-agent sessions",
    )

    const system = harness.requests.at(-1)?.system.map((part) => part.text)
    expectAgentSystemBeforeContext(system, "Reviewer instructions")
    expect(system, "the losing agent's system must be ABSENT, not merely later").not.toContain(
      "Build agent instructions",
    )
    expect(messages[0]).toMatchObject({ type: "assistant", agent: "reviewer" })
  })

  test("uses an explicitly selected non-build agent system", async () => {
    // Same expectation as above, reached the other way: the SESSION names the agent, so an explicit
    // selection must beat the default rather than merely agree with it.
    const harness = makeRunnerHarness({ turns: [completeTurn("text-selected", "Done")] })

    const messages = await drive(
      harness,
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const agent = yield* AgentV2.Service
        yield* agent.transform((editor) =>
          editor.update(AgentV2.ID.make("reviewer"), (agent) => {
            agent.system = "Reviewer instructions"
            agent.mode = "primary"
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
        return yield* session.messages({ sessionID: HARNESS_SESSION })
      }),
      "claim — explicitly selected non-build agent",
    )

    const system = harness.requests.at(-1)?.system.map((part) => part.text)
    expectAgentSystemBeforeContext(system, "Reviewer instructions")
    expect(system, "the losing agent's system must be ABSENT, not merely later").not.toContain(
      "Build agent instructions",
    )
    expect(messages[0]).toMatchObject({ type: "assistant", agent: "reviewer" })
  })

  test("keeps the sampled model when selection changes during model resolution", async () => {
    // A model switch published WHILE resolution is in flight must not retroactively change the turn
    // that is already resolving. The turn keeps the model it sampled.
    //
    // ⭐ This is only expressible because the resolution hook runs inside the window: the claim is about
    // WHEN the switch landed relative to the sample, and the request alone cannot show that — a request
    // carrying the old model looks identical whether the switch arrived late or never arrived at all.
    // The hook is what makes the race deterministic instead of hoped-for.
    const harness = makeRunnerHarness({ turns: [completeTurn("t1", "One")] })

    await drive(
      harness,
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const session = yield* SessionV2.Service
        let switched = false
        harness.controls.modelResolveHook = Effect.suspend(() => {
          if (switched) return Effect.void
          switched = true
          return events
            .publish(SessionEvent.ModelSwitched, {
              sessionID: HARNESS_SESSION,
              messageID: SessionMessage.ID.create(),
              timestamp: DateTime.makeUnsafe(1),
              model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("harness") },
            })
            .pipe(Effect.asVoid, Effect.orDie)
        })
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "First" }), resume: false })
        yield* session.resume(HARNESS_SESSION)
      }),
      "claim — the turn keeps the model it sampled",
    )

    expect(
      harness.requests.map((request) => request.model),
      "the in-flight turn keeps its sampled model",
    ).toEqual([harness.model])
  })

  test("keeps the sampled agent when selection changes during observation", async () => {
    // The model-sampling claim's twin, one layer up. An `AgentSwitched` event published WHILE the
    // system context is being loaded must not retroactively change the turn already assembling.
    //
    // ⭐ Asserted through SKILL GUIDANCE rather than the agent name, because guidance is what actually
    // differs downstream: the turn must carry the DEFAULT OFFICER's skills, and must not carry
    // `reviewer`'s. (It was `build` until 2026-08-24, when an unattributed chat stopped falling to a
    // posture — see `AgentV2.DEFAULT_COLLEAGUE_ID`.) A
    // claim asserting only "the agent is still build" would pass on a runner that sampled the agent
    // once but re-derived its guidance afterwards — which is the half that reaches the model.
    const harness = makeRunnerHarness({ turns: [completeTurn("t1", "Done")] })
    harness.controls.skillBaselines.set(AgentV2.DEFAULT_COLLEAGUE_ID, "Build skills")
    harness.controls.skillBaselines.set("reviewer", "Reviewer skills")

    await drive(
      harness,
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const session = yield* SessionV2.Service
        let switched = false
        harness.controls.systemLoadHook = Effect.suspend(() => {
          if (switched) return Effect.void
          switched = true
          return events
            .publish(SessionEvent.AgentSwitched, {
              sessionID: HARNESS_SESSION,
              messageID: SessionMessage.ID.create(),
              timestamp: DateTime.makeUnsafe(1),
              agent: "reviewer",
            })
            .pipe(Effect.asVoid, Effect.orDie)
        })
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "First" }), resume: false })
        yield* session.resume(HARNESS_SESSION)
      }),
      "claim — the turn keeps the agent it sampled",
    )

    const system = (harness.requests[0]?.system ?? []).map((part) => part.text).join("\n")
    expect(system, "the sampled agent's guidance is used").toContain("Build skills")
    expect(system, "the mid-load switch must not reach this turn").not.toContain("Reviewer skills")
  })

  test("updates selected-agent skill guidance after an agent switch", async () => {
    // Switching agent mid-session must change the guidance the model receives — but NOT by rewriting
    // the established prompt prefix. The prefix keeps the sampled agent's skills; the new agent's
    // guidance arrives chronologically, exactly like a changed durable context does.
    //
    // ⭐ That split is the claim, and both halves are asserted. Rewriting the prefix would destroy the
    // prompt cache for the whole session on every switch; NOT delivering the new guidance at all would
    // leave the model acting as the old agent under a new name.
    const harness = makeRunnerHarness({
      turns: [completeTurn("t1", "First answer"), completeTurn("t2", "Second answer")],
    })
    harness.controls.skillBaselines.set(AgentV2.DEFAULT_COLLEAGUE_ID, "Build skills")

    await drive(
      harness,
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "First" }), resume: false })
        yield* session.resume(HARNESS_SESSION)

        harness.controls.skillBaselines.set("reviewer", "Reviewer skills")
        yield* events.publish(SessionEvent.AgentSwitched, {
          sessionID: HARNESS_SESSION,
          messageID: SessionMessage.ID.create(),
          timestamp: DateTime.makeUnsafe(1),
          agent: "reviewer",
        })

        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Second" }), resume: false })
        yield* session.resume(HARNESS_SESSION)
      }),
      "claim — an agent switch updates guidance chronologically",
    )

    const prefixOf = (index: number) => (harness.requests[index]?.system ?? []).map((part) => part.text).join("\n")
    // ① The established prefix is UNCHANGED across the switch.
    expect(prefixOf(0)).toContain("Build skills")
    expect(prefixOf(1), "a switch must not rewrite the prompt prefix").toContain("Build skills")
    expect(prefixOf(1), "…and must not smuggle the new guidance into it either").not.toContain("Reviewer skills")
    // ② The new guidance still REACHES the turn, chronologically.
    const bodyOf = (index: number) =>
      JSON.stringify((harness.requests[index]?.messages ?? []).map((message) => message.content))
    expect(bodyOf(1), "the new agent's guidance arrives as a message").toContain("Reviewer skills")
  })

  test("reloads a model switch before a tool-driven continuation turn", async () => {
    // A model switch published WHILE a tool is executing must take effect on the CONTINUATION turn. The
    // sampled-model claim says an in-flight turn keeps its model; this says the next one does not.
    //
    // ⭐ Together they define the boundary, and neither alone does: one prevents a switch from
    // rewriting work already underway, the other prevents it from being swallowed. A runner that
    // sampled the model once per RUN rather than per TURN would pass the first and fail this — and the
    // user's switch would appear to do nothing until they started a new session.
    const toolsStarted = makeLatch()
    const toolGate = makeLatch()
    const harness = makeRunnerHarness({
      turns: [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-echo", name: "echo", input: { text: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        completeTurn("t2", "Continued"),
      ],
    })
    harness.controls.toolsStarted = toolsStarted
    harness.controls.toolGate = toolGate

    await drive(
      harness,
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Echo this" }), resume: false })

        const run = yield* session.resume(HARNESS_SESSION).pipe(Effect.forkChild)
        yield* Effect.promise(() => toolsStarted.promise)

        // The world changes while the tool is mid-execution.
        yield* events.publish(SessionEvent.ModelSwitched, {
          sessionID: HARNESS_SESSION,
          messageID: SessionMessage.ID.create(),
          timestamp: DateTime.makeUnsafe(1),
          model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("harness") },
        })
        harness.controls.systemBaseline = "Replacement context"

        toolGate.open()
        yield* Fiber.join(run)
      }),
      "claim — a continuation turn reloads the switched model",
    )

    expect(harness.requests).toHaveLength(2)
    expect(
      harness.requests.map((request) => request.model),
      "the in-flight turn keeps its model; the continuation picks up the switch",
    ).toEqual([harness.model, harness.replacementModel])
    // The prefix is NOT rewritten by the switch — the new context arrives chronologically instead.
    const secondBody = JSON.stringify((harness.requests[1]?.messages ?? []).map((message) => message.content))
    expect(secondBody, "the changed context reaches the continuation as a message").toContain("Replacement context")
  })
})
