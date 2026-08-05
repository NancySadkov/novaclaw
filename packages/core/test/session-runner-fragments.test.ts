import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Stream } from "effect"
import { eq } from "drizzle-orm"
import { LLMError, TransportReason } from "@novaclaw/llm"
import { Database } from "@novaclaw/core/database/database"
import { EventV2 } from "@novaclaw/core/event"
import { EventTable } from "@novaclaw/core/event/sql"
import { SessionV2 } from "@novaclaw/core/session"
import { Prompt } from "@novaclaw/core/session/prompt"
import { SessionRunner } from "@novaclaw/core/session/runner"
import { HARNESS_SESSION, completeTurn, drive, makeLatch, makeRunnerHarness } from "./fixture/runner-harness"
import { fragmentFixture, fragmentID, fragmentKinds, type FragmentKind } from "./fixture/fragments"

/**
 * PORTED CLAIMS — the streamed-fragment lifecycle, over all three fragment kinds.
 *
 * Rewritten against the current runner on a harness that runs on **win32** (S3; ledger in
 * `session-runner-claims.test.ts`). Three declarations, nine tests: each claim is made once and
 * inherited by every kind, so a fourth fragment kind would arrive with all three claims rather than
 * with none.
 */

const providerUnavailable = () =>
  new LLMError({ module: "test", method: "stream", reason: new TransportReason({ message: "Provider unavailable" }) })

describe("SessionRunnerLLM — streamed fragments", () => {
  for (const kind of fragmentKinds) {
    test(`broadcasts provider ${kind} deltas without storing projection rewrites`, async () => {
      // Deltas are EPHEMERAL: they must reach live subscribers and leave no rows behind. Thirty-two
      // deltas produce thirty-two broadcasts and ZERO stored delta events.
      //
      // ⭐ The replay is what makes this a claim about durability rather than about tidiness: after
      // rebuilding the transcript from events alone, the context must be identical. If deltas were
      // load-bearing, dropping them would change the result — so this proves the assembled fragment is
      // what is durable and the deltas are pure transport.
      const chunks = Array.from({ length: 32 }, (_, index) => `${index},`)
      const fixture = fragmentFixture(kind, fragmentID(kind, "many"), chunks)
      // The second turn is scripted for the kinds that draw the re-ground nudge (see below). Leaving it
      // unscripted would make the continuation an EMPTY provider response, which is now a named fault
      // rather than silence — see the empty-response claim in `session-runner-errors.test.ts`.
      const harness = makeRunnerHarness({ turns: [fixture.completeEvents, completeTurn("t2", "Done")] })
      const prompt = `Stream ${kind}`

      const { live, deltaRows, before, after } = await drive(
        harness,
        Effect.gen(function* () {
          const session = yield* SessionV2.Service
          yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: prompt }), resume: false })

          const events = yield* EventV2.Service
          const collected = yield* events
            .subscribe(fixture.delta)
            .pipe(Stream.take(32), Stream.runCollect, Effect.forkScoped)
          yield* Effect.yieldNow

          yield* session.resume(HARNESS_SESSION)

          const { db } = yield* Database.Service
          const deltaRows = yield* db
            .select({ type: EventTable.type })
            .from(EventTable)
            .where(eq(EventTable.type, EventV2.versionedType(fixture.delta.type, 1)))
            .all()
            .pipe(Effect.orDie)
          const before = yield* session.context(HARNESS_SESSION)
          yield* harness.replayProjection(HARNESS_SESSION)
          const after = yield* session.context(HARNESS_SESSION)
          return { live: Array.from(yield* Fiber.join(collected)), deltaRows, before, after }
        }),
        `claim — ${kind} deltas broadcast without being stored`,
      )

      expect(live, "every delta reaches live subscribers").toHaveLength(32)
      expect(deltaRows, "and none of them is persisted").toHaveLength(0)
      // ⚠️ Asserted on the HUMAN pair, not the whole transcript. A `reasoning`-only turn produces no
      // text and no tool call, so the runner correctly appends its "last turn ended with no reply"
      // nudge — and that nudge is **delivered as a `user` message**, not a system one, so filtering by
      // role does not remove it. It has to be excluded by its `[Automated NovaClaw check …]` marker.
      // (Automated notices are lowered to the user role deliberately; see the durable-context claims.)
      // The nudge is correct behaviour, it is just not what this claim is about.
      const pair = (messages: readonly unknown[]) =>
        (messages as Array<{ type: string; text?: string }>).filter(
          (m) =>
            (m.type === "user" || m.type === "assistant") && !String(m.text ?? "").startsWith("[Automated NovaClaw"),
        )
      // Derived, not hard-coded per kind: if the runner nudged, that nudge drew a reply, and it belongs
      // in the expected pair. Asking the transcript whether it was nudged keeps this correct for any
      // kind that starts or stops producing text.
      const nudged = (before as Array<{ text?: string }>).some((message) =>
        String(message.text ?? "").startsWith("[Automated NovaClaw"),
      )
      const expected = [
        { type: "user", text: prompt },
        fixture.expectedAssistant,
        ...(nudged ? [{ type: "assistant", finish: "stop" }] : []),
      ]
      expect(pair(before)).toMatchObject(expected)
      expect(pair(after), "the assembled fragment survives a replay from events alone").toMatchObject(expected)
    })

    test(`durably closes partial ${kind} when the provider stream fails`, async () => {
      // A fragment cut off mid-stream must still be DURABLE, carrying what did arrive plus the failure.
      // Losing the partial content would make a provider outage indistinguishable from a turn that
      // never produced anything.
      const fixture = fragmentFixture(kind, fragmentID(kind, "partial"), ["Partial"])
      const failure = providerUnavailable()
      const harness = makeRunnerHarness({
        turns: [Stream.concat(Stream.fromIterable(fixture.partialEvents), Stream.fail(failure))],
      })
      const prompt = `Fail after ${kind}`

      const context = await drive(
        harness,
        Effect.gen(function* () {
          const session = yield* SessionV2.Service
          yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: prompt }), resume: false })
          expect(yield* session.resume(HARNESS_SESSION).pipe(Effect.flip)).toBe(failure)
          return yield* session.context(HARNESS_SESSION)
        }),
        `claim — partial ${kind} closed durably on stream failure`,
      )

      expect(context).toMatchObject([
        { type: "user", text: prompt },
        {
          type: "assistant",
          finish: "error",
          error: { type: "unknown", message: "Provider unavailable" },
          content: [fixture.expectedContent],
        },
      ])
    })

    test(`durably closes partial ${kind} when the provider stream is interrupted`, async () => {
      // Same as above, reached by INTERRUPTION rather than failure — the stream simply never ends. The
      // runner must still close the fragment rather than leaving it open forever.
      //
      // ⚠️ `tool input` diverges here and it is deliberate: an interrupted tool fragment projects as
      // `status: "error"` instead of keeping its partial input, because a half-parsed tool call is not
      // something a model may be handed back and act on.
      const fixture = fragmentFixture(kind, fragmentID(kind, "interrupted"), ["Partial"])
      const streamed = makeLatch()
      const harness = makeRunnerHarness({
        turns: [
          Stream.concat(
            Stream.fromIterable(fixture.partialEvents),
            Stream.fromEffect(Effect.sync(() => streamed.open())).pipe(Stream.flatMap(() => Stream.never)),
          ),
        ],
      })
      const prompt = `Interrupt after ${kind}`

      const context = await drive(
        harness,
        Effect.gen(function* () {
          const session = yield* SessionV2.Service
          yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: prompt }), resume: false })

          const runner = yield* SessionRunner.Service
          const fiber = yield* runner.run({ sessionID: HARNESS_SESSION, force: true }).pipe(Effect.forkChild)
          yield* Effect.promise(() => streamed.promise)
          yield* Fiber.interrupt(fiber)
          return yield* session.context(HARNESS_SESSION)
        }),
        `claim — partial ${kind} closed durably on interruption`,
      )

      expect(context).toMatchObject([
        { type: "user", text: prompt },
        {
          type: "assistant",
          finish: "error",
          error: { type: "unknown", message: "Provider turn interrupted" },
          content: [
            kind === "tool input"
              ? { type: "tool", id: fragmentID(kind, "interrupted"), state: { status: "error" } }
              : fixture.expectedContent,
          ],
        },
      ])
    })
  }
})
