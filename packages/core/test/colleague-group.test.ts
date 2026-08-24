import { beforeEach, describe, expect } from "bun:test"
import { Clock, Effect } from "effect"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { ColleagueBound } from "@novaclaw/core/session/colleague-bound"
import { ColleagueHandoff } from "@novaclaw/core/session/colleague-handoff"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionInputTable, SessionTable } from "@novaclaw/core/session/sql"
import { Database } from "@novaclaw/core/database/database"
import { eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"

/**
 * A GROUP IS A FAN-OUT, NOT A ROOM.
 *
 * Owner, 2026-08-21: a conference lives in ONE stream, *"maintaining the agent's ego and
 * consciousness instead of splitting it among several streams"*; and 2026-08-23: agents and sessions
 * are the same first-class entity. Together those forbid a conference SESSION — it would be an
 * entity with no personality, and it would hand every participant a second stream.
 *
 * So a group message lands in each participant's OWN chat, and a shared `conversation` id on the
 * message origin makes those copies one exchange. What this file pins is the part that is invisible
 * from inside any single chat: that the copies agree with each other, that the list each recipient
 * can see names exactly who really got it, and that the loop bound is charged per RECIPIENT rather
 * than per call.
 */

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))

const chat = (db: Database.Interface["db"], input: { id: SessionSchema.ID; agent: string }) =>
  db
    .insert(SessionTable)
    .values([
      {
        id: input.id,
        slug: input.id,
        directory: process.cwd(),
        title: `${input.agent}'s chat`,
        version: "test",
        agent: input.agent,
        time_created: 1,
        time_updated: 1,
      },
    ])
    .run()
    .pipe(Effect.orDie)

const handoff = (db: Database.Interface["db"], events: EventV2.Interface, agents: Record<string, string>) =>
  ColleagueHandoff.fromParts({
    db,
    events,
    session: (id) => Effect.succeed({ agent: agents[String(id)] }),
    wake: () => Effect.succeed(true),
    store: {} as never,
    refresh: Effect.void,
    takenNames: Effect.succeed([]),
    forget: () => Effect.void,
  })

const ARIS = "ses_aris" as SessionSchema.ID
const THERON = "ses_theron" as SessionSchema.ID
const KALLIAS = "ses_kallias" as SessionSchema.ID
const ROSTER = { [ARIS]: "aris", [THERON]: "theron", [KALLIAS]: "kallias" }

/** What was actually queued into a colleague's chat. */
const admitted = (db: Database.Interface["db"], session: SessionSchema.ID) =>
  db
    .select({ prompt: SessionInputTable.prompt })
    .from(SessionInputTable)
    .where(eq(SessionInputTable.session_id, session))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) =>
        rows.map((row) => {
          const prompt = row.prompt as { origin?: Record<string, unknown>; text?: string }
          return { origin: prompt.origin ?? {}, text: prompt.text ?? "" }
        }),
      ),
    )

const threeChats = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* chat(db, { id: ARIS, agent: "aris" })
  yield* chat(db, { id: THERON, agent: "theron" })
  yield* chat(db, { id: KALLIAS, agent: "kallias" })
  return { db, events: yield* EventV2.Service }
})

beforeEach(() => ColleagueBound.reset())

describe("addressing several colleagues at once", () => {
  it.effect(
    "one message reaches every colleague, each in their OWN chat",
    Effect.gen(function* () {
      const { db, events } = yield* threeChats

      const outcome = yield* handoff(db, events, ROSTER).deliverGroup({
        from: ARIS,
        colleagues: ["theron", "kallias"],
        message: "ship review at four?",
      })

      expect(outcome.delivered).toEqual(["theron", "kallias"])
      expect(outcome.conversation).toMatch(/^cnv_/)
      expect((yield* admitted(db, THERON)).length).toBe(1)
      expect((yield* admitted(db, KALLIAS)).length).toBe(1)
      // 🔴 The sender's own chat is NOT written to. A group message appended to the sender's stream
      // is the split this design exists to prevent, and it is an infinite regress besides.
      expect((yield* admitted(db, ARIS)).length).toBe(0)
    }),
  )

  it.effect(
    "every copy agrees: same conversation, same participants, sender included",
    Effect.gen(function* () {
      const { db, events } = yield* threeChats

      yield* handoff(db, events, ROSTER).deliverGroup({
        from: ARIS,
        colleagues: ["theron", "kallias"],
        message: "ship review at four?",
      })

      const theron = (yield* admitted(db, THERON))[0]!.origin
      const kallias = (yield* admitted(db, KALLIAS))[0]!.origin
      // If the copies disagreed, a reply addressed to "the group" would reach a different set
      // depending on who answered — and nobody in it could tell.
      expect(theron["conversation"]).toBe(kallias["conversation"])
      expect(theron["participants"]).toEqual(["aris", "theron", "kallias"])
      expect(kallias["participants"]).toEqual(["aris", "theron", "kallias"])
      // Still a peer exchange, not a delegation.
      expect(theron["relation"]).toBe("peer")
    }),
  )

  it.effect(
    "the participants list names exactly who RECEIVED it",
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* chat(db, { id: ARIS, agent: "aris" })
      yield* chat(db, { id: THERON, agent: "theron" })
      // `kallias` is on the roster but has no open chat.

      const outcome = yield* handoff(db, events, ROSTER).deliverGroup({
        from: ARIS,
        colleagues: ["theron", "kallias"],
        message: "ship review at four?",
      })

      expect(outcome.delivered).toEqual(["theron"])
      expect(outcome.missing).toEqual(["kallias"])
      // 🔴 The load-bearing one. If `kallias` appeared here, theron would answer a colleague who
      // never heard the question, and neither of them could discover that.
      expect((yield* admitted(db, THERON))[0]!.origin["participants"]).toEqual(["aris", "theron"])
    }),
  )

  it.effect(
    "the loop bound is charged ONCE PER RECIPIENT",
    Effect.gen(function* () {
      const { db, events } = yield* threeChats

      yield* handoff(db, events, ROSTER).deliverGroup({
        from: ARIS,
        colleagues: ["theron", "kallias"],
        message: "ship review at four?",
      })

      // Charging once per CALL would let a group of N buy N laps for the price of one: the bound
      // would still be there, and wrong by a factor of the group size.
      //
      // ⚠️ Read through the SAME clock the code stamped with. `it.effect` runs on a TestClock frozen
      // at 0, so a `Date.now()` here sits a window and a half in the future and the rate window
      // filters away every entry — reporting 0 charges for a delivery that charged two.
      expect(ColleagueBound.recent(String(ARIS), yield* Clock.currentTimeMillis)).toBe(2)
    }),
  )

  it.effect(
    "a group that does not FIT the budget is refused whole — nothing is written",
    Effect.gen(function* () {
      const { db, events } = yield* threeChats

      // Spend the allowance down to one remaining.
      ColleagueBound.recordMany(String(ARIS), yield* Clock.currentTimeMillis, ColleagueBound.RATE_LIMIT - 1)

      const outcome = yield* handoff(db, events, ROSTER).deliverGroup({
        from: ARIS,
        colleagues: ["theron", "kallias"],
        message: "ship review at four?",
      })

      expect(outcome.refused).toBeDefined()
      expect(outcome.delivered).toEqual([])
      // ⚠️ All-or-nothing: a HALF-delivered conference is worse than a refused one, because the
      // participants list the lucky half can see would name colleagues who never got it.
      expect((yield* admitted(db, THERON)).length).toBe(0)
      expect((yield* admitted(db, KALLIAS)).length).toBe(0)
    }),
  )

  it.effect(
    "no conference SESSION is created — one chat per agent still holds",
    Effect.gen(function* () {
      const { db, events } = yield* threeChats

      yield* handoff(db, events, ROSTER).deliverGroup({
        from: ARIS,
        colleagues: ["theron", "kallias"],
        message: "ship review at four?",
      })

      // 🔴 The invariant the whole shape rests on. A conference session would be an entity with no
      // personality, and it would hand every participant a second stream.
      const sessions = yield* db.select({ id: SessionTable.id }).from(SessionTable).all().pipe(Effect.orDie)
      expect(sessions.map((row) => row.id).sort()).toEqual([ARIS, KALLIAS, THERON].sort())
    }),
  )

  it.effect(
    "naming only yourself is refused, and nothing is charged",
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* chat(db, { id: ARIS, agent: "aris" })

      const outcome = yield* handoff(db, events, ROSTER).deliverGroup({
        from: ARIS,
        colleagues: ["aris"],
        message: "talking to myself",
      })

      expect(outcome.refused).toBeDefined()
      expect(outcome.delivered).toEqual([])
      expect(ColleagueBound.recent(String(ARIS), yield* Clock.currentTimeMillis)).toBe(0)
    }),
  )

  it.effect(
    "the note tells the receiver how to answer the ROOM, not just the sender",
    Effect.gen(function* () {
      const { db, events } = yield* threeChats

      yield* handoff(db, events, ROSTER).deliverGroup({
        from: ARIS,
        colleagues: ["theron", "kallias"],
        message: "ship review at four?",
      })

      const note = (yield* admitted(db, THERON))[0]!.text
      // 🔴 Without this a group is a BROADCAST: the note is the whole reply channel, so a receiver
      // told to `ask` the sender answers one person and the rest of the room never hears it.
      expect(note).toContain('op "ask_group"')
      expect(note).toContain("aris")
      expect(note).toContain("kallias")
      // …and it does not tell theron to write to theron.
      expect(note).not.toMatch(/colleagues \[[^\]]*"theron"/)
    }),
  )

  it.effect(
    "a 1:1 hand-off's note is untouched",
    Effect.gen(function* () {
      const { db, events } = yield* threeChats

      yield* handoff(db, events, ROSTER).deliver({
        from: ARIS,
        colleague: "theron",
        message: "the ledger, please",
      })

      const note = (yield* admitted(db, THERON))[0]!.text
      // The regression that would be easiest to ship unnoticed: every existing exchange must read
      // exactly as before, or a field added for groups has changed messages it never meant to touch.
      expect(note).toContain('op "ask"')
      expect(note).not.toContain("ask_group")
    }),
  )
})
