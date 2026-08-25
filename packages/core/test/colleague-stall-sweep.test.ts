import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { ColleagueStall } from "@novaclaw/core/session/colleague-stall"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionInputTable, SessionTable } from "@novaclaw/core/session/sql"
import { Database } from "@novaclaw/core/database/database"
import { testEffect } from "./lib/effect"

/**
 * The sweep, against a real database.
 *
 * The item's falsification, verbatim: *"an ask to a colleague whose chat never wakes must produce
 * exactly one notice, and a normal ask→answer round trip must produce none."* Both are here, and the
 * "exactly one" is the half a unit test cannot reach — it is a property of running the sweep twice.
 */

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))

const ARIS = "ses_aris" as SessionSchema.ID
const THERON = "ses_theron" as SessionSchema.ID
const HOUR = 60 * 60_000

const chat = (db: Database.Interface["db"], id: SessionSchema.ID, agent: string) =>
  db
    .insert(SessionTable)
    .values([
      {
        id,
        slug: id,
        directory: process.cwd(),
        title: `${agent}'s chat`,
        version: "test",
        agent,
        time_created: 1,
        time_updated: 1,
      },
    ])
    .run()
    .pipe(Effect.orDie)

/** A peer message that landed in `session`, sent by `from`, at `at`. */
const landed = (
  db: Database.Interface["db"],
  session: SessionSchema.ID,
  from: string,
  at: number,
  announce?: boolean,
) =>
  db
    .insert(SessionInputTable)
    .values([
      {
        id: `msg_in_${from}_${session}_${at}`,
        session_id: session,
        prompt: {
          text: "the ledger?",
          files: [],
          agents: [],
          origin: { via: "agent", relation: "peer", label: from, ...(announce ? { announce: true } : {}) },
        },
        delivery: "queue",
        admitted_seq: at,
        time_created: at,
      } as never,
    ])
    .run()
    .pipe(Effect.orDie)

const noticesIn = (db: Database.Interface["db"], session: SessionSchema.ID) =>
  db
    .select({ id: SessionInputTable.id, prompt: SessionInputTable.prompt })
    .from(SessionInputTable)
    .where(eq(SessionInputTable.session_id, session))
    .all()
    .pipe(
      Effect.orDie,
      Effect.map((rows) => rows.filter((row) => String(row.id).startsWith("msg_stall_"))),
    )

const twoChats = Effect.gen(function* () {
  const { db } = yield* Database.Service
  yield* chat(db, ARIS, "aris")
  yield* chat(db, THERON, "theron")
  return { db, events: yield* EventV2.Service }
})

describe("the stall sweep", () => {
  it.effect(
    "🔴 an unanswered ask produces EXACTLY ONE notice, however often the sweep runs",
    Effect.gen(function* () {
      const { db, events } = yield* twoChats
      const now = 10 * HOUR
      yield* landed(db, THERON, "aris", now - 2 * HOUR)

      const first = yield* ColleagueStall.sweep(db, events, now)
      // The tick fires every 30 s. Without a memory of having told them, the asker's chat fills with
      // the same notice twice a minute — which is a worse failure than the silence it replaces.
      const second = yield* ColleagueStall.sweep(db, events, now)

      expect(first).toBe(1)
      expect(second).toBe(0)
      const notices = yield* noticesIn(db, ARIS)
      expect(notices.length).toBe(1)
      expect(JSON.stringify(notices[0]!.prompt)).toContain("theron")
    }),
  )

  it.effect(
    "🔴 an ANNOUNCE copy in the database produces no notice — through the real query",
    Effect.gen(function* () {
      const { db, events } = yield* twoChats
      const now = 10 * HOUR
      yield* landed(db, THERON, "aris", now - 2 * HOUR, true)

      // ⚠️ The pure rule is tested elsewhere; this pins the WIRE. The sweep reads `announce`
      // with `json_extract`, which returns SQLite's 0/1 rather than a boolean — so a mapping
      // written as `announce: row.announce` would be truthy for BOTH values and silence every
      // genuine stall, while `=== true` would be false for both and silence none.
      expect(yield* ColleagueStall.sweep(db, events, now)).toBe(0)
      expect((yield* noticesIn(db, ARIS)).length).toBe(0)
    }),
  )

  it.effect(
    "a normal ask→answer round trip produces NONE",
    Effect.gen(function* () {
      const { db, events } = yield* twoChats
      const now = 10 * HOUR
      yield* landed(db, THERON, "aris", now - 2 * HOUR)
      yield* landed(db, ARIS, "theron", now - 1 * HOUR)

      expect(yield* ColleagueStall.sweep(db, events, now)).toBe(0)
      expect((yield* noticesIn(db, ARIS)).length).toBe(0)
    }),
  )

  it.effect(
    "a FRESH ask is left alone",
    Effect.gen(function* () {
      const { db, events } = yield* twoChats
      const now = 10 * HOUR
      yield* landed(db, THERON, "aris", now - 60_000)
      expect(yield* ColleagueStall.sweep(db, events, now)).toBe(0)
    }),
  )

  it.effect(
    "⚠️ the notice carries NO peer origin — it is the instance speaking, not a colleague",
    Effect.gen(function* () {
      const { db, events } = yield* twoChats
      const now = 10 * HOUR
      yield* landed(db, THERON, "aris", now - 2 * HOUR)
      yield* ColleagueStall.sweep(db, events, now)

      // A peer origin would put the notice on the next path, make it answerable, and count it as a
      // hop — a stall report that starts a chain.
      const prompt = (yield* noticesIn(db, ARIS))[0]!.prompt as { origin?: unknown }
      expect(prompt.origin).toBeUndefined()
    }),
  )
})
