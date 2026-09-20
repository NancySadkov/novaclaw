import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@novaclaw/core/database/database"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionContextEpochTable } from "@novaclaw/core/session/sql"
import { ContextSnapshotDecodeError } from "@novaclaw/core/session/error"
import { Prompt } from "@novaclaw/core/session/prompt"
import { HARNESS_SESSION, completeTurn, drive, makeRunnerHarness, makeLatch } from "./fixture/runner-harness"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { Tool } from "@novaclaw/core/tool/tool"
import { PromptEstimate } from "@novaclaw/core/session/runner/prompt-estimate"
import { EventV2 } from "@novaclaw/core/event"
import { SessionEvent } from "@novaclaw/core/session/event"

/**
 * The ONE prompt baseline, and what may and may not rewrite it (owner, 2026-09-17).
 *
 * 🔴 The seven claims that used to live here pinned the old behaviour: a durable registry baseline
 * established once, with every later change admitted as a chronological `System` message. That
 * mechanism is retired. The prompt is one epoch source, and `prepareTurn` compares the rendered text
 * with the stored baseline: a changed PROMPT COMPONENT forces a replace, an unchanged one reuses the
 * bytes. The harness's `systemBaseline`/`systemUnavailable` controls drove the retired registry
 * source, which is NOT a prompt component any more — so changing them must not move the prompt. That
 * is what this claim asserts (the component-change case has its own claim in
 * `session-runner-agent.test.ts`).
 */
describe("SessionRunnerLLM — the one prompt baseline", () => {
  test.each(["automatic", "manual"])(
    "%s: a native prefix shrinks from 1M to 4K and stays stable when switching back",
    async (mode) => {
      const harness = makeRunnerHarness({
        turns: [
          completeTurn("large", "First."),
          completeTurn("small", "Second."),
          completeTurn("large-again", "Third."),
        ],
      })
      harness.controls.currentModel = harness.makeModel("large", { context: 1048576, output: 512 })
      await drive(
        harness,
        Effect.gen(function* () {
          const tools = yield* ToolRegistry.Service
          const fake = (description: string) =>
            Tool.make({
              description,
              input: Schema.Struct({}),
              output: Schema.String,
              execute: () => Effect.succeed("ok"),
            })
          yield* tools.register({
            tool_search: fake("Discover tools"),
            tool_call: fake("Call a discovered tool"),
            bulky: fake("long native documentation ".repeat(3000)),
          })
          const session = yield* SessionV2.Service
          for (const [model, context] of [
            ["large", 1048576],
            ["small", 4096],
            ["large-again", 1048576],
          ] as const) {
            harness.controls.currentModel = harness.makeModel(model, { context, output: 512 })
            if (mode === "manual" && context === 4096) {
              const ended = makeLatch()
              const events = yield* EventV2.Service
              const unsubscribe = yield* events.listen((event) => {
                if (event.type === SessionEvent.Compaction.Ended.type) ended.open()
                return Effect.void
              })
              yield* session.compact({ sessionID: HARNESS_SESSION })
              yield* Effect.promise(() => ended.promise)
              yield* unsubscribe
            }
            yield* session.prompt({
              sessionID: HARNESS_SESSION,
              prompt: Prompt.make({ text: "Continue this task." }),
              resume: false,
            })
            yield* session.resume(HARNESS_SESSION)
          }
        }),
        "adaptive native prefix",
      )
      expect(harness.requests).toHaveLength(3)
      expect(harness.requests[0]!.tools.some((tool) => tool.name === "bulky")).toBe(true)
      expect(harness.requests[1]!.tools.some((tool) => tool.name === "bulky")).toBe(false)
      expect(PromptEstimate.whole(harness.requests[1]!) + harness.requests[1]!.generation!.maxTokens!).toBeLessThan(
        4096,
      )
      expect(harness.requests[2]!.tools).toEqual(harness.requests[1]!.tools)
    },
  )
  test("normal dispatch retains a short conversation from 4K through 1M", async () => {
    for (let context = 4096; context <= 1048576; context *= 2) {
      const harness = makeRunnerHarness({
        turns: [completeTurn("first", "I remember cobalt."), completeTurn("second", "cobalt")],
      })
      harness.controls.currentModel = harness.makeModel(`window-${context}`, { context, output: 512 })
      await drive(
        harness,
        Effect.gen(function* () {
          const session = yield* SessionV2.Service
          for (const text of ["Remember the launch code is cobalt.", "What launch code did I give you?"]) {
            yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text }), resume: false })
            yield* session.resume(HARNESS_SESSION)
          }
        }),
        `normal runner at ${context} tokens`,
      )
      expect(harness.requests, `${context}-token window`).toHaveLength(2)
      expect(JSON.stringify(harness.requests[1]!.messages), `${context}-token window`).toContain(
        "Remember the launch code is cobalt.",
      )
      expect(JSON.stringify(harness.requests[1]!.messages)).toContain("I remember cobalt.")
      expect(JSON.stringify(harness.requests[1]!.messages)).toContain("What launch code did I give you?")
    }
  })

  test("a retired ambient source changing does NOT rewrite the prompt on a casual turn", async () => {
    const harness = makeRunnerHarness({ turns: [completeTurn("t1", "One"), completeTurn("t2", "Two")] })

    await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "First" }), resume: false })
        yield* session.resume(HARNESS_SESSION)

        harness.controls.systemBaseline = "Changed context"

        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Second" }), resume: false })
        yield* session.resume(HARNESS_SESSION)
      }),
      "claim — a casual turn cannot rewrite the one prompt",
    )

    const systems = harness.requests.map((request) => (request.system ?? []).map((part) => part.text))
    expect(systems[0]).toHaveLength(1)
    expect(systems[1]).toHaveLength(1)
    // Byte-identical: the prompt was established with the epoch and reused, not re-rendered.
    expect(systems[1]![0]).toBe(systems[0]![0])
    expect(JSON.stringify(systems[1])).not.toContain("Changed context")
  })

  test("starts a real runner turn after default prompt recording", async () => {
    // `prompt` without `resume: false` must itself start the turn. The settle edge is
    // `session.resume`, which JOINS the in-flight drain rather than starting a second one.
    const harness = makeRunnerHarness({ turns: [completeTurn("text-auto", "Done")] })

    const messages = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        const message = yield* session.prompt({
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "Run automatically" }),
        })
        yield* session.resume(HARNESS_SESSION)
        const messages = yield* session.messages({ sessionID: HARNESS_SESSION })
        return { messages, id: message.id }
      }),
      "claim — default prompt recording starts a real turn",
    )

    expect(harness.requests, "recording a prompt the default way must reach the provider once").toHaveLength(1)
    const user = messages.messages.find((message: { type: string }) => message.type === "user")
    expect(user).toMatchObject({ id: messages.id, type: "user", text: "Run automatically" })
  })

  test("fails gracefully when a stored context snapshot cannot be decoded", async () => {
    // A corrupt epoch snapshot — schema drift, a partial write, a hand-edit. The turn must FAIL with a
    // named error and the provider must never be called.
    const harness = makeRunnerHarness({ turns: [completeTurn("t1", "First answer")] })

    const exit = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        const { db } = yield* Database.Service
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "First" }), resume: false })
        yield* session.resume(HARNESS_SESSION)

        yield* db
          .update(SessionContextEpochTable)
          .set({ snapshot: { invalid: { value: "bad" } } })
          .where(eq(SessionContextEpochTable.session_id, HARNESS_SESSION))
          .run()
          .pipe(Effect.orDie)

        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Second" }), resume: false })
        harness.requests.length = 0
        return yield* session.resume(HARNESS_SESSION).pipe(Effect.exit)
      }),
      "claim — an undecodable snapshot fails by name",
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(ContextSnapshotDecodeError)
    expect(harness.requests, "the provider must never see a context nobody could read").toHaveLength(0)
  })
})
