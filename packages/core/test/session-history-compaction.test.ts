import { expect, test } from "bun:test"
import { asc, eq } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { SessionHistory } from "@novaclaw/core/session/history"
import { SessionMessage } from "@novaclaw/core/session/message"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionCompactionTable, SessionMessageTable, SessionTable } from "@novaclaw/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node])))
const sessionID = SessionSchema.ID.make("ses_compaction_overlay_test")
const created = DateTime.makeUnsafe(1)
const encode = Schema.encodeSync(SessionMessage.Message)

const row = (id: string, seq: number, text: string) => {
  const encoded = encode(
    SessionMessage.User.make({ id: SessionMessage.ID.make(id), type: "user", text, time: { created } }),
  )
  const { id: messageID, type, ...data } = encoded
  return {
    id: SessionMessage.ID.make(messageID),
    session_id: sessionID,
    type,
    seq,
    time_created: DateTime.toEpochMillis(created),
    data,
  }
}

test("keeps prefix identity stable across presentation-only tool labels", () => {
  const base = {
    id: "msg_tool",
    type: "assistant",
    seq: 1,
    time_created: 1,
    time_updated: 1,
    data: {
      content: [
        {
          type: "tool",
          id: "call_1",
          name: "shell",
          title: "Shell command",
          state: {
            status: "completed",
            input: { command: "pwd", title: "model-visible input" },
            content: [{ type: "text", text: "/repo" }],
          },
        },
      ],
    },
  } as const
  const before = SessionHistory.canonicalPrefixHash([base] as never)
  const labelled = {
    ...base,
    time_updated: 2,
    data: { content: [{ ...base.data.content[0], title: "Check the working directory" }] },
  }
  expect(SessionHistory.canonicalPrefixHash([labelled] as never)).toBe(before)

  const changedResult = {
    ...labelled,
    data: {
      content: [
        {
          ...labelled.data.content[0],
          state: {
            ...labelled.data.content[0].state,
            content: [{ type: "text", text: "/different-repo" }],
          },
        },
      ],
    },
  }
  expect(SessionHistory.canonicalPrefixHash([changedResult] as never)).not.toBe(before)

  const changedInput = {
    ...labelled,
    data: {
      content: [
        {
          ...labelled.data.content[0],
          state: { ...labelled.data.content[0].state, input: { command: "pwd", title: "changed input" } },
        },
      ],
    },
  }
  expect(SessionHistory.canonicalPrefixHash([changedInput] as never)).not.toBe(before)
})

it.effect("keeps transcript source rows and rejects a stale derived compaction prefix", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({ id: sessionID, slug: "test", directory: "/project", title: "test", version: "test" })
      .run()
      .pipe(Effect.orDie)
    yield* db
      .insert(SessionMessageTable)
      .values([
        row("msg_prefix_1", 1, "first"),
        row("msg_prefix_2", 2, "second"),
        // This message arrived after summarization started. It must remain after the overlay even
        // though the compaction event itself has a later durable sequence.
        row("msg_concurrent", 3, "arrived during summary"),
      ])
      .run()
      .pipe(Effect.orDie)
    const prefixHash = yield* SessionHistory.prefixHash(db, sessionID, 2)
    yield* db
      .insert(SessionCompactionTable)
      .values({
        id: SessionMessage.ID.make("msg_overlay"),
        session_id: sessionID,
        seq: 5,
        prefix_seq: 2,
        prefix_hash: prefixHash,
        reason: "auto",
        summary: "first two messages summarized",
        recent: "second",
        time_created: 2,
      })
      .run()
      .pipe(Effect.orDie)

    expect(
      (yield* db
        .select({ id: SessionMessageTable.id })
        .from(SessionMessageTable)
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)).map((item) => String(item.id)),
    ).toEqual(["msg_prefix_1", "msg_prefix_2", "msg_concurrent"])
    expect((yield* SessionHistory.entriesForRunner(db, sessionID, 0)).map((entry) => entry.message.type)).toEqual([
      "compaction",
      "user",
    ])
    expect((yield* SessionHistory.entriesForRunner(db, sessionID, 0)).at(-1)?.message).toMatchObject({
      type: "user",
      text: "arrived during summary",
    })

    const source = yield* db
      .select({ data: SessionMessageTable.data })
      .from(SessionMessageTable)
      .where(eq(SessionMessageTable.id, SessionMessage.ID.make("msg_prefix_1")))
      .get()
      .pipe(Effect.orDie)
    yield* db
      .update(SessionMessageTable)
      .set({
        data: { ...source!.data, text: "changed history" } as typeof SessionMessageTable.$inferInsert.data,
      })
      .where(eq(SessionMessageTable.id, SessionMessage.ID.make("msg_prefix_1")))
      .run()
      .pipe(Effect.orDie)

    const fallback = yield* SessionHistory.entriesForRunner(db, sessionID, 0)
    expect(fallback.map((entry) => entry.message.type)).toEqual(["user", "user", "user"])
    expect(fallback[0]?.message).toMatchObject({ type: "user", text: "changed history" })
  }),
)
