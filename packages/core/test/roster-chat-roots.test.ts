import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { Database } from "@novaclaw/core/database/database"
import { RosterChat } from "@novaclaw/core/session/roster-chat"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionTable } from "@novaclaw/core/session/sql"
import { testEffect } from "./lib/effect"

/**
 * 🔴 EVERY ROOT CHAT OF A COLLEAGUE — the set "Clear chat" must take.
 *
 * `chatFor` is the wrong set for this and using it would be quiet data loss. It hides ARCHIVED chats on
 * purpose, because handing a colleague back the conversation the user just cleared is the one thing it
 * must never do. But a Clear wants the opposite: the transcript the user is LOOKING AT is frequently a
 * filed one. That is the recorded incident behind `chatToClear` — a colleague whose every root carried
 * `time_archived`, including the one on screen, where the clear said "there is nothing to clear" and
 * the transcript stayed.
 *
 * The client used to assemble this set itself, by folding `GET /api/session` — whose documented default
 * is the newest 50 sessions. So a colleague with more history than one page had a Clear that removed
 * part of what it should have and reported success. `allRootsFor` is what makes the set complete, and
 * these cases are the proof of the four facts the client used to be responsible for and can no longer
 * check.
 */
const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node])))

const root = (input: {
  id: string
  agent: string
  created: number
  archived?: number
  parent?: string
}) =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    // Column set copied from `agent-retire.test.ts`'s `openChat`, which is the shape the table
    // actually accepts: `slug`, `version` and `directory` are NOT optional and a minimal insert is
    // refused by a constraint rather than defaulted.
    yield* db
      .insert(SessionTable)
      .values([
        {
          id: SessionSchema.ID.make(input.id),
          slug: input.id,
          directory: process.cwd(),
          title: `${input.agent}'s chat`,
          version: "test",
          agent: input.agent,
          parent_id: input.parent,
          time_created: input.created,
          time_updated: input.created,
          time_archived: input.archived ?? null,
          // `parent_id` and `time_archived` are BRANDED columns, so a plain literal is not assignable
          // even though SQLite stores the values happily. The cast is on the fixture's own row, and
          // every field it covers is set explicitly above — nothing is defaulted by accident.
        } as unknown as typeof SessionTable.$inferInsert,
      ])
      .run()
      .pipe(Effect.orDie)
  })

describe("RosterChat.allRootsFor", () => {
  it.effect("returns every root of that colleague, ARCHIVED INCLUDED, newest first", () =>
    Effect.gen(function* () {
      // ⚠️ ONE live root, not two, and that is the table's own invariant rather than a convenience:
      // `createSessionRecord` enforces one chat per colleague, and the second live root here is
      // refused by a constraint. So the ordering is proven across the live/filed mix, which is the
      // population that actually exists — a colleague's history IS its filed roots.
      yield* root({ id: "ses_old_filed", agent: "theron", created: 1, archived: 50 })
      yield* root({ id: "ses_live", agent: "theron", created: 2 })
      yield* root({ id: "ses_new_filed", agent: "theron", created: 3, archived: 99 })
      const { db } = yield* Database.Service
      const rows = yield* RosterChat.allRootsFor(db, "theron")
      // Newest first, and the FILED ones are present — the whole reason this exists.
      expect(rows.map((row) => row.id)).toEqual(["ses_new_filed", "ses_live", "ses_old_filed"])
      // The archive instant rides along, and is `null` while live — never absent, because absent would
      // be indistinguishable from "unknown" and a Clear must not treat a live chat as a mystery.
      expect(rows.find((row) => row.id === "ses_new_filed")?.archived).toBe(99)
      expect(rows.find((row) => row.id === "ses_live")?.archived).toBeNull()
      // …and `chatFor` picks the same newest row, so the two sets differ in WIDTH and agree in ORDER.
      expect((yield* RosterChat.chatFor(db, "theron"))?.id).toBe("ses_live")
    }),
  )

  it.effect("never returns another colleague's chat", () =>
    Effect.gen(function* () {
      yield* root({ id: "ses_mine", agent: "theron", created: 1 })
      yield* root({ id: "ses_theirs", agent: "nova", created: 2 })
      const { db } = yield* Database.Service
      expect((yield* RosterChat.allRootsFor(db, "theron")).map((row) => row.id)).toEqual(["ses_mine"])
    }),
  )

  it.effect("never returns a sub-agent's thread", () =>
    Effect.gen(function* () {
      // A thread under a root is that root's work, not a second conversation. Clearing it separately
      // would report work as a chat; ignoring it here would leave the root's own subtree behind.
      yield* root({ id: "ses_root", agent: "theron", created: 1 })
      yield* root({ id: "ses_thread", agent: "theron", created: 2, parent: "ses_root" })
      const { db } = yield* Database.Service
      expect((yield* RosterChat.allRootsFor(db, "theron")).map((row) => row.id)).toEqual(["ses_root"])
    }),
  )

  it.effect("is empty for a colleague with no chats, and `chatFor` agrees there is no live one", () =>
    Effect.gen(function* () {
      // The two sets are deliberately different widths. This is the case where they agree, and it is
      // worth pinning so a future unification of the two queries cannot quietly widen the Clear.
      yield* root({ id: "ses_filed_only", agent: "theron", created: 1, archived: 5 })
      const { db } = yield* Database.Service
      expect(yield* RosterChat.allRootsFor(db, "ghost")).toEqual([])
      expect(yield* RosterChat.chatFor(db, "theron")).toBeUndefined()
      expect((yield* RosterChat.allRootsFor(db, "theron")).map((row) => row.id)).toEqual(["ses_filed_only"])
    }),
  )
})
