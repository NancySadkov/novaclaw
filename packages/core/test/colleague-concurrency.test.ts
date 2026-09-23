import { describe, expect } from "bun:test"
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

/**
 * OFFICERS TALKING AT THE SAME TIME — cycles, races and the shapes that could hang.
 *
 * 🔴 `colleague-loop-bound.test.ts` drives one chain, one message at a time. That is the easy half.
 * What a corporation of agents actually does is talk CONCURRENTLY and in RINGS, and those are the
 * shapes where a bound either holds or is decorative:
 *
 *   - a RING (A→B→C→A) is the loop nobody in it can see: every hop is a reasonable hand-off, and only
 *     a counter that survives the whole circuit can stop it;
 *   - SIMULTANEOUS sends share one rate window, which is a `Map` read-modify-write — the classic place
 *     an allowance leaks;
 *   - MUTUAL sends (A→B while B→A) each read the other's transcript mid-write, which is where a
 *     deadlock would live if delivery took locks in a fixed order.
 *
 * ⚠️ Every test here has a WALL-CLOCK bound. A deadlock's failure mode is "never returns", and a
 * suite that hangs reports nothing at all — `Effect.timeout` turns that into a red test with a name.
 */

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))

/** No delivery in this file should take anywhere near this. It exists to make a hang legible. */
const NO_HANG = "20 seconds"

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

/**
 * The chat opener this graph supplies. `fromParts` REQUIRES one (see its `chat` docblock): a graph
 * that omits it cannot tell "there is no such colleague" from "they exist and no row has been written
 * yet", and would report the second as the first — telling a model a colleague on its own roster does
 * not exist. These tests seed every colleague's chat directly, so the honest opener is the real
 * lookup; the lazy window `ensureLiveChat` closes is not what this file is about.
 */
const opener = (db: Database.Interface["db"]) => (colleague: string) =>
  RosterChat.chatFor(db, colleague).pipe(
    Effect.map((row) => (row === undefined ? undefined : SessionSchema.ID.make(row.id))),
  )

const handoff = (db: Database.Interface["db"], events: EventV2.Interface, agents: Record<string, string>) =>
  ColleagueHandoff.fromParts({
    db,
    events,
    session: (id) => Effect.succeed({ agent: agents[String(id)] }),
    wake: () => Effect.succeed(true),
    store: {} as never,
    chat: opener(db),
    roster: Effect.succeed([...new Set(["nova", ...Object.values(agents)])].map((id) => ({ id, superior: "nova" })) as never),
    refresh: Effect.void,
    takenNames: Effect.succeed([]),
    forget: () => Effect.void,
  })

/**
 * Stand in for the runner: turn what was admitted into the receiver's user message.
 *
 * In production a queued prompt becomes a `session_message` row when the receiving session next runs,
 * and `lastPeerContext` reads that table — so a chain test with no runner has to close that one link
 * itself. The origin copied here is the one `deliver` actually stamped.
 */
let promoted = 0
const promote = (db: Database.Interface["db"], session: SessionSchema.ID) =>
  Effect.gen(function* () {
    const rows = yield* db
      .select({ prompt: SessionInputTable.prompt })
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
          id: `msg_c_${promoted}`,
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

const ARIS = "ses_aris" as SessionSchema.ID
const THERON = "ses_theron" as SessionSchema.ID
const KALLIAS = "ses_kallias" as SessionSchema.ID

const ROSTER = { [ARIS]: "aris", [THERON]: "theron", [KALLIAS]: "kallias" }
const SESSION_OF: Record<string, SessionSchema.ID> = { aris: ARIS, theron: THERON, kallias: KALLIAS }

const openAll = (db: Database.Interface["db"]) =>
  Effect.gen(function* () {
    yield* chat(db, { id: ARIS, agent: "aris" })
    yield* chat(db, { id: THERON, agent: "theron" })
    yield* chat(db, { id: KALLIAS, agent: "kallias" })
  })

const admitted = (db: Database.Interface["db"]) =>
  db
    .select({ id: SessionInputTable.id })
    .from(SessionInputTable)
    .all()
    .pipe(
      Effect.map((rows) => rows.length),
      Effect.orDie,
    )

describe("a RING of officers terminates", () => {
  it.effect("A→B→C→A is stored at the closing hop without waking the cycle", () =>
    Effect.gen(function* () {
      ColleagueBound.reset()
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* openAll(db)
      const bridge = handoff(db, events, ROSTER)

      // 🔴 The shape no participant can see. Each colleague passes work to the NEXT one, which is a
      // perfectly reasonable thing to do, and the loop only exists when you stand outside the ring.
      const ring = ["aris", "theron", "kallias"] as const
      let deferred: string | undefined
      // Bounded well above the cap: if the counter did not survive the circuit this would run to the
      // limit and the assertion below would catch it, rather than the test hanging.
      for (let turn = 0; turn < 12; turn++) {
        const from = ring[turn % ring.length]!
        const to = ring[(turn + 1) % ring.length]!
        const outcome = yield* bridge.deliver({ from: SESSION_OF[from]!, colleague: to, message: `pass ${turn}` })
        expect(outcome.delivered).toBe(true)
        if (outcome.deferred !== undefined) {
          deferred = outcome.deferred
          break
        }
        yield* promote(db, SESSION_OF[to]!)
      }

      expect(deferred).toContain("loop")
      // ⚠️ THREE, and each one is a different fact — this used to be `toBe(HOP_CAP)`.
      //
      // Two are the hops that made progress (aris→theron, theron→kallias). The circuit is then cut
      // at the hop that would CLOSE it — kallias→aris, with aris already on the path — where the
      // old depth counter would have let a full lap and a half run first ("roughly two laps late").
      //
      // The third is the notice to the ORIGINATOR: aris started this chain and is the only
      // participant that can dissolve it, so it is told the chain came back around. Nothing else
      // in the field does that, and counting it here is what stops it being quietly dropped.
      expect(yield* admitted(db)).toBe(3)
    }).pipe(Effect.timeout(NO_HANG)),
  )
})

describe("simultaneous hand-offs", () => {
  it.effect("one sender's concurrent sends cannot exceed its allowance", () =>
    Effect.gen(function* () {
      ColleagueBound.reset()
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* openAll(db)
      const bridge = handoff(db, events, ROSTER)

      // 🔴 The rate window is a read-modify-write on a Map. Fired sequentially it obviously holds;
      // fired together, a lost update would let a colleague spend more than its allowance — and the
      // window exists precisely for a model that has stopped reading and is hammering.
      const attempts = ColleagueBound.RATE_LIMIT + 6
      const results = yield* Effect.all(
        Array.from({ length: attempts }, (_, n) =>
          bridge.deliver({ from: ARIS, colleague: "theron", message: `burst ${n}` }),
        ),
        { concurrency: "unbounded" },
      )

      const delivered = results.filter((r) => r.delivered).length
      expect(delivered).toBe(attempts)
      expect(results.filter((r) => r.started).length).toBeLessThanOrEqual(ColleagueBound.RATE_LIMIT)
      for (const result of results.filter((r) => !r.started)) expect(result.deferred).toBeTruthy()
      // What was admitted matches what was reported. If these disagree the sender is being told one
      // thing while the receiver got another.
      expect(yield* admitted(db)).toBe(delivered)
    }).pipe(Effect.timeout(NO_HANG)),
  )

  it.effect("two colleagues writing to each OTHER at once both complete", () =>
    Effect.gen(function* () {
      ColleagueBound.reset()
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* openAll(db)
      const bridge = handoff(db, events, ROSTER)

      // 🔴 The deadlock shape. Each delivery READS the sender's transcript and WRITES the
      // receiver's; run mutually, a lock taken per session in a fixed order would have A holding
      // aris while waiting for theron and B the reverse. The timeout is what makes that legible —
      // without it the suite would simply stop.
      const [a, b] = yield* Effect.all(
        [
          bridge.deliver({ from: ARIS, colleague: "theron", message: "from aris" }),
          bridge.deliver({ from: THERON, colleague: "aris", message: "from theron" }),
        ],
        { concurrency: "unbounded" },
      )

      expect(a.delivered).toBe(true)
      expect(b.delivered).toBe(true)
      expect(yield* admitted(db)).toBe(2)
    }).pipe(Effect.timeout(NO_HANG)),
  )

  it.effect("a colleague messaging ITSELF is refused, not admitted into its own chat", () =>
    Effect.gen(function* () {
      ColleagueBound.reset()
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* openAll(db)
      const bridge = handoff(db, events, ROSTER)

      // 🔴 THIS TEST FOUND A REAL HOLE. `ColleagueTool.addressable` filters the sender out of the
      // roster it offers, and that is the layer a model meets — so the rule READ as though it were
      // everywhere. It was not: `deliver` admitted a self-message, appending to the conversation the
      // sender is currently having. An infinite regress it cannot see it is starting, and one the
      // hop counter cannot bound because every lap looks like a fresh ask.
      const outcome = yield* bridge.deliver({ from: ARIS, colleague: "aris", message: "note to self" })
      expect(outcome.delivered).toBe(false)
      expect(outcome.refused).toContain("own chat")
      // Nothing written. A refusal that still admitted would be the worst of both.
      expect(yield* admitted(db)).toBe(0)
    }).pipe(Effect.timeout(NO_HANG)),
  )
})
