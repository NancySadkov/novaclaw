import { describe, expect, test } from "bun:test"
import { DateTime, Effect, Fiber } from "effect"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Database } from "@novaclaw/core/database/database"
import { EventV2 } from "@novaclaw/core/event"
import { SessionEvent } from "@novaclaw/core/session/event"
import { SessionJoin } from "@novaclaw/core/session/join"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionSchema } from "@novaclaw/core/session/schema"
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
 *   2. the child finished BEFORE the wait started — the LOST WAKEUP, which only works because
 *      `EventV2.durable` replays history before it goes live. A live-only stream would leave the
 *      parent blocked on an event that already happened, and since a timeout is a legitimate answer
 *      here it would surface as "still working" ten minutes later rather than as a bug;
 *   3. two waiters on one child — one consuming the completion must not starve the other;
 *   4. nobody finishes — the timeout must be an ANSWER, never a hang.
 *
 * ⚠️ **`it.live`, NOT `it.effect`, and that distinction cost this file a false bug report.**
 * `lib/effect.ts` gives `it.effect` a `TestClock`, so no duration ever elapses: every bound —
 * `Effect.timeoutOrElse`, `Stream.interruptWhen`, `Stream.timeoutOrElse` — parks forever and reads
 * exactly like a product deadlock. A "deadlock in `wait`" was filed against this suite and retracted
 * (`todo/named-agents.md`). Anything whose correctness IS a duration belongs on the real clock.
 */

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))

const CHILD = "ses_join_child" as SessionSchema.ID
const SIBLING = "ses_join_sibling" as SessionSchema.ID
const ABSENT = "ses_join_never" as SessionSchema.ID

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
  it.live("wakes when the child finishes AFTER the wait began", () =>
    Effect.gen(function* () {
      const events = yield* EventV2.Service
      const join = SessionJoin.fromEvents(events)
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
      // the officer is still calling `wait` on the first. This passes only because `durable` replays
      // the aggregate's history before switching to live wakes.
      const events = yield* EventV2.Service
      const early = "ses_join_early" as SessionSchema.ID
      yield* finish(events, early, "finished early")
      yield* Effect.sleep("300 millis")

      const outcome = yield* SessionJoin.fromEvents(events).awaitCompletion({ childID: early, timeoutMs: 8_000 })
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
      const join = SessionJoin.fromEvents(events)
      const first = yield* Effect.forkScoped(join.awaitCompletion({ childID: shared, timeoutMs: 20_000 }))
      const second = yield* Effect.forkScoped(join.awaitCompletion({ childID: shared, timeoutMs: 20_000 }))
      yield* Effect.sleep("400 millis")
      yield* finish(events, shared, "shared")

      const outcomes = [yield* Fiber.join(first), yield* Fiber.join(second)]
      expect(outcomes.map((o) => o.completed)).toEqual([true, true])
    }),
  )

  it.live("a child that never finishes TIMES OUT with an answer, and does not hang", () =>
    Effect.gen(function* () {
      // ⚠️ `completed: false` is the honest report — the child may simply still be working, which is
      // why this is not an error. What matters is that the call RETURNS: an unbounded join is how a
      // wedged sub-agent takes its officer down with it.
      const outcome = yield* SessionJoin.fromEvents(yield* EventV2.Service).awaitCompletion({
        childID: ABSENT,
        timeoutMs: 1_500,
      })
      expect(outcome).toEqual({ completed: false })
    }),
  )

  it.live("another session's completion does not satisfy the wait", () =>
    Effect.gen(function* () {
      // The join is keyed on the child's aggregate. A sibling finishing must not wake a parent waiting
      // on a different one — otherwise a fleet's first completion would satisfy every outstanding
      // `wait` and the officer would read five unfinished children as done.
      const events = yield* EventV2.Service
      yield* finish(events, SIBLING, "the other one")
      const outcome = yield* SessionJoin.fromEvents(events).awaitCompletion({
        childID: "ses_join_waiting_on" as SessionSchema.ID,
        timeoutMs: 1_500,
      })
      expect(outcome).toEqual({ completed: false })
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

  test("the guard refuses a session that is not this session's child", () => {
    // `!child` covers a name that resolves to nothing; the parent comparison covers everything else,
    // including waiting on YOURSELF — a session is never its own parent.
    expect(source).toMatch(/!child \|\| child\.parentID !== context\.sessionID/)
  })

  test("it fails as a ToolFailure the model reads, not a silent false", () => {
    // A refusal the model cannot see would leave it believing it had joined something.
    const guard = source.slice(source.indexOf("!child ||"))
    expect(guard.slice(0, 400)).toContain("ToolFailure")
    expect(guard.slice(0, 400)).toMatch(/not a direct child/)
  })

  test("the join it guards is BOUNDED — the timeout is passed, never omitted", () => {
    // The five cases above prove `awaitCompletion` honours a timeout. This pins that the tool actually
    // supplies one: an unbounded call would hang the officer on a wedged child.
    expect(source).toMatch(/awaitCompletion\(\{[^}]*timeoutMs: WAIT_TIMEOUT_MS/)
  })
})
