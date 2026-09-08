import { describe, expect, test } from "bun:test"
import { Cause, DateTime, Effect, Exit } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@novaclaw/core/database/database"
import { EventTable } from "@novaclaw/core/event/sql"
import { SessionV2 } from "@novaclaw/core/session"
import { EventV2 } from "@novaclaw/core/event"
import { ModelV2 } from "@novaclaw/core/model"
import { ProviderV2 } from "@novaclaw/core/provider"
import { SessionEvent } from "@novaclaw/core/session/event"
import { SessionInput } from "@novaclaw/core/session/input"
import { SessionMessage } from "@novaclaw/core/session/message"
import { SessionContextEpochTable } from "@novaclaw/core/session/sql"
import { SystemContext } from "@novaclaw/core/system-context"
import { ContextSnapshotDecodeError } from "@novaclaw/core/session/error"
import { Prompt } from "@novaclaw/core/session/prompt"
import {
  HARNESS_SESSION,
  completeTurn,
  SYSTEM_CONTEXT_REMOVED_MESSAGE,
  drive,
  makeRunnerHarness,
  messageRoles,
} from "./fixture/runner-harness"

/**
 * PORTED CLAIMS — what happens to durable system context when the world changes UNDER a session.
 *
 * Rewritten against the current runner on a harness that runs on **win32** (S3; ledger in
 * `session-runner-claims.test.ts`). These are the first ported claims that need the world to change
 * *between* turns, which is what `harness.controls` exists for.
 *
 * ⚠️ **These do NOT assert the whole system array, and the reason is now a rule.** The old tests pinned
 * it to a single element (`["Initial context"]`). The request now carries several parts — a base
 * persona, the agent's system, the project-scope guidance — none of which existed when these were
 * written. So each claim asserts the part it is ABOUT and ignores the rest; see
 * `session-runner-agent.test.ts` for the same treatment and the measurement behind it.
 */

/** The durable-context part, located by content rather than by index. */
const durableContext = (parts: readonly { text: string }[] | undefined) =>
  (parts ?? [])
    .map((part) => part.text)
    .find((text) => text.startsWith("Initial context") || text.startsWith("Replacement context"))

describe("SessionRunnerLLM — durable system context", () => {
  test("admits removed context as a chronological System message", async () => {
    // A producer that disappears must be ANNOUNCED in the transcript, not silently dropped —
    // ruling 2's "an unavailable subsystem names itself" at the context layer.
    //
    // 🔴 **The old expectation was `["user","user","system"]` and the runner now says
    // `["user","user","user"]` — that is a BEHAVIOUR CHANGE, not a regression, and it is why this claim
    // had to be re-derived rather than copied.** Measured: the notice is still admitted chronologically
    // and still names the source, but it is **lowered to a `user` role on the wire** and carries an
    // explicit `[Automated NovaClaw check — not a message from your user.]` prefix. Internally it is
    // still a system message (`session.messages()` reports type `system`); only the wire role changed.
    // That matters beyond this test: **a provider that rejects mid-conversation system roles would
    // otherwise break every context notice**, and the prefix is what stops the model reading an
    // automated notice as something its user said.
    //
    // So this asserts what the runner actually guarantees — the notice arrives, names the source, and
    // is framed as automated — rather than a wire role that is an implementation choice.
    // ⚠️ Real turns are SCRIPTED deliberately. This claim used to run on the harness default — no
    // turns at all — and passed only because an empty provider stream was silently swallowed. That was
    // the drain defect (fixed 2026-08-05); now an empty stream is a named fault, and a claim that is
    // not about failure must script a response. See `session-runner-errors.test.ts`.
    const harness = makeRunnerHarness({ turns: [completeTurn("t1", "One"), completeTurn("t2", "Two")] })

    const messages = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "First" }), resume: false })
        yield* session.resume(HARNESS_SESSION)

        harness.controls.systemRemoved = true

        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Second" }), resume: false })
        yield* session.resume(HARNESS_SESSION)
        return yield* session.messages({ sessionID: HARNESS_SESSION })
      }),
      "claim — removed context becomes a System message",
    )

    const second = harness.requests[1]
    // Both user turns, the first turn's assistant reply, and the removal notice last.
    expect(second?.messages, "both user turns, the first reply, and the removal notice").toHaveLength(4)
    const notice = JSON.stringify(second?.messages.at(-1)?.content)
    expect(notice, "the notice must name the source that went away").toContain(SYSTEM_CONTEXT_REMOVED_MESSAGE)
    expect(notice, "and must be framed as automated, not as something the user said").toContain(
      "not a message from your user",
    )
    // It is a SYSTEM message in the session's own record even though the wire lowers it to `user`.
    expect((messages as Array<{ type: string }>).filter((message) => message.type === "system")).toHaveLength(1)
    // The notice is ONE extra message in a two-turn transcript — it does not replace a turn or fold
    // into one. Stated as a composition rather than a bare literal so the reason survives.
    //
    // 🔴 ⚠️ **`session.messages()` is NEWEST-FIRST; `session.context()` is OLDEST-FIRST.** Measured by
    // message id 2026-08-05 (they are ULIDs, and this list's descend). Nothing else in this file
    // notices, because every other claim reads `context()`. I briefly filed the difference as a
    // record-vs-wire ordering DEFECT and it was nothing of the kind — reversed, the notice sits exactly
    // where the request puts it, immediately after the prompt that followed the removal.
    //
    // Asserted in the API's own order rather than reversed-then-compared, so the next reader meets the
    // convention head-on instead of inheriting my mistake.
    expect(
      (messages as Array<{ type: string }>).map((message) => message.type),
      "newest first: the second reply, the notice, the second prompt, the first reply, the first prompt",
    ).toEqual(["assistant", "system", "user", "assistant", "user"])
  })

  test("preserves the baseline while context is temporarily unavailable", async () => {
    // Three turns: normal, unavailable, then a CHANGED baseline. The baseline must survive ALL THREE.
    //
    // ⚠️ The third turn is the counter-intuitive one and it is the claim, not a bug: after
    // `systemBaseline` genuinely changes, the request still carries "Initial context". A baseline is
    // established ONCE; later changes are admitted as chronological System messages instead of
    // rewriting the prompt prefix. (I first asserted the opposite here — that a real change is picked
    // up — which contradicts this claim's own title, and the runner was right.) That design is what
    // keeps the prompt prefix cacheable across a session.
    const harness = makeRunnerHarness()

    await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "First" }), resume: false })
        yield* session.resume(HARNESS_SESSION)

        harness.controls.systemUnavailable = true
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Second" }), resume: false })
        yield* session.resume(HARNESS_SESSION)

        harness.controls.systemUnavailable = false
        harness.controls.systemBaseline = "Replacement context"
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Third" }), resume: false })
        yield* session.resume(HARNESS_SESSION)
      }),
      "claim — baseline survives an unavailable window",
    )

    expect(harness.requests).toHaveLength(3)
    expect(durableContext(harness.requests[0]?.system), "turn 1 carries the baseline").toMatch(/^Initial context/)
    expect(
      durableContext(harness.requests[1]?.system),
      "an unavailable producer must not destroy the established baseline",
    ).toMatch(/^Initial context/)
    expect(
      durableContext(harness.requests[2]?.system),
      "a changed baseline must NOT rewrite the established prompt prefix",
    ).toMatch(/^Initial context/)
  })

  test("reuses one durable baseline after the context producer changes", async () => {
    // The complement of the claim above: when the producer genuinely changes, the prompt PREFIX still
    // carries the original baseline and the new value arrives as a chronological message. The
    // load-bearing assertion is the event count — exactly ONE `context.updated`, i.e. the baseline was
    // established once and reused, not rebuilt per turn. Rebuilding it every turn would be invisible in
    // the transcript and would silently destroy prompt-cache hits on every single request.
    //
    // ⚠️ Turns are scripted for the same reason as the claim above — this ran on empty streams and
    // passed only because the drain swallowed them.
    const harness = makeRunnerHarness({ turns: [completeTurn("t1", "One"), completeTurn("t2", "Two")] })

    const { messages, updates, replayed } = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "First" }), resume: false })
        yield* session.resume(HARNESS_SESSION)

        harness.controls.systemBaseline = "Changed context"

        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Second" }), resume: false })
        yield* session.resume(HARNESS_SESSION)

        const messages = yield* session.messages({ sessionID: HARNESS_SESSION })
        const { db } = yield* Database.Service
        const updates = yield* db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(eq(EventTable.type, "session.next.context.updated.1"))
          .all()
          .pipe(Effect.orDie)

        // The transcript must be derivable from the events alone.
        yield* harness.replayProjection(HARNESS_SESSION)
        const replayed = yield* session.messages({ sessionID: HARNESS_SESSION })
        return { messages, updates, replayed }
      }),
      "claim — one durable baseline reused after the producer changes",
    )

    expect(durableContext(harness.requests[0]?.system), "turn 1 establishes the baseline").toMatch(/^Initial context/)
    expect(
      durableContext(harness.requests[1]?.system),
      "the established prefix is REUSED, not rebuilt from the new value",
    ).toMatch(/^Initial context/)
    expect(updates, "the baseline must be established once, not per turn").toHaveLength(1)

    const notice = JSON.stringify(harness.requests[1]?.messages.at(-1)?.content)
    expect(notice, "the new value arrives chronologically instead").toContain("Changed context")
    // Compared against the PRE-replay count rather than a literal — the claim is FIDELITY, and a
    // literal here would make every future change to what the runner records look like a replay bug.
    expect(replayed, "the transcript must be rebuildable from events alone").toHaveLength(messages.length)
  })

  test("retries the first provider turn after system context becomes available", async () => {
    // If context cannot be built at all, the FIRST turn must not go out half-formed. The claim has four
    // parts and each is a separate way to get this wrong: the drain fails rather than proceeding, the
    // provider is never called, the prompt is preserved as pending steer input, and no context epoch is
    // committed. Then, once context is available, the same prompt goes through as a single user turn —
    // not duplicated, which is what preserving the input naively would cause.
    const harness = makeRunnerHarness()
    const messageID = SessionMessage.ID.create()

    const observed = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        const { db } = yield* Database.Service

        harness.controls.systemUnavailable = true
        yield* session.prompt({
          id: messageID,
          sessionID: HARNESS_SESSION,
          prompt: Prompt.make({ text: "First" }),
          resume: false,
        })

        const exit = yield* session.resume(HARNESS_SESSION).pipe(Effect.exit)
        const pending = yield* SessionInput.hasPending(db, HARNESS_SESSION, "steer")
        const epoch = yield* db
          .select()
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, HARNESS_SESSION))
          .get()
          .pipe(Effect.orDie)
        const requestsWhileBlocked = harness.requests.length

        harness.controls.systemUnavailable = false
        yield* session.prompt({ id: messageID, sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "First" }) })
        // ⭐ THE SETTLE POINT. `prompt` with the default `resume` starts the turn but does NOT await
        // it — measured, `requests` is still 0 when it returns. `session.resume` JOINS the in-flight
        // drain rather than starting a second one (measured: 0 -> 1, not 0 -> 2), so it is the "the
        // turn you just started has settled" edge, and asserting without it is a race.
        yield* session.resume(HARNESS_SESSION)

        return { exit, pending, epoch, requestsWhileBlocked }
      }),
      "claim — first turn retried once context becomes available",
    )

    expect(Exit.isFailure(observed.exit), "a turn with no context must FAIL, not proceed").toBe(true)
    if (Exit.isFailure(observed.exit)) {
      expect(Cause.squash(observed.exit.cause)).toBeInstanceOf(SystemContext.InitializationBlocked)
    }
    expect(observed.requestsWhileBlocked, "the provider must never be called without context").toBe(0)
    expect(observed.pending, "the prompt must survive as pending steer input").toBe(true)
    expect(observed.epoch, "no context epoch may be committed for a turn that never ran").toBeUndefined()

    expect(harness.requests, "the retry goes out exactly once").toHaveLength(1)
    expect(messageRoles(harness.requests[0]!), "and not duplicated").toEqual(["user"])
  })

  test("starts a real runner turn after default prompt recording", async () => {
    // `prompt` without `resume: false` must itself start the turn — recording a prompt the default way
    // reaches the provider rather than sitting there.
    //
    // ⚠️ **This claim was left unported for a day because its original assertion is a RACE.** The old
    // test asserts `requests` has length 1 on the line after `prompt`, but the default-resume path
    // starts the turn without awaiting it: measured, `requests` is still 0 when `prompt` returns. The
    // settle edge is `session.resume`, which JOINS the in-flight drain instead of starting a second one
    // (0 -> 1, not 0 -> 2). So the claim is true and its old assertion was merely lucky about timing.
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
    // A corrupt context snapshot in the database — schema drift, a partial write, a hand-edit. The turn
    // must FAIL with a named error and the provider must never be called.
    //
    // ⭐ The zero-request assertion is the claim. Proceeding on an undecodable snapshot would silently
    // send a request built from a context nobody could read, and the model would answer against a
    // partially-reconstructed world — a wrong answer produced confidently, which is worse than a
    // refusal. Ruling 2's "an unavailable subsystem names itself instead of rendering empty", applied
    // to the context store.
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

  test("keeps the baseline and chronological System updates after a model switch", async () => {
    // Three turns with the context changing between each, and a model switch in the middle. The prompt
    // prefix carries "Initial context" on ALL THREE — established once, never rewritten — while every
    // change accumulates as chronological System messages.
    //
    // ⭐ The count on turn 3 is the load-bearing assertion: TWO system messages, not one. Each change is
    // its own event, so a runner that collapsed them into "latest wins" would lose the intermediate
    // state — and the model would never learn that the context changed twice, only where it ended up.
    // The model switch is in the middle to prove it does not reset any of this.
    const harness = makeRunnerHarness({
      turns: [completeTurn("t1", "One"), completeTurn("t2", "Two"), completeTurn("t3", "Three")],
    })

    const { types, before, replayed } = await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        const events = yield* EventV2.Service

        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "First" }), resume: false })
        yield* session.resume(HARNESS_SESSION)

        harness.controls.systemBaseline = "Changed context"
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Second" }), resume: false })
        yield* session.resume(HARNESS_SESSION)

        yield* events.publish(SessionEvent.ModelSwitched, {
          sessionID: HARNESS_SESSION,
          messageID: SessionMessage.ID.create(),
          timestamp: DateTime.makeUnsafe(1),
          model: { id: ModelV2.ID.make("replacement"), providerID: ProviderV2.ID.make("harness") },
        })
        harness.controls.systemBaseline = "Replacement context"
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Third" }), resume: false })
        yield* session.resume(HARNESS_SESSION)

        const types = (yield* session.context(HARNESS_SESSION)).map((message) => message.type)
        const before = yield* session.messages({ sessionID: HARNESS_SESSION })
        yield* harness.replayProjection(HARNESS_SESSION)
        return { types, before, replayed: yield* session.messages({ sessionID: HARNESS_SESSION }) }
      }),
      "claim — the baseline survives a model switch",
    )

    // ① The prefix never changes, across three context changes and a model switch.
    for (const index of [0, 1, 2]) {
      expect(durableContext(harness.requests[index]?.system), `turn ${index + 1} keeps the baseline`).toMatch(
        /^Initial context/,
      )
    }
    // ② Changes ACCUMULATE rather than collapsing — BOTH are present by the third turn.
    //
    // ⚠️ Counted by CONTENT, not by `role === "system"`. The old test counted system-role messages and
    // would now find zero: context notices are lowered to the `user` role on the wire (the same
    // lowering the removed-context claim documents), so a role filter sees none of them.
    const thirdBody = JSON.stringify((harness.requests[2]?.messages ?? []).map((message) => message.content))
    expect(thirdBody, "the first change is still present").toContain("Changed context")
    expect(thirdBody, "and the second — collapsing them loses the intermediate state").toContain("Replacement context")
    expect(types).toContain("model-switched")
    // ③ And the whole thing is rebuildable from events.
    //
    // ⚠️ Compared against the PRE-replay count rather than a literal. The old test asserted 6; the
    // transcript is 9 now because each context notice is its own message. Pinning a literal here would
    // make every future change to what the runner records look like a replay regression — the claim is
    // FIDELITY, so the two counts are compared to each other.
    expect(replayed, "replay must reproduce the transcript exactly").toHaveLength(before.length)
  })

  test("rebuilds the baseline directly after completed compaction", async () => {
    // ⭐ THE EXCEPTION to every other baseline claim in this file, and the reason they are all worth
    // having together. Elsewhere the prefix is established once and never rewritten — a change arrives
    // chronologically. After a COMPLETED compaction it IS rebuilt: turn 2 carries the new baseline, not
    // the old one.
    //
    // That is not an inconsistency. Compaction is the one moment the prefix is being replaced anyway,
    // so rebuilding costs nothing that was not already lost — and NOT rebuilding would pin a stale
    // context in front of a freshly summarised transcript for the rest of the session.
    const harness = makeRunnerHarness({ turns: [completeTurn("t1", "One"), completeTurn("t2", "Two")] })

    await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        const events = yield* EventV2.Service

        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "First" }), resume: false })
        yield* session.resume(HARNESS_SESSION)

        const compactionID = SessionMessage.ID.create()
        yield* events.publish(SessionEvent.Compaction.Started, {
          sessionID: HARNESS_SESSION,
          messageID: compactionID,
          timestamp: DateTime.makeUnsafe(1),
          reason: "manual",
        })
        yield* events.publish(SessionEvent.Compaction.Ended, {
          sessionID: HARNESS_SESSION,
          messageID: compactionID,
          timestamp: DateTime.makeUnsafe(2),
          reason: "manual",
          text: "summary",
          recent: "",
          ...(yield* harness.currentPrefix),
        })

        harness.controls.systemBaseline = "Replacement context"
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Second" }), resume: false })
        yield* session.resume(HARNESS_SESSION)
      }),
      "claim — compaction rebuilds the baseline",
    )

    expect(durableContext(harness.requests[0]?.system), "before compaction: the original").toMatch(/^Initial context/)
    expect(
      durableContext(harness.requests[1]?.system),
      "after compaction: REBUILT, unlike every other baseline change",
    ).toMatch(/^Replacement context/)
  })

  test("preserves effective System updates while compaction rebaseline is blocked", async () => {
    // ⭐ THE EXCEPTION'S OWN EXCEPTION, and the pair only reads correctly together. The claim above
    // says a completed compaction REBUILDS the durable prefix. This says: when the rebuild cannot be
    // performed — the context source is unavailable at exactly that moment — the runner keeps the last
    // known-good prefix AND keeps the chronological update that had already been delivered.
    //
    // Both halves are load-bearing, and they fail in opposite directions. Dropping the prefix would
    // strand the session with no durable context at all; dropping the chronological update would lose
    // the only surviving record of a change the model had already been told about, and it would look
    // fine — the request still carries a plausible prefix, just a stale one with the correction
    // silently deleted. That is the failure a user cannot see and cannot report.
    const harness = makeRunnerHarness({
      turns: [completeTurn("t1", "One"), completeTurn("t2", "Two"), completeTurn("t3", "Three")],
    })

    await drive(
      harness,
      Effect.gen(function* () {
        const session = yield* SessionV2.Service
        const events = yield* EventV2.Service

        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "First" }), resume: false })
        yield* session.resume(HARNESS_SESSION)

        // The world changes and is delivered chronologically (the baseline claims above).
        harness.controls.systemBaseline = "Changed context"
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Second" }), resume: false })
        yield* session.resume(HARNESS_SESSION)

        const compactionID = SessionMessage.ID.create()
        yield* events.publish(SessionEvent.Compaction.Started, {
          sessionID: HARNESS_SESSION,
          messageID: compactionID,
          timestamp: DateTime.makeUnsafe(1),
          reason: "manual",
        })
        yield* events.publish(SessionEvent.Compaction.Ended, {
          sessionID: HARNESS_SESSION,
          messageID: compactionID,
          timestamp: DateTime.makeUnsafe(2),
          reason: "manual",
          text: "summary",
          recent: "",
          ...(yield* harness.currentPrefix),
        })

        // …and the source goes away before the rebaseline that compaction would otherwise perform.
        harness.controls.systemUnavailable = true
        yield* session.prompt({ sessionID: HARNESS_SESSION, prompt: Prompt.make({ text: "Third" }), resume: false })
        yield* session.resume(HARNESS_SESSION)
      }),
      "claim — a blocked rebaseline keeps both the prefix and the update",
    )

    const last = harness.requests.at(-1)
    expect(durableContext(last?.system), "the rebuild could not run, so the last known-good prefix stands").toMatch(
      /^Initial context/,
    )
    expect(
      JSON.stringify((last?.messages ?? []).map((message) => message.content)),
      "and the change already delivered chronologically is still there",
    ).toContain("Changed context")
  })
})
