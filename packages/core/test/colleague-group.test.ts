import fs from "node:fs"
import path from "node:path"
import { beforeEach, describe, expect, test } from "bun:test"
import { Clock, Effect } from "effect"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { ColleagueBound } from "@novaclaw/core/session/colleague-bound"
import { ColleagueHandoff } from "@novaclaw/core/session/colleague-handoff"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@novaclaw/core/session/sql"
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

const handoff = (
  db: Database.Interface["db"],
  events: EventV2.Interface,
  agents: Record<string, string>,
  woke?: string[],
) =>
  ColleagueHandoff.fromParts({
    db,
    events,
    session: (id) => Effect.succeed({ agent: agents[String(id)] }),
    wake: (id) => {
      woke?.push(String(id))
      return Effect.succeed(true)
    },
    store: {} as never,
    refresh: Effect.void,
    takenNames: Effect.succeed([]),
    forget: () => Effect.void,
  })

const ARIS = "ses_aris" as SessionSchema.ID
const THERON = "ses_theron" as SessionSchema.ID
const KALLIAS = "ses_kallias" as SessionSchema.ID
const NOVA = "ses_nova" as SessionSchema.ID
const ROSTER = { [ARIS]: "aris", [THERON]: "theron", [KALLIAS]: "kallias", [NOVA]: "nova" }

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
  yield* chat(db, { id: NOVA, agent: "nova" })
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
      expect(sessions.map((row) => row.id).sort()).toEqual([ARIS, KALLIAS, THERON, NOVA].sort())
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

/** Put a peer message in a chat, so `lastPeerContext` sees who spoke to it last. */
const peerMessageFrom = (
  db: Database.Interface["db"],
  session: SessionSchema.ID,
  from: string,
  path?: ReadonlyArray<string>,
  participants?: ReadonlyArray<string>,
) =>
  db
    .insert(SessionMessageTable)
    .values([
      {
        id: `msg_peer_${from}_${session}`,
        session_id: session,
        type: "user",
        seq: 1,
        data: {
          text: "earlier question",
          origin: {
            via: "agent",
            relation: "peer",
            label: from,
            hops: 1,
            ...(path ? { path: [...path] } : {}),
            ...(participants ? { participants: [...participants] } : {}),
          },
        },
        time_created: 1,
      } as never,
    ])
    .run()
    .pipe(Effect.orDie)

describe("a reply INFORMS the room, it does not summon it", () => {
  it.effect(
    "🔴 only the colleague being ANSWERED is woken; the rest are durable but dormant",
    Effect.gen(function* () {
      const { db, events } = yield* threeChats
      // theron is replying: its own chat last heard from aris, so aris is being answered and
      // kallias is a bystander to that answer.
      yield* peerMessageFrom(db, THERON, "aris")

      const woke: string[] = []
      const outcome = yield* handoff(db, events, ROSTER, woke).deliverGroup({
        from: THERON,
        colleagues: ["aris", "kallias"],
        message: "the quarter closed cleanly",
      })

      expect(outcome.delivered).toEqual(["aris", "kallias"])
      // Waking every recipient is what makes a room amplify: one reply becomes N more turns, and it
      // settles only when the hop cap or the rate window REFUSES something.
      expect(woke).toEqual([String(ARIS)])
      // …and the bystander still HAS it. Dormant is durable, not dropped.
      expect((yield* admitted(db, KALLIAS)).length).toBe(1)
    }),
  )

  it.effect(
    "the bystander's note says nobody is waiting — and how to speak up",
    Effect.gen(function* () {
      const { db, events } = yield* threeChats
      yield* peerMessageFrom(db, THERON, "aris")
      yield* handoff(db, events, ROSTER).deliverGroup({
        from: THERON,
        colleagues: ["aris", "kallias"],
        message: "the quarter closed cleanly",
      })

      const note = (yield* admitted(db, KALLIAS))[0]!.text
      // ⚠️ The note must change WITH the wake: a fixed sentence under a changed control is the copy
      // defect principle 12 names. Handing a bystander the `ask_group` call as though a reply were
      // expected is exactly the amplification this rule removes.
      // ⚠️ Must be a phrase ONLY the announcement carries. An OR with "nobody is waiting" passed
      // under the perturbation below, because the ASK note says that too — a weak assertion that
      // would have let the damper be deleted with one test still green.
      expect(note).toMatch(/kept informed/i)
      expect(note).not.toMatch(/Answer once/i)
      // …but a room where nobody may speak is not a room.
      expect(note).toContain("ask_group")
    }),
  )

  it.effect(
    "🔴 the bystander's copy is MARKED an announce, so it is not read as an unanswered ask",
    Effect.gen(function* () {
      const { db, events } = yield* threeChats
      yield* peerMessageFrom(db, THERON, "aris")
      yield* handoff(db, events, ROSTER).deliverGroup({
        from: THERON,
        colleagues: ["aris", "kallias"],
        message: "the quarter closed cleanly",
      })

      // The JOIN, and the half a pure test cannot reach: the note's wording already differed, but
      // nothing downstream reads wording. `colleague-stall.ts` reads the ORIGIN, and until this was
      // stamped the copy was byte-identical to an ask — so kallias staying (correctly) silent
      // minted a false stall against theron, whose "ask again" then woke the room.
      expect((yield* admitted(db, KALLIAS))[0]!.origin["announce"]).toBe(true)

      // ⚠️ The ANSWER recipient is not marked. aris asked, so aris is owed a reply, and marking
      // that copy would silence a stall that SHOULD fire.
      expect((yield* admitted(db, ARIS)).at(-1)!.origin["announce"]).toBeUndefined()
    }),
  )

  it.effect(
    "🔴 `participants` names EXACTLY who received it, and rate is charged for exactly those",
    Effect.gen(function* () {
      const { db, events } = yield* threeChats
      const result = yield* handoff(db, events, ROSTER).deliverGroup({
        from: NOVA,
        // `ghost` is on nobody's roster and has no chat — the same shape a colleague archived
        // between the scan and the land used to produce.
        colleagues: ["aris", "kallias", "ghost"],
        message: "the quarter closed cleanly",
      })

      expect(result.delivered.toSorted()).toEqual(["aris", "kallias"])
      expect(result.missing).toContain("ghost")

      // 🔴 The invariant this file states about itself: a partially delivered conference is worse
      // than a refused one, because the `participants` list every recipient can SEE would name
      // colleagues who never got the message — so they would answer a room that was never
      // assembled, and nobody in it could tell.
      for (const session of [ARIS, KALLIAS]) {
        const origin = (yield* admitted(db, session))[0]!.origin as { participants?: string[] }
        expect(origin.participants?.toSorted()).toEqual(["aris", "kallias", "nova"])
      }

      // ⚠️ And the sender is charged for TWO copies, not three. The bound is charged once per
      // recipient, so counting a copy that was never written spends an allowance on nothing.
      expect(ColleagueBound.recent(String(NOVA), yield* Clock.currentTimeMillis)).toBe(2)
    }),
  )

  test("🔴 the landing loop resolves NO chat of its own — the race is removed, not handled", () => {
    // ⚠️ A STRUCTURAL assertion, and the reason is worth stating: the defect is a window between
    // two lookups, and the test harness has no seam between them — `input.session` runs before the
    // scan, `wake` runs after the land. Adding a seam to the production code purely to make the
    // race reachable would be a worse change than the bug. So the fix is the REMOVAL of the second
    // lookup, and this asserts exactly that.
    //
    // Verified by A/B: the behavioural test above passes with the second lookup restored, so it
    // does NOT pin this. This does.
    const source = fs.readFileSync(path.join(import.meta.dir, "..", "src", "session", "colleague-handoff.ts"), "utf8")
    const group = source.slice(source.indexOf("deliverGroup: Effect.fn"))
    const landing = group.slice(group.indexOf("for (const entry of turns)"))
    expect(landing).toContain("chats.get(entry.colleague)")
    expect(landing).not.toContain("chatFor")
  })

  it.effect(
    "🔴 a BYSTANDER taking up the invitation reaches the originator, who is on its path",
    Effect.gen(function* () {
      const { db, events } = yield* threeChats
      // aris asked the room; the chain reached kallias via theron, so aris and theron are both on
      // kallias's path — which is how every participant of a room always looks.
      yield* peerMessageFrom(db, KALLIAS, "theron", ["aris", "theron"], ["aris", "theron", "kallias"])

      const result = yield* handoff(db, events, ROSTER).deliverGroup({
        from: KALLIAS,
        colleagues: ["aris", "theron"],
        message: "one more thing about the ledger",
      })

      // 🔴 The JOIN. The rule being right is not enough: `lastPeerContext` has to carry the room
      // to it. Before this, aris — the person who ASKED — was dropped as a cycle, so the room
      // invited a reply and then withheld it from the only one it was for.
      expect(result.delivered.toSorted()).toEqual(["aris", "theron"])
      expect(result.refused).toBeUndefined()
      expect((yield* admitted(db, ARIS)).length).toBe(1)
    }),
  )

  it.effect(
    "a fresh QUESTION still wakes everyone — the damper is on replies only",
    Effect.gen(function* () {
      const { db, events } = yield* threeChats
      const woke: string[] = []
      yield* handoff(db, events, ROSTER, woke).deliverGroup({
        from: ARIS,
        colleagues: ["theron", "kallias"],
        message: "did the quarter close cleanly?",
      })
      // Nobody is being answered here, so this is the ask — and an ask that woke nobody would be a
      // question shouted into an empty room.
      expect(woke.sort()).toEqual([String(KALLIAS), String(THERON)].sort())
    }),
  )
})

describe("a cycle is decided per recipient, not against the whole room", () => {
  it.effect(
    "🔴 a participant already in the chain is DROPPED and reported — the others still get it",
    Effect.gen(function* () {
      const { db, events } = yield* threeChats
      // A REAL ring: aris asked theron, theron asked kallias. kallias now addresses the room, and
      // aris is on the chain behind it while nova is not.
      // ⚠️ kallias→aris would be an ANSWER, not a cycle, had aris written to kallias directly — which
      // is why the chain has to reach kallias THROUGH theron for this to be a loop at all.
      yield* peerMessageFrom(db, KALLIAS, "theron", ["aris", "theron"])

      const outcome = yield* handoff(db, events, ROSTER).deliverGroup({
        from: KALLIAS,
        colleagues: ["aris", "nova"],
        message: "who owns the ledger?",
      })

      // ⚠️ NOT a refusal of the conference. All-or-nothing belongs to the RATE budget, which is a
      // property of the sender; one colleague being in the chain says nothing about the others.
      expect(outcome.delivered).toEqual(["nova"])
      expect(outcome.missing).toContain("aris")
      expect(outcome.refused).toBeUndefined()
      expect((yield* admitted(db, NOVA)).length).toBe(1)
      // aris does NOT get the question — that would close the loop. What it gets is the notice that a
      // chain it started came back around, which is a different message and the point of telling it.
      const toAris = yield* admitted(db, ARIS)
      expect(toAris.length).toBe(1)
      expect(toAris[0]!.text).toContain("came back around")
      expect(toAris[0]!.text).not.toContain("who owns the ledger?")
    }),
  )

  it.effect(
    "the participants list names who RECEIVED it, so a dropped node is not advertised",
    Effect.gen(function* () {
      const { db, events } = yield* threeChats
      yield* peerMessageFrom(db, KALLIAS, "theron", ["aris", "theron"])
      yield* handoff(db, events, ROSTER).deliverGroup({
        from: KALLIAS,
        colleagues: ["aris", "nova"],
        message: "who owns the ledger?",
      })
      // Otherwise nova answers a room containing aris, who never heard the question.
      expect((yield* admitted(db, NOVA))[0]!.origin["participants"]).toEqual(["kallias", "nova"])
    }),
  )

  it.effect(
    "the chain is CARRIED, so the next hop can decide",
    Effect.gen(function* () {
      const { db, events } = yield* threeChats
      yield* peerMessageFrom(db, KALLIAS, "theron", ["aris", "theron"])
      yield* handoff(db, events, ROSTER).deliverGroup({
        from: KALLIAS,
        colleagues: ["nova"],
        message: "who owns the ledger?",
      })
      // `hops` is a number and cannot tell A→B→C→A from A→B→C→D; the path is what makes the next
      // hop's decision possible at all.
      expect((yield* admitted(db, NOVA))[0]!.origin["path"]).toEqual(["aris", "theron", "kallias"])
    }),
  )
})

describe("the originator is told its chain came back around", () => {
  it.effect(
    "🔴 the agent that STARTED the chain hears about the loop, in its own chat",
    Effect.gen(function* () {
      const { db, events } = yield* threeChats
      // aris started it: aris → theron → kallias. kallias now tries to pass it back to aris.
      yield* peerMessageFrom(db, KALLIAS, "theron", ["aris", "theron"])

      const outcome = yield* handoff(db, events, ROSTER).deliver({
        from: KALLIAS,
        colleague: "aris",
        message: "who owns the ledger?",
      })

      expect(outcome.delivered).toBe(false)
      // No framework surveyed does this: everyone refuses the hop and tells the SENDER, while the one
      // participant who can dissolve the loop — the agent holding the question it circles — is never
      // informed.
      const notice = yield* admitted(db, ARIS)
      expect(notice.length).toBe(1)
      expect(notice[0]!.text).toContain("came back around")
      expect(notice[0]!.text).toContain("aris → theron → kallias → aris")
    }),
  )

  it.effect(
    "the notice is not a hand-off: it carries no peer origin and starts no chain",
    Effect.gen(function* () {
      const { db, events } = yield* threeChats
      yield* peerMessageFrom(db, KALLIAS, "theron", ["aris", "theron"])
      yield* handoff(db, events, ROSTER).deliver({ from: KALLIAS, colleague: "aris", message: "?" })

      const origin = (yield* admitted(db, ARIS))[0]!.origin
      // ⚠️ A `relation: "peer"` here would put the NOTICE on the next path and make a loop detector
      // part of a loop. It also must not invite a reply — an amplifier attached to a loop detector
      // would be a poor joke.
      expect(origin["relation"]).toBeUndefined()
      expect(origin["path"]).toBeUndefined()
    }),
  )

  it.effect(
    "the sender's own loop tells nobody else — there is no third party to inform",
    Effect.gen(function* () {
      const { db, events } = yield* threeChats
      // aris asked theron; theron is answering back to aris, which is NOT a cycle at all.
      yield* peerMessageFrom(db, THERON, "aris", ["aris"])
      const outcome = yield* handoff(db, events, ROSTER).deliver({
        from: THERON,
        colleague: "aris",
        message: "it balances",
      })
      // Delivered, because an answer closes an exchange rather than a loop — and so there is no
      // notice to send.
      expect(outcome.delivered).toBe(true)
    }),
  )
})
