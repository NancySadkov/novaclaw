import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { ColleagueBound } from "@novaclaw/core/session/colleague-bound"
import { ColleagueHandoff } from "@novaclaw/core/session/colleague-handoff"
import { RosterChat } from "@novaclaw/core/session/roster-chat"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionInputTable, SessionMessageTable, SessionTable } from "@novaclaw/core/session/sql"
import { Database } from "@novaclaw/core/database/database"
import { desc, eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"

// THE LOOP BOUND, driven rather than asserted (`notes/named-agents.md`).
//
// 🔴 `colleague-bound.test.ts` proves the arithmetic; this proves the CHAIN — that a hop stamped on
// one delivery is read back by the next, through a real database and a real admit. The two are not
// the same claim: every part of this could be individually correct while the count restarts at 1 on
// every hand-off, and the cap would then never fire no matter how long two colleagues talked. That is
// the failure the note-only bound already had, reproduced in a mechanism.
//
// ⚠️ Drives `fromParts` — the same implementation both the host and the worker bridge use, so this is
// the production path and not a parallel one.

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))

const openChat = (db: Database.Interface["db"], input: { id: SessionSchema.ID; agent: string }) =>
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

const ARIS = "ses_aris" as SessionSchema.ID
const THERON = "ses_theron" as SessionSchema.ID

/**
 * The hops stamped on the newest thing admitted into a chat — what the receiver will read.
 *
 * ⚠️ Reads `session_input`, not `session_message`: `SessionInput.admit` queues the prompt and the
 * MESSAGE row is written when a runner promotes it. Measured while writing this test — asserting
 * against `session_message` found zero rows and would have read as "the stamp is missing".
 */
const stampedHops = (db: Database.Interface["db"], session: SessionSchema.ID) =>
  db
    .select({ prompt: SessionInputTable.prompt, seq: SessionInputTable.admitted_seq })
    .from(SessionInputTable)
    .where(eq(SessionInputTable.session_id, session))
    .orderBy(desc(SessionInputTable.admitted_seq))
    .limit(1)
    .all()
    .pipe(
      Effect.map((rows) => (rows[0]?.prompt as { origin?: { hops?: number } } | undefined)?.origin?.hops),
      Effect.orDie,
    )

/**
 * Stand in for the RUNNER: turn what was just admitted into the receiver's user message.
 *
 * 🔴 Named rather than hidden. In production a queued prompt becomes a `session_message` row when the
 * receiving session next runs, and `lastPeerContext` reads that table — so a chain test with no
 * runner has to close that one link itself. Everything either side of it is the production path:
 * the origin copied here is the one `deliver` actually stamped, byte for byte.
 */
let promoted = 0
const promote = (db: Database.Interface["db"], session: SessionSchema.ID) =>
  Effect.gen(function* () {
    const rows = yield* db
      .select({ prompt: SessionInputTable.prompt, id: SessionInputTable.id })
      .from(SessionInputTable)
      .where(eq(SessionInputTable.session_id, session))
      .orderBy(desc(SessionInputTable.admitted_seq))
      .limit(1)
      .all()
      .pipe(Effect.orDie)
    const row = rows[0]
    if (row === undefined) return
    promoted += 1
    yield* db
      .insert(SessionMessageTable)
      .values([
        {
          id: `msg_promoted_${promoted}`,
          session_id: session,
          type: "user",
          seq: promoted,
          data: row.prompt,
          time_created: promoted,
        } as never,
      ])
      .run()
      .pipe(Effect.orDie)
  })

/**
 * The chat opener this graph supplies. `fromParts` REQUIRES one (see its `chat` docblock): a graph
 * that omits it cannot tell "there is no such colleague" from "they exist and no row has been written
 * yet", and would report the second as the first. Every colleague here is seeded by `openChat(...)`
 * above, so the honest opener is the real lookup.
 */
const chatOpener = (db: Database.Interface["db"]) => (colleague: string) =>
  RosterChat.chatFor(db, colleague).pipe(
    Effect.map((row) => (row === undefined ? undefined : SessionSchema.ID.make(row.id))),
  )

const handoff = (
  db: Database.Interface["db"],
  events: EventV2.Interface,
  agents: Record<string, string>,
  superiors: Record<string, string> = {},
  parents: Record<string, SessionSchema.ID> = {},
) =>
  ColleagueHandoff.fromParts({
    db,
    events,
    session: (id) => Effect.succeed({ agent: agents[String(id)], parentID: parents[String(id)] }),
    wake: () => Effect.succeed(true),
    store: {} as never,
    chat: chatOpener(db),
    roster: Effect.succeed([...new Set(["nova", ...Object.values(agents).filter(Boolean)])].map((id) => ({ id, superior: superiors[id] ?? "nova" })) as never),
    refresh: Effect.void,
    takenNames: Effect.succeed([]),
    forget: () => Effect.void,
  })

describe("the colleague loop is bounded by a mechanism", () => {
  it.effect("a hop stamped on one delivery is READ BACK by the next", () =>
    Effect.gen(function* () {
      ColleagueBound.reset()
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* openChat(db, { id: ARIS, agent: "aris" })
      yield* openChat(db, { id: THERON, agent: "theron" })
      const deliver = handoff(db, events, { [ARIS]: "aris", [THERON]: "theron" })

      // aris → theron. Nothing behind it, so this is hop 1.
      expect(
        (yield* deliver.deliver({ from: ARIS, colleague: "theron", message: "Can you check the ledger?" })).delivered,
      ).toBe(true)
      expect(yield* stampedHops(db, THERON)).toBe(1)
      yield* promote(db, THERON)

      // theron → aris. Theron's own inbox now holds a hop-1 message, so its reply is hop 2. If the
      // count restarted here the cap could never be reached and the mechanism would be decorative.
      expect((yield* deliver.deliver({ from: THERON, colleague: "aris", message: "It balances." })).delivered).toBe(
        true,
      )
      expect(yield* stampedHops(db, ARIS)).toBe(2)
    }),
  )

  it.effect("the chain is stored at the cap but no longer wakes another run", () =>
    Effect.gen(function* () {
      ColleagueBound.reset()
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* openChat(db, { id: ARIS, agent: "aris" })
      yield* openChat(db, { id: THERON, agent: "theron" })
      const deliver = handoff(db, events, { [ARIS]: "aris", [THERON]: "theron" })

      let from = ARIS
      let to = "theron"
      let deferred: string | undefined
      // One more round trip than the cap allows.
      for (let n = 0; n < ColleagueBound.HOP_CAP + 1; n++) {
        const outcome = yield* deliver.deliver({ from, colleague: to, message: `turn ${n}` })
        expect(outcome.delivered).toBe(true)
        deferred = outcome.deferred
        yield* promote(db, to === "theron" ? THERON : ARIS)
        ;[from, to] = from === ARIS ? [THERON, "aris"] : [ARIS, "theron"]
      }

      expect(deferred).toBeDefined()
      const inbox = yield* db.select({ id: SessionInputTable.id }).from(SessionInputTable).all().pipe(Effect.orDie)
      expect(inbox.length).toBe(ColleagueBound.HOP_CAP + 1)
    }),
  )

  it.effect("the USER speaking resets the chain", () =>
    Effect.gen(function* () {
      ColleagueBound.reset()
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* openChat(db, { id: ARIS, agent: "aris" })
      yield* openChat(db, { id: THERON, agent: "theron" })
      const deliver = handoff(db, events, { [ARIS]: "aris", [THERON]: "theron" })

      yield* deliver.deliver({ from: ARIS, colleague: "theron", message: "one" })
      yield* promote(db, THERON)
      yield* deliver.deliver({ from: THERON, colleague: "aris", message: "two" })
      yield* promote(db, ARIS)
      expect(yield* stampedHops(db, ARIS)).toBe(2)

      // A person writes into aris's chat — an ordinary composer message, no agent origin.
      yield* db
        .insert(SessionMessageTable)
        .values([
          {
            id: "msg_user",
            session_id: ARIS,
            type: "user",
            seq: 9_999,
            data: { text: "Actually, do this instead." },
            time_created: 2,
          } as never,
        ])
        .run()
        .pipe(Effect.orDie)

      // 🔴 Back to hop 1. This is the entire user exemption, and it falls out of the transcript
      // rather than a flag — the person re-authorizing the chain IS them speaking in it.
      yield* deliver.deliver({ from: ARIS, colleague: "theron", message: "three" })
      expect(yield* stampedHops(db, THERON)).toBe(1)
    }),
  )
})

describe("the chain of command is a delivery route", () => {
  it.effect("a failed wake cannot turn a stored message into a failed send", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* openChat(db, { id: ARIS, agent: "aris" })
      yield* openChat(db, { id: THERON, agent: "theron" })
      const bridge = ColleagueHandoff.fromParts({
        db, events,
        session: (id) => Effect.succeed({ agent: id === ARIS ? "aris" : "theron" }),
        wake: () => Effect.die("executor unavailable"),
        store: {} as never,
        chat: chatOpener(db),
        roster: Effect.succeed([{ id: "nova" }, { id: "aris" }, { id: "theron" }] as never),
        refresh: Effect.void,
        takenNames: Effect.succeed([]),
        forget: () => Effect.void,
      })
      const outcome = yield* bridge.deliver({ from: ARIS, colleague: "theron", message: "important" })
      expect(outcome.delivered).toBe(true)
      expect(outcome.started).toBe(false)
      expect((yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, THERON)).all()).length).toBe(1)
    }),
  )

  it.effect("an officer's message to Nova is stored with the immediate superior", () =>
    Effect.gen(function* () {
      ColleagueBound.reset()
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const iris = "ses_iris" as SessionSchema.ID
      const daedalus = "ses_daedalus" as SessionSchema.ID
      yield* openChat(db, { id: iris, agent: "iris" })
      yield* openChat(db, { id: daedalus, agent: "daedalus" })
      const outcome = yield* handoff(db, events, { [iris]: "iris", [daedalus]: "daedalus" }, { iris: "daedalus" })
        .deliver({ from: iris, colleague: "nova", message: "urgent report" })
      expect(outcome.delivered).toBe(true)
      expect(outcome.recipient).toBe("daedalus")
      expect(outcome.redirected).toBe(true)
      expect((yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, daedalus)).all()).length).toBe(1)
    }),
  )

  it.effect("an anonymous worker's attempted jump to Nova lands with its parent session", () =>
    Effect.gen(function* () {
      ColleagueBound.reset()
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      const parent = "ses_parent" as SessionSchema.ID
      const worker = "ses_worker" as SessionSchema.ID
      yield* openChat(db, { id: parent, agent: "iris" })
      yield* openChat(db, { id: worker, agent: "worker" })
      const outcome = yield* handoff(db, events, { [parent]: "iris", [worker]: "iris" }, { iris: "nova" }, { [worker]: parent })
        .deliver({ from: worker, colleague: "nova", message: "worker report" })
      expect(outcome.delivered).toBe(true)
      expect(outcome.recipient).toBe(String(parent))
      const queued = yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, parent)).all()
      expect(queued.length).toBe(1)
      expect(queued[0]?.prompt.text).toContain('op "message_worker"')
      expect(queued[0]?.prompt.text).toContain(`worker "${worker}"`)
    }),
  )
})
