import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AgentV2 } from "../agent"
import { Database } from "../database/database"
import { AgentRetirementTable } from "./retirement.sql"
import { AgentRetirement } from "./retirement"
import { ColleagueNote } from "../session/colleague-note"
import { SessionSchema } from "../session/schema"
import { SessionMessage } from "../session/message"
import { SessionMessageTable, SessionTable } from "../session/sql"
import { testEffect } from "../../test/lib/effect"
import { list, memberIDs, project } from "./team-chat"

const dbIt = testEffect(Database.layerFromPath(":memory:"))

const officer = (id: string, superior?: string, kind?: "agent" | "chat" | "human") =>
  AgentV2.Info.make({
    id: AgentV2.ID.make(id),
    request: { headers: {}, body: {} },
    mode: "primary",
    hidden: false,
    permissions: [],
    ...(superior === undefined ? {} : { superior: AgentV2.ID.make(superior) }),
    ...(kind === undefined ? {} : { kind }),
  })

describe("officer team chat membership", () => {
  test("includes the officer's whole reporting tree, so siblings can be read together", () => {
    const roster = [
      officer("nova"),
      officer("theron"),
      officer("iris", "theron"),
      officer("lyra", "theron"),
      officer("dione", "iris"),
      officer("other"),
    ]
    expect(memberIDs(roster, "theron")).toEqual(["theron", "iris", "lyra", "dione"])
  })

  test("does not turn chat, human, hidden, or anonymous staff entries into officers", () => {
    const roster = [
      officer("nova"),
      officer("theron"),
      officer("chatty", "theron", "chat"),
      officer("owner", "theron", "human"),
      AgentV2.Info.make({
        id: AgentV2.ID.make("worker"),
        request: { headers: {}, body: {} },
        mode: "subagent",
        hidden: false,
        permissions: [],
        superior: AgentV2.ID.make("theron"),
      }),
    ]
    expect(memberIDs(roster, "theron")).toEqual(["theron"])
    expect(memberIDs(roster, "chatty")).toEqual([])
  })

  test("keeps sibling deliveries, removes routing notes, and excludes outsiders", () => {
    const note = ColleagueNote.compose({ message: "The build is green.", from: "iris", turn: "ask" })
    expect(
      project(
        [
          {
            id: "msg_one",
            recipient: AgentV2.ID.make("lyra"),
            created: 1,
            data: { sender: "iris", turn: "ask", text: note },
          },
          {
            id: "msg_two",
            recipient: AgentV2.ID.make("lyra"),
            created: 2,
            data: { sender: "outside", turn: "ask", text: "ignore" },
          },
          {
            id: "msg_three",
            recipient: AgentV2.ID.make("outside"),
            created: 3,
            data: { sender: "iris", turn: "ask", text: "ignore" },
          },
        ],
        ["theron", "iris", "lyra"],
      ),
    ).toEqual([
      {
        id: SessionMessage.ID.make("msg_one"),
        sender: AgentV2.ID.make("iris"),
        recipient: AgentV2.ID.make("lyra"),
        turn: "ask",
        text: "The build is green.",
        created: 1,
      },
    ])
  })
})

describe("officer team chat storage", () => {
  dbIt.effect("a same-millisecond replacement starts strictly after every retirement cutoff", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* AgentRetirement.record(db, "iris", 100)
      yield* AgentRetirement.record(db, "iris", 100)
      expect(yield* AgentRetirement.nextCreatedAt(db, "iris", 100)).toBe(101)
      expect(yield* db.select().from(AgentRetirementTable).all().pipe(Effect.orDie)).toHaveLength(2)
    }),
  )

  dbIt.effect("keeps ordinary archived history while paging the current officer's team", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const roster = [officer("nova"), officer("theron"), officer("iris", "theron")]
      yield* db
        .insert(SessionTable)
        .values([
          {
            id: SessionSchema.ID.make("ses_iris_old"),
            slug: "iris-old",
            directory: process.cwd(),
            title: "Iris old",
            version: "test",
            agent: "iris",
            time_created: 1,
            time_updated: 1,
            time_archived: 10,
          },
          {
            id: SessionSchema.ID.make("ses_iris_live"),
            slug: "iris-live",
            directory: process.cwd(),
            title: "Iris live",
            version: "test",
            agent: "iris",
            time_created: 11,
            time_updated: 11,
          },
        ])
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          {
            id: "msg_archived",
            session_id: SessionSchema.ID.make("ses_iris_old"),
            type: "colleague",
            seq: 1,
            time_created: 2,
            data: { sender: "theron", turn: "ask", text: "stale predecessor" },
          },
          ...[20, 30, 40].map((created, index) => ({
            id: `msg_live_${index + 1}`,
            session_id: SessionSchema.ID.make("ses_iris_live"),
            type: "colleague" as const,
            seq: index + 1,
            time_created: created,
            data: { sender: "theron", turn: "ask" as const, text: `live ${index + 1}` },
          })),
        ] as never)
        .run()
        .pipe(Effect.orDie)

      const newest = yield* list(db, roster, "theron", { limit: 2 })
      expect(newest.data.map((message) => message.id)).toEqual([
        SessionMessage.ID.make("msg_live_2"),
        SessionMessage.ID.make("msg_live_3"),
      ])
      expect(newest.cursor.older).toBeDefined()
      expect(newest.data.some((message) => message.text.includes("predecessor"))).toBe(false)

      const older = yield* list(db, roster, "theron", { limit: 2, before: newest.cursor.older })
      expect(older.data.map((message) => message.id)).toEqual([
        SessionMessage.ID.make("msg_archived"),
        SessionMessage.ID.make("msg_live_1"),
      ])
      expect(older.cursor.older).toBeUndefined()

      yield* db
        .insert(SessionMessageTable)
        .values({
          id: "msg_live_4",
          session_id: SessionSchema.ID.make("ses_iris_live"),
          type: "colleague",
          seq: 4,
          time_created: 50,
          data: { sender: "theron", turn: "answer", text: "live 4" },
        } as never)
        .run()
        .pipe(Effect.orDie)
      const tail = yield* list(db, roster, "theron", { after: newest.cursor.latest })
      expect(tail.data.map((message) => message.id)).toEqual([SessionMessage.ID.make("msg_live_4")])
    }),
  )

  dbIt.effect("excludes both sides of a retired identity after its officer ID is reused", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const roster = [officer("nova"), officer("theron"), officer("iris", "theron"), officer("lyra", "theron")]
      yield* db
        .insert(SessionTable)
        .values([
          {
            id: SessionSchema.ID.make("ses_iris_predecessor"),
            slug: "iris-predecessor",
            directory: process.cwd(),
            title: "Retired Iris",
            version: "test",
            agent: "iris",
            time_created: 10,
            time_updated: 100,
            time_archived: 100,
          },
          {
            id: SessionSchema.ID.make("ses_lyra"),
            slug: "lyra",
            directory: process.cwd(),
            title: "Lyra",
            version: "test",
            agent: "lyra",
            time_created: 10,
            time_updated: 120,
          },
          {
            id: SessionSchema.ID.make("ses_iris_current"),
            slug: "iris-current",
            directory: process.cwd(),
            title: "Current Iris",
            version: "test",
            agent: "iris",
            time_created: 120,
            time_updated: 130,
          },
          {
            id: SessionSchema.ID.make("ses_iris_at_cutoff"),
            slug: "iris-at-cutoff",
            directory: process.cwd(),
            title: "Ambiguous Iris",
            version: "test",
            agent: "iris",
            time_created: 110,
            time_updated: 130,
            time_archived: 115,
          },
        ])
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(AgentRetirementTable)
        .values({ agent: "iris", retired_at: 110 })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          {
            id: "msg_old_recipient",
            session_id: SessionSchema.ID.make("ses_iris_predecessor"),
            type: "colleague",
            seq: 1,
            time_created: 20,
            data: { sender: "theron", turn: "ask", text: "old recipient" },
          },
          {
            id: "msg_old_sender",
            session_id: SessionSchema.ID.make("ses_lyra"),
            type: "colleague",
            seq: 1,
            time_created: 105,
            data: { sender: "iris", turn: "ask", text: "old sender" },
          },
          {
            id: "msg_current",
            session_id: SessionSchema.ID.make("ses_iris_current"),
            type: "colleague",
            seq: 1,
            time_created: 130,
            data: { sender: "theron", turn: "ask", text: "current identity" },
          },
          {
            id: "msg_recipient_at_cutoff",
            session_id: SessionSchema.ID.make("ses_iris_at_cutoff"),
            type: "colleague",
            seq: 1,
            time_created: 130,
            data: { sender: "theron", turn: "ask", text: "ambiguous recipient" },
          },
          {
            id: "msg_current_sender_equal",
            session_id: SessionSchema.ID.make("ses_lyra"),
            type: "colleague",
            seq: 2,
            time_created: 110,
            data: {
              sender: "iris",
              senderSessionID: "ses_iris_current",
              turn: "answer",
              text: "current sender at cutoff",
            },
          },
        ] as never)
        .run()
        .pipe(Effect.orDie)

      const page = yield* list(db, roster, "theron")
      expect(page.data.map((message) => message.id)).toEqual([
        SessionMessage.ID.make("msg_current_sender_equal"),
        SessionMessage.ID.make("msg_current"),
      ])
    }),
  )

  dbIt.effect("malformed legacy rows advance both older and live-tail cursors", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const roster = [officer("nova"), officer("theron"), officer("iris", "theron")]
      const sessionID = SessionSchema.ID.make("ses_iris_cursor")
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          slug: "iris-cursor",
          directory: process.cwd(),
          title: "Iris",
          version: "test",
          agent: "iris",
          time_created: 1,
          time_updated: 1,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          {
            id: "msg_valid_old",
            session_id: sessionID,
            type: "colleague",
            seq: 1,
            time_created: 10,
            data: { sender: "theron", turn: "ask", text: "old" },
          },
          {
            id: "msg_malformed_older",
            session_id: sessionID,
            type: "colleague",
            seq: 2,
            time_created: 20,
            data: { sender: "theron", turn: "broken", text: "skip" },
          },
          {
            id: "msg_valid_new",
            session_id: sessionID,
            type: "colleague",
            seq: 3,
            time_created: 30,
            data: { sender: "theron", turn: "answer", text: "new" },
          },
        ] as never)
        .run()
        .pipe(Effect.orDie)

      const newest = yield* list(db, roster, "theron", { limit: 1 })
      const malformedOlder = yield* list(db, roster, "theron", { limit: 1, before: newest.cursor.older })
      expect(malformedOlder.data).toEqual([])
      expect(malformedOlder.cursor.older).toBeDefined()
      const oldest = yield* list(db, roster, "theron", { limit: 1, before: malformedOlder.cursor.older })
      expect(oldest.data.map((message) => message.id)).toEqual([SessionMessage.ID.make("msg_valid_old")])

      yield* db
        .insert(SessionMessageTable)
        .values([
          {
            id: "msg_malformed_tail",
            session_id: sessionID,
            type: "colleague",
            seq: 4,
            time_created: 40,
            data: { sender: "theron", turn: "broken", text: "skip" },
          },
          {
            id: "msg_valid_tail",
            session_id: sessionID,
            type: "colleague",
            seq: 5,
            time_created: 50,
            data: { sender: "theron", turn: "announce", text: "tail" },
          },
        ] as never)
        .run()
        .pipe(Effect.orDie)
      const malformedTail = yield* list(db, roster, "theron", { limit: 1, after: newest.cursor.latest })
      expect(malformedTail.data).toEqual([])
      expect(malformedTail.cursor.latest).not.toBe(newest.cursor.latest)
      const tail = yield* list(db, roster, "theron", { limit: 1, after: malformedTail.cursor.latest })
      expect(tail.data.map((message) => message.id)).toEqual([SessionMessage.ID.make("msg_valid_tail")])
    }),
  )
})
