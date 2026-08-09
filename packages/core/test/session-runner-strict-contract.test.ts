import { afterAll, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { SessionV2 } from "@novaclaw/core/session"
import { Prompt } from "@novaclaw/core/session/prompt"
import { SessionStrict } from "@novaclaw/core/session/runner/strict"
import { AbsolutePath } from "@novaclaw/core/schema"
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
  const roots: string[] = []
  afterAll(() => {
    for (const root of roots)
      try {
        fs.rmSync(root, { recursive: true, force: true })
      } catch {}
  })

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
    expect(route!.providerOptions?.openai, "Strict shares the session prompt-cache identity").toMatchObject({
      promptCacheKey: HARNESS_SESSION,
    })
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
    expect(JSON.stringify(context), "the internal CHAT verdict is never shown as the answer").not.toContain(
      '"text":"CHAT"',
    )
  }, 60_000)

  test("a TASK materializes its action and settles one restorable snapshot boundary", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "novaclaw-strict-contract-"))
    roots.push(directory)
    // The whole-task goal check is evidence-gated: the quote it accepts must exist in the workspace,
    // not merely in another model reply. This control keeps the scripted success honest.
    fs.writeFileSync(path.join(directory, "proof.txt"), "RESULT PROOF-42 done")

    const leaf = {
      size: "atomic",
      tool: "run",
      args: { command: "echo PROOF-42" },
      success: "the command prints the proof marker",
      check: { type: "output_equals", command: "echo PROOF-42", expected: "PROOF-42" },
      produces: [],
    }
    const rootAtomic = JSON.stringify({ goal: "run the proof check", ...leaf })
    const rootPlan = JSON.stringify({
      goal: "run the proof check",
      size: "needs_decomposition",
      success: "the proof check passes",
      substeps: [{ goal: "execute the proof command", ...leaf }],
    })
    const leafPlan = JSON.stringify({ goal: "execute the proof command", ...leaf })
    const achieved = JSON.stringify({ achieved: true, missing: "", evidence: "PROOF-42" })
    const harness = makeRunnerHarness({
      directory: AbsolutePath.make(directory),
      snapshotFiles: ["proof.txt"],
      turns: [
        completeTurn("route-task", "TASK"),
        completeTurn("root-atomic", rootAtomic),
        completeTurn("root-plan", rootPlan),
        completeTurn("leaf-plan", leafPlan),
        completeTurn("goal-check", achieved),
        completeTurn("summary", "The Strict task completed and verified the proof command."),
      ],
    })
    harness.controls.strictEnabled = true

    const context = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Run the proof check" }),
          resume: false,
        })
        yield* session.resume(HARNESS_SESSION)
        return yield* session.context(HARNESS_SESSION)
      }),
      "Strict contract — TASK materialization and settlement",
    )

    expect(harness.requests, "route + root retry + root plan + leaf + goal check + summary").toHaveLength(6)
    for (const request of harness.requests)
      expect(request.providerOptions?.openai, "every Strict completion shares the prompt-cache identity").toMatchObject(
        {
          promptCacheKey: HARNESS_SESSION,
        },
      )
    expect(harness.snapshotCaptures.map(String), "one boundary before and one after the engine").toEqual([
      "snapshot_1",
      "snapshot_2",
    ])
    const assistants = context.filter((message) => message.type === "assistant")
    expect(assistants, "one assistant message owns the whole Strict run").toHaveLength(1)
    expect(assistants[0]).toMatchObject({
      finish: "stop",
      snapshot: { start: "snapshot_1", end: "snapshot_2", files: ["proof.txt"] },
      content: [
        { type: "tool", id: "jh_a1", name: "run", state: { status: "completed" } },
        { type: "text", text: "The Strict task completed and verified the proof command." },
      ],
    })
    expect(JSON.stringify(context), "the internal TASK verdict and plan JSON stay out of chat").not.toContain(
      '"text":"TASK"',
    )
  }, 60_000)
})
