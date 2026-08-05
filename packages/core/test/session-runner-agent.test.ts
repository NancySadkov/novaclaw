import { describe, expect, test } from "bun:test"
import { DateTime, Effect } from "effect"
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
import { SessionTable } from "@novaclaw/core/session/sql"
import { HARNESS_SESSION, completeTurn, drive, makeRunnerHarness } from "./fixture/runner-harness"

/**
 * PORTED CLAIMS — which agent's system prompt reaches the provider, and in what order.
 *
 * Rewritten against the current runner on a harness that runs on **win32** (S3; ledger in
 * `session-runner-claims.test.ts`, ruling in todo/v0.2.0-prep.md). Titles are carried verbatim so the
 * ledger can match them; expectations were re-derived rather than copied — the old fixture counted
 * post-drain memory extraction as an interactive request, so its assertions are not automatically
 * trustworthy.
 *
 * All three make the same claim — the agent's instructions reach the provider and the durable system
 * context follows them. **That ordering is the claim**; the agent identity is what varies.
 *
 * 🔴 **These do NOT assert the old `["<agent>", "Initial context"]` pair, and the reason is the third
 * instance of one pattern.** Measured: the request now carries **four** system parts, not two —
 *
 *   [0] the base Nova persona            [1] the agent's own system
 *   [2] the project-scope guidance       [3] the durable context + ad-hoc-tool guidance
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

    expectAgentSystemBeforeContext(harness.requests.at(-1)?.system.map((part) => part.text), "Build agent instructions")
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
    const harness = makeRunnerHarness({ turns: [[]] })

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

    expect(harness.requests.map((request) => request.model), "the in-flight turn keeps its sampled model").toEqual([
      harness.model,
    ])
  })
})
