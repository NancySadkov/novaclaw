import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SessionV2 } from "@novaclaw/core/session"
import { Prompt } from "@novaclaw/core/session/prompt"
import { SessionStrict } from "@novaclaw/core/session/runner/strict"
import { HARNESS_SESSION, completeTurn, drive, makeRunnerHarness, userTexts } from "./fixture/runner-harness"

/**
 * The first EXECUTING contract over `runStrictDrain`.
 *
 * The 77-claim runner net describes the normal drain and did not enter Strict at all. That made moving
 * Strict behind the shared runner seam unsafe: a refactor could stop routing, lose the user's task, or
 * consume the router verdict as the visible answer while every existing claim stayed green.
 *
 * This pins the boundary where the two engines meet without pretending to cover the JH engine itself
 * (its pure controller has its own tests): Strict receives the exact pending task in a bounded,
 * tool-free classification request; a CHAT verdict falls through to the normal dispatch exactly once;
 * and only the normal turn settles into the transcript. It is deliberately an end-to-end runner claim,
 * not a source assertion, so extracting the closure has to preserve observable behavior.
 */
describe("SessionRunnerLLM — Strict dispatch contract", () => {
  test("a CHAT verdict routes once, then the shared drain answers and settles the turn", async () => {
    const harness = makeRunnerHarness({
      turns: [completeTurn("route", "CHAT"), completeTurn("answer", "Hello from the normal drain.")],
    })
    harness.controls.strictEnabled = true

    const context = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Hello Strict" }),
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
        return yield* session.context(HARNESS_SESSION)
      }),
      "Strict contract — CHAT falls through to normal dispatch",
    )

    expect(harness.requests, "one Strict route call plus one normal turn").toHaveLength(2)
    const [route, normal] = harness.requests
    expect(route!.tools, "the router classifies only; it cannot act").toHaveLength(0)
    expect(route!.generation?.maxTokens, "the router keeps its bounded classification budget").toBe(
      SessionStrict.ROUTE_TOKENS,
    )
    expect(userTexts(route!), "Strict receives the exact pending task").toEqual(["Hello Strict"])
    expect(normal!.tools.length, "CHAT falls through to the tool-capable shared dispatch").toBeGreaterThan(0)

    expect(context).toMatchObject([
      { type: "user", text: "Hello Strict" },
      {
        type: "assistant",
        finish: "stop",
        content: [{ type: "text", text: "Hello from the normal drain." }],
      },
    ])
    expect(JSON.stringify(context), "the internal CHAT verdict is never shown as the answer").not.toContain('"text":"CHAT"')
  }, 60_000)
})
