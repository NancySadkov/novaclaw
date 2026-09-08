import { describe, expect } from "bun:test"
import { DateTime, Effect, Schema } from "effect"
import { eq } from "drizzle-orm"
import { AgentReassignment } from "@novaclaw/core/agent/reassignment"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Database } from "@novaclaw/core/database/database"
import { EventV2 } from "@novaclaw/core/event"
import { ProjectV2 } from "@novaclaw/core/project"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionStore } from "@novaclaw/core/session/store"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionMessage } from "@novaclaw/core/session/message"
import { SessionMessageTable, SessionTable } from "@novaclaw/core/session/sql"
import { ModelV2 } from "@novaclaw/core/model"
import { ProviderV2 } from "@novaclaw/core/provider"
import { testEffect } from "./lib/effect"

// Telling a colleague its folder changed (owner, 2026-08-21: *"reassigning agent to another folder
// should auto send a message to it, so it won't be thinking it still works on the old project"*).
//
// 🔴 DETECTION and DELIVERY live in different places on purpose. `config-store-write.ts` is the one
// door every config write passes — the dialog's Save, the `configure` tool, Nova editing a colleague
// — and it holds no sessions. This registry is the seam between them, and the tests below drive the
// delivery half end to end against a real database and event bus.

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, ProjectV2.node, SessionStore.node]),
  ),
)

const openChat = (db: Database.Interface["db"], id: string, agent: string) =>
  db
    .insert(SessionTable)
    .values([
      {
        id: SessionSchema.ID.make(id),
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

const addAssistantOutput = (db: Database.Interface["db"], sessionID: string) => {
  const created = DateTime.makeUnsafe(2)
  const encoded = Schema.encodeSync(SessionMessage.Message)(
    SessionMessage.Assistant.make({
      id: SessionMessage.ID.make("msg_output"),
      type: "assistant",
      agent: "build",
      model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") },
      content: [SessionMessage.AssistantText.make({ type: "text", id: "text", text: "done" })],
      time: { created, completed: DateTime.makeUnsafe(3) },
    }),
  )
  const { id, type, ...data } = encoded
  return db
    .insert(SessionMessageTable)
    .values({
      id: SessionMessage.ID.make(id),
      session_id: SessionSchema.ID.make(sessionID),
      type,
      seq: 1,
      time_created: DateTime.toEpochMillis(created),
      data,
    })
    .run()
    .pipe(Effect.orDie)
}

const move = { agentID: "theron", from: "D:/books", to: "D:/ledger", ownScratch: false }

describe("a moved colleague is told, in its own chat", () => {
  const deps = Effect.gen(function* () {
    const { db } = yield* Database.Service
    return {
      db,
      events: yield* EventV2.Service,
      projects: yield* ProjectV2.Service,
      store: yield* SessionStore.Service,
    }
  })

  /**
   * 🔴 The chat does NOT follow its colleague — it is ARCHIVED and a successor opens in the new
   * folder. Repointing a live session across projects is refused outright by
   * `control-plane/move-session.ts`, so the old behaviour left the chat stranded and told the USER
   * to clear it. Nothing is destroyed: compaction files a transcript into the colleague's own
   * cabinet, and continuity lives there rather than in the transcript.
   */
  it.effect("the old chat is archived and a successor opens in the NEW folder", () =>
    Effect.gen(function* () {
      const d = yield* deps
      yield* openChat(d.db, "ses_theron", "theron")

      expect(yield* AgentReassignment.deliver({ ...d, move })).toBe(true)

      const rows = yield* d.db.select().from(SessionTable).all().pipe(Effect.orDie)
      const archived = rows.filter((r) => r.id !== "ses_theron" && r.agent === "theron")
      const live = rows.filter((r) => r.agent === "theron" && r.time_archived === null)
      expect(archived).toHaveLength(1)
      expect(archived[0]?.time_archived).not.toBe(null)
      // Exactly ONE live chat afterwards — the invariant survives a reassignment, and the successor
      // is rooted where the colleague now works.
      expect(live.length).toBe(1)
      // ⚠️ Compared with separators normalised: the store keeps NATIVE separators, so a literal
      // `D:/ledger` fails on Windows against the `D:\ledger` that was actually written. The claim is
      // "the successor is rooted in the new folder", not "the string round-trips unchanged".
      expect(String(live[0]?.directory).replaceAll("\\", "/")).toBe(move.to)
      const notices = yield* d.db
        .select({ id: SessionMessageTable.id })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, live[0]!.id))
        .all()
      expect(notices, "an empty chat gets no assignment nudge").toHaveLength(0)
    }),
  )

  it.effect("adds the folded assignment nudge only after model output exists", () =>
    Effect.gen(function* () {
      const d = yield* deps
      yield* openChat(d.db, "ses_theron", "theron")
      yield* addAssistantOutput(d.db, "ses_theron")

      expect(yield* AgentReassignment.deliver({ ...d, move })).toBe(true)
      const live = yield* d.db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(eq(SessionTable.agent, "theron"))
        .all()
      const notices = yield* d.db
        .select({ type: SessionMessageTable.type, data: SessionMessageTable.data })
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, SessionSchema.ID.make("ses_theron")))
        .all()
      expect(notices).toHaveLength(1)
      expect(notices[0]).toMatchObject({ type: "synthetic", data: { text: expect.stringContaining("Your assignment changed") } })
    }),
  )

  it.effect(
    "🔴 a colleague is never left ARCHIVED WITH NO SUCCESSOR",
    Effect.gen(function* () {
      const d = yield* deps
      yield* openChat(d.db, "ses_theron", "theron")

      // The archive and the create are two writes with no transaction between them, so a failure in
      // the gap used to leave the colleague archived and unreachable — the roster row is the only
      // door into a colleague's chat. The fix for stranding could strand.
      //
      // ⚠️ Compensating afterwards is NOT available: `projector.ts` writes `undefined` for an
      // absent `time.archived` (deliberately, so a partial round-trip does not blank every column)
      // and drizzle omits `undefined` from a SET clause — so "un-archive" is not expressible. A
      // rollback written that way compiles, runs, and does nothing. It did; this test caught it.
      // The fix is ORDER: the part that reaches outside runs before anything is archived.
      const brokenProjects = {
        ...d.projects,
        resolve: () => Effect.die(new Error("project store is down")),
      } as typeof d.projects
      expect(yield* AgentReassignment.deliver({ ...d, projects: brokenProjects, move })).toBe(false)

      const rows = yield* d.db.select().from(SessionTable).all().pipe(Effect.orDie)
      const live = rows.filter((r) => r.agent === "theron" && r.time_archived === null)
      // The colleague still HAS its chat. A stale chat in a known folder beats no chat at all: the
      // folder change still applies, and it is read out of the system prompt on the next turn.
      expect(live.length).toBe(1)
      expect(String(live[0]?.id)).toBe("ses_theron")
    }),
  )

  it.effect("a colleague with no chat is SKIPPED, not queued", () =>
    Effect.gen(function* () {
      // Starting a conversation the user has never seen, in order to announce a settings change, is
      // worse than silence — the next chat opens with the new folder in its prompt anyway.
      const d = yield* deps
      expect(yield* AgentReassignment.deliver({ ...d, move })).toBe(false)
    }),
  )
})

describe("the registry between the two halves", () => {
  it.effect("announcing with nobody registered is not an error", () =>
    Effect.gen(function* () {
      // A CLI writing config with no instance running has no chat to deliver into. The notice is a
      // courtesy for a LIVE colleague, never a correctness mechanism — treating a missing listener as
      // a fault would make an offline config edit fail for want of an audience.
      yield* AgentReassignment.announce(move)
    }),
  )

  it.effect("a registered listener receives the move, and deregisters with its scope", () =>
    Effect.gen(function* () {
      const seen: string[] = []
      // ⚠️ The count is asked of THIS graph. A process-wide one would answer the union across every
      // instance in it, which is the question nobody has.
      const { db } = yield* Database.Service
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* AgentReassignment.register((m) => Effect.sync(() => void seen.push(`${m.agentID}:${m.to}`)))
          expect(AgentReassignment.registered(db)).toBeGreaterThan(0)
          yield* AgentReassignment.announce(move)
        }),
      )
      expect(seen).toEqual(["theron:D:/ledger"])
      // Out of scope: the closure is gone, so a later write cannot fan out into a dead location.
      yield* AgentReassignment.announce(move)
      expect(seen).toEqual(["theron:D:/ledger"])
    }),
  )

  it.effect("one listener failing does not stop the others, or the write", () =>
    Effect.gen(function* () {
      // The config write has already COMMITTED by the time this runs. A delivery that throws must not
      // roll it back: the colleague would then be pointed at a new folder with no notice, which is
      // the pre-fix behaviour — worse than today, better than a 500 on a save that worked.
      const seen: string[] = []
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* AgentReassignment.register(() => Effect.die("delivery exploded"))
          yield* AgentReassignment.register((m) => Effect.sync(() => void seen.push(m.agentID)))
          yield* AgentReassignment.announce(move)
        }),
      )
      expect(seen).toEqual(["theron"])
    }),
  )
})
