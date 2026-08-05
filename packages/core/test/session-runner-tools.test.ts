import { describe, expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import { LLMEvent } from "@novaclaw/llm"
import { AgentV2 } from "@novaclaw/core/agent"
import { SessionV2 } from "@novaclaw/core/session"
import { Prompt } from "@novaclaw/core/session/prompt"
import { ApplicationTools } from "@novaclaw/core/tool/application-tools"
import { Tool } from "@novaclaw/core/tool/tool"
import { HARNESS_SESSION, drive, makeRunnerHarness } from "./fixture/runner-harness"

/**
 * PORTED CLAIMS — tools the runner did not register itself.
 *
 * Rewritten against the current runner on a harness that runs on **win32** (S3; ledger in
 * `session-runner-claims.test.ts`).
 */

describe("SessionRunnerLLM — application tools", () => {
  test("advertises and executes a globally attached application tool", async () => {
    // An APPLICATION tool is attached outside the session's own registry — the seam an app on the OS
    // uses. The claim has three parts and they are separable: it must be ADVERTISED in the request, it
    // must EXECUTE, and the execution must arrive with a full attribution context. That third part is
    // the one worth guarding: a tool that runs without knowing which session, agent and assistant
    // message invoked it cannot be permission-gated or audited afterwards.
    const contexts: Tool.Context[] = []
    const harness = makeRunnerHarness({
      turns: [
        [
          LLMEvent.stepStart({ index: 0 }),
          LLMEvent.toolCall({ id: "call-application", name: "application_context", input: { query: "hello" } }),
          LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
          LLMEvent.finish({ reason: "tool-calls" }),
        ],
        // The continuation turn. Scripted empty on purpose — this claim is about the tool round trip,
        // not about what the model says afterwards.
        [],
      ],
    })

    const context = await drive(
      harness,
      Effect.gen(function* () {
        const applicationTools = yield* ApplicationTools.Service
        yield* applicationTools.register({
          application_context: Tool.make({
            description: "Read application context",
            input: Schema.Struct({ query: Schema.String }),
            output: Schema.Struct({ answer: Schema.String }),
            execute: ({ query }, toolContext) =>
              Effect.sync(() => {
                contexts.push(toolContext)
                return { answer: query.toUpperCase() }
              }),
          }),
        })
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Use application context" }),
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
        return yield* session.context(HARNESS_SESSION)
      }),
      "claim — globally attached application tool",
    )

    // ① advertised
    expect(harness.requests[0]?.tools.map((tool) => tool.name)).toContain("application_context")
    // ② executed exactly once, with full attribution. This is the claim, so it is asserted on the
    // four fields that ARE the attribution rather than on the whole object — the context has since
    // grown an unrelated `attachmentPaths`, and a claim about who invoked a tool should not break when
    // something else is added beside it.
    expect(contexts).toHaveLength(1)
    expect(contexts[0]).toMatchObject({
      sessionID: HARNESS_SESSION,
      agent: AgentV2.ID.make("build"),
      assistantMessageID: expect.stringMatching(/^msg_/),
      toolCallID: "call-application",
    })
    // …and a separate RATCHET on the shape, kept because a silently-added context field is how an
    // execution stops being fully attributable without anything going red. A new key here is fine —
    // it just has to argue for itself in this list first.
    expect(Object.keys(contexts[0] ?? {}).sort(), "the tool context gained or lost a field").toEqual([
      "agent",
      "assistantMessageID",
      "attachmentPaths",
      "sessionID",
      "toolCallID",
    ])
    // ③ and its result is projected as a completed tool call, carrying the structured output
    expect(context).toMatchObject([
      { type: "user", text: "Use application context" },
      {
        type: "assistant",
        content: [
          { type: "tool", id: "call-application", state: { status: "completed", structured: { answer: "HELLO" } } },
        ],
      },
    ])
  })
})
