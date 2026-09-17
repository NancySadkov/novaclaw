import { describe, expect, test } from "bun:test"
import { Cause, Effect, Exit } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@novaclaw/core/database/database"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionContextEpochTable } from "@novaclaw/core/session/sql"
import { ContextSnapshotDecodeError } from "@novaclaw/core/session/error"
import { Prompt } from "@novaclaw/core/session/prompt"
import { HARNESS_SESSION, completeTurn, drive, makeRunnerHarness } from "./fixture/runner-harness"

/**
 * The ONE prompt baseline, and what may and may not rewrite it (owner, 2026-09-17).
 *
 * 🔴 The seven claims that used to live here pinned the old behaviour: a durable registry baseline
 * established once, with every later change admitted as a chronological `System` message. That
 * mechanism is retired — the prompt is one epoch source whose comparator is always equivalent, so a
 * casual turn reuses it verbatim and only a new session or a completed compaction regenerates it.
 * The harness's `systemBaseline`/`systemUnavailable` controls drove the retired registry source; they
 * no longer reach the prompt, which is what these claims now assert.
 */
describe("SessionRunnerLLM — the one prompt baseline", () => {
  test("a world change under the session does NOT rewrite the prompt on a casual turn", async () => {
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
