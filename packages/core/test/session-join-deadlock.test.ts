import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Fiber, Stream } from "effect"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Database } from "@novaclaw/core/database/database"
import { EventV2 } from "@novaclaw/core/event"
import { SessionEvent } from "@novaclaw/core/session/event"
import { SessionExecutionAttempt } from "@novaclaw/core/session/execution-attempt"
import { SessionJoin } from "@novaclaw/core/session/join"
import { SessionInput } from "@novaclaw/core/session/input"
import { SessionMessage } from "@novaclaw/core/session/message"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionStore } from "@novaclaw/core/session/store"
import { SessionTable } from "@novaclaw/core/session/sql"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { testEffect } from "./lib/effect"

/**
 * THE JOIN — where a fleet of sub-agents would deadlock if it were going to.
 *
 * 🔴 `wait` is the one place an officer BLOCKS on another session, so it is the multithread primitive
 * with a real hang in it. Nothing referenced `SessionJoin` or `awaitCompletion` from any test before
 * this file: the fork-bomb quotas are pinned (`spawn-wakes-child.test.ts`) and the join was not.
 *
 * Four shapes, each a way a parent could wait forever:
 *
 *   1. the child finishes AFTER the wait starts — the ordinary wake;
 *   2. the child finished BEFORE the wait started — the LOST WAKEUP, which works because the
 *      projected current result is checked before the durable stream tails later events. A live-only
 *      stream would leave the parent blocked on an event that already happened, and since a timeout
 *      is a legitimate answer here it would surface as "still working" seven minutes later rather than
 *      as a bug;
 *   3. two waiters on one child — one consuming the completion must not starve the other;
 *   4. nobody finishes — the timeout must be an ANSWER, never a hang.
 *
 * ⚠️ **`it.live`, NOT `it.effect`, and that distinction cost this file a false bug report.**
 * `lib/effect.ts` gives `it.effect` a `TestClock`, so no duration ever elapses: every bound —
 * `Effect.timeoutOrElse`, `Stream.interruptWhen`, `Stream.timeoutOrElse` — parks forever and reads
 * exactly like a product deadlock. A "deadlock in `wait`" was filed against this suite and retracted
 * (`notes/named-agents.md`). Anything whose correctness IS a duration belongs on the real clock.
 */

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionExecutionAttempt.node,
      SessionJoin.node,
    ]),
  ),
)

const CHILD = "ses_join_child" as SessionSchema.ID
const SIBLING = "ses_join_sibling" as SessionSchema.ID
const ABSENT = "ses_join_never" as SessionSchema.ID

const create = (id: SessionSchema.ID) =>
  Database.Service.use(({ db }) =>
    db
      .insert(SessionTable)
      .values({ id, slug: id, directory: "/join-test", title: id, version: "test" })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie),
  )

/** Publish a child's completion. The aggregate is the session id, which is what the join keys on. */
const finish = (events: EventV2.Interface, id: SessionSchema.ID, result: string) =>
  Effect.gen(function* () {
    yield* events.publish(SessionEvent.Completed, {
      sessionID: id,
      timestamp: yield* DateTime.now,
      result,
    } as never)
  })

describe("awaiting a child", () => {
  test("completion racing the projected-row read keeps diagnostics from the same interval", async () => {
    let sequenceReads = 0
    const event = (type: string, data: Record<string, unknown>) => ({ type, data }) as EventV2.Payload
    const join = SessionJoin.fromParts({
      sequence: () => Effect.succeed(sequenceReads++ === 0 ? -1 : 2),
      session: () => Effect.succeed({ result: "raced" } as SessionSchema.Info),
      attempt: () => Effect.succeed(undefined),
      events: {
        durable: () =>
          Stream.fromIterable([
            event(SessionEvent.Step.Ended.type, { tokens: { output: 3, reasoning: 4 } }),
            event(SessionEvent.Step.Failed.type, {
              error: { message: "bad request", _tag: "InvalidRequest", retryable: false, status: 400 },
            }),
            event(SessionEvent.Completed.type, { result: "raced" }),
          ]),
      } as unknown as EventV2.Interface,
    })

    expect(await Effect.runPromise(join.awaitCompletion({ childID: CHILD, timeoutMs: 1_000 }))).toEqual({
      completed: true,
      result: "raced",
      generatedAnyTokens: true,
      generatedTokens: 7,
      providerErrors: [{ message: "bad request", tag: "InvalidRequest", retryable: false, status: 400, count: 1 }],
    })
  })

  test("partial output is reported even when the failed stream has no usage total", async () => {
    const event = (type: string, data: Record<string, unknown>) => ({ type, data }) as EventV2.Payload
    const join = SessionJoin.fromParts({
      sequence: () => Effect.succeed(-1),
      session: () => Effect.succeed(undefined),
      attempt: () => Effect.succeed(undefined),
      events: {
        durable: () =>
          Stream.fromIterable([
            event(SessionEvent.Text.Progress.type, { delta: "partial" }),
            event(SessionEvent.Step.Failed.type, {
              error: { message: "connection lost", _tag: "Transport", retryable: true },
            }),
            event(SessionEvent.Completed.type, { result: "stopped" }),
          ]),
      } as unknown as EventV2.Interface,
    })

    expect(await Effect.runPromise(join.awaitCompletion({ childID: CHILD, timeoutMs: 1_000 }))).toEqual({
      completed: true,
      result: "stopped",
      generatedAnyTokens: true,
      generatedTokens: 0,
      providerErrors: [{ message: "connection lost", tag: "Transport", retryable: true, count: 1 }],
    })
  })

  it.live("wakes when the child finishes AFTER the wait began", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      yield* create(CHILD)
      const join = yield* SessionJoin.Service
      const waiting = yield* Effect.forkScoped(join.awaitCompletion({ childID: CHILD, timeoutMs: 20_000 }))
      // Let the waiter subscribe before the event exists — this is the live-wake path, not the replay.
      yield* Effect.sleep("400 millis")
      yield* finish(events, CHILD, "child done")

      const outcome = yield* Fiber.join(waiting)
      expect(outcome.completed).toBe(true)
      expect(outcome.result).toContain("child done")
    }),
  )

  it.live("🔴 wakes when the child finished BEFORE the wait began — the lost wakeup", () =>
    Effect.gen(function* () {
      // The race that matters for a fleet: six sub-agents are spawned and the quickest finishes while
      // the officer is still calling `wait` on the first. This passes only because join reads the
      // projected current result before tailing future completion events.
      const events = yield* EventV2.Service
      const early = "ses_join_early" as SessionSchema.ID
      yield* create(early)
      yield* finish(events, early, "finished early")
      yield* Effect.sleep("300 millis")

      const outcome = yield* (yield* SessionJoin.Service).awaitCompletion({ childID: early, timeoutMs: 8_000 })
      expect(outcome.completed).toBe(true)
      expect(outcome.result).toContain("finished early")
    }),
  )

  it.live("two waiters on ONE child both wake — no starved join", () =>
    Effect.gen(function* () {
      // A parent that called `wait` twice, or a parent and a supervisor. One consumer taking the
      // completion and leaving the other blocked is a deadlock with a witness.
      const events = yield* EventV2.Service
      const shared = "ses_join_shared" as SessionSchema.ID
      yield* create(shared)
      const join = yield* SessionJoin.Service
      const first = yield* Effect.forkScoped(join.awaitCompletion({ childID: shared, timeoutMs: 20_000 }))
      const second = yield* Effect.forkScoped(join.awaitCompletion({ childID: shared, timeoutMs: 20_000 }))
      yield* Effect.sleep("400 millis")
      yield* finish(events, shared, "shared")

      const outcomes = [yield* Fiber.join(first), yield* Fiber.join(second)]
      expect(outcomes.map((o) => o.completed)).toEqual([true, true])
    }),
  )

  it.live("reports tokens and provider errors observed during exactly this wait", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const observed = "ses_join_observed" as SessionSchema.ID
      yield* create(observed)
      const join = yield* SessionJoin.Service
      const waiting = yield* Effect.forkScoped(join.awaitCompletion({ childID: observed, timeoutMs: 20_000 }))
      yield* Effect.sleep("400 millis")
      const timestamp = yield* DateTime.now
      yield* events.publish(SessionEvent.Step.Ended, {
        sessionID: observed,
        timestamp,
        assistantMessageID: SessionMessage.ID.create(),
        finish: "stop",
        cost: 0,
        tokens: { input: 100, output: 12, reasoning: 5, cache: { read: 0, write: 0 } },
      } as never)
      const failure = {
        sessionID: observed,
        timestamp,
        assistantMessageID: SessionMessage.ID.create(),
        error: {
          type: "unknown",
          message: "reasoning_content is required",
          _tag: "InvalidRequest",
          retryable: false,
          status: 400,
        },
      }
      yield* events.publish(SessionEvent.Step.Failed, failure as never)
      yield* events.publish(SessionEvent.Step.Failed, {
        ...failure,
        assistantMessageID: SessionMessage.ID.create(),
      } as never)
      yield* finish(events, observed, "done")

      expect(yield* Fiber.join(waiting)).toEqual({
        completed: true,
        result: "done",
        generatedAnyTokens: true,
        generatedTokens: 17,
        providerErrors: [
          {
            message: "reasoning_content is required",
            tag: "InvalidRequest",
            retryable: false,
            status: 400,
            count: 2,
          },
        ],
      })
    }),
  )

  it.live("a child that never finishes TIMES OUT with an answer, and does not hang", () =>
    Effect.gen(function* () {
      // ⚠️ `completed: false` is the honest report — the child may simply still be working, which is
      // why this is not an error. What matters is that the call RETURNS: an unbounded join is how a
      // wedged sub-agent takes its officer down with it.
      const outcome = yield* (yield* SessionJoin.Service).awaitCompletion({
        childID: ABSENT,
        timeoutMs: 1_500,
      })
      expect(outcome).toEqual({
        completed: false,
        generatedAnyTokens: false,
        generatedTokens: 0,
        providerErrors: [],
      })
    }),
  )

  it.live("another session's completion does not satisfy the wait", () =>
    Effect.gen(function* () {
      // The join is keyed on the child's aggregate. A sibling finishing must not wake a parent waiting
      // on a different one — otherwise a fleet's first completion would satisfy every outstanding
      // `wait` and the officer would read five unfinished children as done.
      const events = yield* EventV2.Service
      yield* finish(events, SIBLING, "the other one")
      const outcome = yield* (yield* SessionJoin.Service).awaitCompletion({
        childID: "ses_join_waiting_on" as SessionSchema.ID,
        timeoutMs: 1_500,
      })
      expect(outcome).toEqual({
        completed: false,
        generatedAnyTokens: false,
        generatedTokens: 0,
        providerErrors: [],
      })
    }),
  )

  it.live("a follow-up reopens a settled child and the next wait returns the NEW result", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const store = yield* SessionStore.Service
      const join = yield* SessionJoin.Service
      const reopened = "ses_join_reopened" as SessionSchema.ID
      yield* create(reopened)
      yield* finish(events, reopened, "first answer")
      expect((yield* store.get(reopened))?.result).toBe("first answer")

      yield* SessionInput.admit(db, events, {
        id: SessionMessage.ID.create(),
        sessionID: reopened,
        prompt: { text: "follow-up" },
        delivery: "queue",
      })
      expect((yield* store.get(reopened))?.result).toBeUndefined()

      const waiting = yield* Effect.forkScoped(join.awaitCompletion({ childID: reopened, timeoutMs: 20_000 }))
      yield* Effect.sleep("400 millis")
      yield* finish(events, reopened, "second answer")

      expect(yield* Fiber.join(waiting)).toEqual({
        completed: true,
        result: "second answer",
        generatedAnyTokens: false,
        generatedTokens: 0,
        providerErrors: [],
      })
      expect(yield* join.awaitCompletion({ childID: reopened, timeoutMs: 1_000 })).toEqual({
        completed: true,
        result: "second answer",
        generatedAnyTokens: false,
        generatedTokens: 0,
        providerErrors: [],
      })
    }),
  )
})

/**
 * 🔴 **A DEAD child must not read as a slow one — the fifth shape, and the one a user hits.**
 *
 * Measured 2026-09-27: the owner pressed Stop on a worker from the chat's workers list. The stop wrote
 * `interrupted` to the worker's attempt row, which emits no `Completed` event, so the parent's join
 * had nothing to wake on and sat out its whole seven-minute bound. The transcript row read "Waiting
 * for worker" over a worker that had been dead in front of them, and the tool then told the model
 * *"it may still be working — this is not an error"*.
 *
 * The defect was the SHAPE, not the state: the liveness predicate was read at the two edges of the
 * wait and nowhere inside it, so anything that happened between them was invisible for the rest of
 * the bound. These four tests pin the interior watch, the false-death control it needs, and the race
 * it creates against a completion landing in the same instant.
 */
describe("awaiting a child that stopped instead of finishing", () => {
  const event = (type: string, data: Record<string, unknown>) => ({ type, data }) as EventV2.Payload
  /**
   * A durable stream that stays OPEN and never yields — a child that will not complete.
   * ⚠️ Not `Stream.fromIterable([])`: an empty stream ENDS, which ends the join as a plain timeout
   * and would make the halt arm untested while the test read as a pass.
   */
  const silent = () => Stream.never as Stream.Stream<EventV2.Payload>

  it.live("🔴 a worker the user stopped ends the wait at once, naming the state", () =>
    Effect.gen(function* () {
      // The real ledger, not a stub: `requestInterrupt` is the exact write the chat's Stop button
      // causes, so this is the reported sequence rather than an approximation of it.
      const attempts = yield* SessionExecutionAttempt.Service
      const stopped = "ses_join_stopped" as SessionSchema.ID
      yield* create(stopped)
      yield* attempts.start(stopped, "host_test")
      yield* attempts.requestInterrupt(stopped)
      expect((yield* attempts.get(stopped))?.state).toBe("interrupted")

      const outcome = yield* (yield* SessionJoin.Service).awaitCompletion({ childID: stopped, timeoutMs: 60_000 })
      // A bound of a full minute, and it came back in milliseconds: the wait ended on the ledger, not
      // on the clock. A test that passed by timing out would assert nothing.
      expect(outcome).toEqual({
        completed: false,
        halted: "interrupted",
        generatedAnyTokens: false,
        generatedTokens: 0,
        providerErrors: [],
      })
    }),
  )

  it.live("🔴 a BUSY child is still working, and is never called dead", () =>
    Effect.gen(function* () {
      // The control for the arm above, and the expensive direction: telling a parent its live child
      // died sends it to re-issue a slice a live worker is already doing.
      const attempts = yield* SessionExecutionAttempt.Service
      const live = "ses_join_busy" as SessionSchema.ID
      yield* create(live)
      yield* attempts.start(live, "host_test")

      const outcome = yield* (yield* SessionJoin.Service).awaitCompletion({ childID: live, timeoutMs: 1_500 })
      expect(outcome).toEqual({
        completed: false,
        generatedAnyTokens: false,
        generatedTokens: 0,
        providerErrors: [],
      })
      expect(outcome.halted).toBeUndefined()
    }),
  )

  test("🔴 a child with NO attempt row is not dead — it has not started", async () => {
    // An absent row means "not started yet, or pruned", never "gone". Reading it as death is how a
    // just-spawned worker gets reported lost.
    const join = SessionJoin.fromParts({
      sequence: () => Effect.succeed(-1),
      session: () => Effect.succeed(undefined),
      attempt: () => Effect.succeed(undefined),
      events: { durable: () => silent() } as unknown as EventV2.Interface,
    })
    const outcome = await Effect.runPromise(join.awaitCompletion({ childID: CHILD, timeoutMs: 700 }))
    expect(outcome.completed).toBe(false)
    expect(outcome.halted).toBeUndefined()
  })

  it.live("🔴 a completion landing in the same instant still reads as COMPLETED, not dead", () =>
    // 🔴 The race the interior watch CREATES, and the reason `join.ts` re-reads the head, the row and
    // the durable delta before it may call a child dead. `settle` runs in the drain's `onExit`, so a
    // worker that called `exit()` and settled together is terminal by both facts — and a supervisor
    // told "DID NOT FINISH" about a worker that handed in its result is the worst answer here.
    Effect.gen(function* () {
      let sessionReads = 0
      let durableReads = 0
      const join = SessionJoin.fromParts({
        sequence: () => Effect.succeed(durableReads === 0 ? 0 : 1),
        session: () => Effect.succeed(sessionReads++ === 0 ? undefined : ({ result: "in time" } as SessionSchema.Info)),
        attempt: () => Effect.succeed({ state: "settled" } as SessionExecutionAttempt.Info),
        events: {
          durable: () => {
            durableReads++
            return durableReads === 1
              ? silent()
              : Stream.fromIterable([event(SessionEvent.Completed.type, { result: "in time" })])
          },
        } as unknown as EventV2.Interface,
      })

      const outcome = yield* join.awaitCompletion({ childID: CHILD, timeoutMs: 5_000 })
      expect(outcome).toEqual({
        completed: true,
        result: "in time",
        generatedAnyTokens: false,
        generatedTokens: 0,
        providerErrors: [],
      })
    }),
  )
})

/**
 * WHOSE child you may wait on — the authorization half, which lives in the TOOL rather than the join.
 *
 * 🔴 A source ledger, because the check is three lines inside `wait`'s `execute` and reaching it needs
 * a live `SessionStore`, a `SessionJoin` and a tool context — scaffolding that would test the harness
 * more than the rule. What matters is that the rule EXISTS and refuses two distinct cases, and both
 * are visible in one predicate.
 *
 * ⚠️ Without it an officer could join any session it can name — a sibling's, another colleague's, or
 * its own. Joining your own is the self-deadlock: `awaitCompletion` waits for a completion that cannot
 * arrive until the turn doing the waiting ends.
 */
describe("only a DIRECT child may be waited on", () => {
  const source = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "tool", "wait.ts"),
    "utf8",
  )

  test("the guard derives candidates only from this session's direct children", () => {
    expect(source).toMatch(/store\.children\(context\.sessionID\)/)
    expect(source).toMatch(/resolveDirectChildID\(requestedChildID, directChildren\)/)
  })

  test("it fails as a ToolFailure the model reads, not a silent false", () => {
    // A refusal the model cannot see would leave it believing it had joined something.
    const guard = source.slice(source.indexOf("if (!childID)"))
    expect(guard.slice(0, 400)).toContain("ToolFailure")
    expect(guard.slice(0, 400)).toMatch(/not a direct child/)
  })

  test("the join it guards is BOUNDED — the timeout is passed, never omitted", () => {
    // The five cases above prove `awaitCompletion` honours a timeout. This pins that the tool actually
    // supplies one, and that the join's own bound narrows to the universal tool deadline: an
    // unbounded call would hang the officer on a wedged child.
    expect(source).toContain("Math.min(\n                  WAIT_TIMEOUT_MS,")
    expect(source).toContain("context.deadline.expiresAt - Date.now()")
    expect(source).toMatch(/awaitCompletion\(\{[^}]*timeoutMs[^}]*\}/)
  })
})
