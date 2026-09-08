import { describe, expect, test } from "bun:test"
import { Cause, DateTime, Effect, Exit } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@novaclaw/core/database/database"
import { EventV2 } from "@novaclaw/core/event"
import { Location } from "@novaclaw/core/location"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionEvent } from "@novaclaw/core/session/event"
import { SessionInput } from "@novaclaw/core/session/input"
import { Prompt } from "@novaclaw/core/session/prompt"
import { SessionContextEpochTable } from "@novaclaw/core/session/sql"
import { HARNESS_SESSION, completeTurn, drive, makeRunnerHarness } from "./fixture/runner-harness"

/**
 * PORTED CLAIM — a session that MOVES leaves its old location behind, mid-flight.
 *
 * Rewritten against the current runner on a harness that runs on **win32** (S3; ledger in
 * `session-runner-claims.test.ts`). The last of the 77.
 *
 * ⭐ **Three things have to happen together, and each one alone is a plausible half-implementation.**
 * A session lives in a location; its runner, its durable context epoch and its pending input all belong
 * to that location. When it moves:
 *
 *   ① the source runner STOPS — interrupted, not failed. Nothing broke; the work simply is not this
 *     location's any more. A runner that kept draining would answer from the old working directory,
 *     with the old context, after the user asked for it somewhere else.
 *   ② the durable context epoch is DROPPED. It describes an environment the session has left, and
 *     keeping it would silently pin the old directory into every future prompt — the failure that looks
 *     like nothing at all, because the request still has a perfectly well-formed context.
 *   ③ the pending input SURVIVES as steer. It is the user's message; a move must relocate it, not
 *     consume it. Dropping it is how a prompt disappears during an operation the user thought was
 *     bookkeeping.
 *
 * ① without ③ eats the message. ① without ② moves the session but not its idea of where it is.
 *
 * ⚠️ This does NOT boot a second Location. The destination is a bare `Location.Ref` — the claim is
 * about what the SOURCE does when told its session has left, and building a live destination would test
 * the harness rather than the runner.
 */

describe("SessionRunnerLLM — a session that moves", () => {
  test("interrupts a source Location runner after a Session moves", async () => {
    const harness = makeRunnerHarness({ turns: [completeTurn("t1", "One")] })

    const { epoch, exit, pending } = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        const events = yield* EventV2.Service
        const { db } = yield* Database.Service

        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "First" }), resume: false })
        yield* session.resume(HARNESS_SESSION)
        harness.requests.length = 0

        yield* events.publish(SessionEvent.Moved, {
          sessionID: HARNESS_SESSION,
          timestamp: DateTime.makeUnsafe(1),
          location: Location.Ref.make({ directory: AbsolutePath.make("/moved") }),
        })
        const epoch = yield* db
          .select()
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, HARNESS_SESSION))
          .get()

        // The user prompts again — at the source, which no longer owns this session.
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Second" }), resume: false })
        const exit = yield* session.resume(HARNESS_SESSION).pipe(Effect.exit)

        return { epoch, exit, pending: yield* SessionInput.hasPending(db, HARNESS_SESSION, "steer") }
      }),
      "claim — a moved session stops its source runner",
    )

    // ② the epoch describing the old environment is gone
    expect(epoch, "the durable context epoch does not survive the move").toBeUndefined()
    // ① interrupted, not failed
    expect(Exit.isFailure(exit), "the source runner stops").toBe(true)
    if (Exit.isFailure(exit))
      expect(
        Cause.hasInterruptsOnly(exit.cause),
        "INTERRUPTED — a move is not a malfunction, and reporting it as one would be ruling 2 backwards",
      ).toBe(true)
    expect(harness.requests, "the second prompt never reaches the provider from here").toHaveLength(0)
    // ③ the message is relocated, not consumed
    expect(pending, "the user's prompt is still pending for the destination to pick up").toBe(true)
  })
})
