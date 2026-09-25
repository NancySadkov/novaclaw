import * as MemoryAccess from "@novaclaw/core/kb-graph/memory-access"
import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { AgentRetire } from "@novaclaw/core/agent/retire"
import { AgentRetirementTable } from "@novaclaw/core/agent/retirement.sql"
import { AgentTeamChat } from "@novaclaw/core/agent/team-chat"
import { AgentV2 } from "@novaclaw/core/agent"
import { AgentRemoval } from "@novaclaw/core/agent/removal"
import { RosterChat } from "@novaclaw/core/session/roster-chat"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionMessage } from "@novaclaw/core/session/message"
import { SessionMessageTable, SessionTable } from "@novaclaw/core/session/sql"
import { AgentUsage } from "@novaclaw/core/agent/usage"
import { Database } from "@novaclaw/core/database/database"
import { MemoryClient } from "@novaclaw/core/kb-graph/memory-client"
import { testEffect } from "./lib/effect"

// Retiring a colleague, and the thing it must NOT leave behind.
//
// 🔴 The defect this pins was measured on the owner's own instance (2026-08-21): a probe colleague
// `ghost` was given a memory, retired through `DELETE /api/agent/ghost`, and its `agent:ghost` row
// came back byte-identical afterwards — while the retire tool told the user *"what they remembered
// goes with them"*. Because officer names are drawn from a fixed pool, the id returns, and the next
// colleague drawn as `ghost` would have opened holding a stranger's private memories.
//
// A/B: revert `everything` to only call `AgentUsage.forget` and the first test fails on the row that
// survives — the assertion is on the CABINET, not on the call.

// ⚠️ The PROJECTOR is in the graph on purpose. Archiving a chat is event-sourced —
// `patchSessionRecord` publishes `SessionRecordEvent.Updated` and the projector writes the row — so a
// graph without it would let this test "pass" the archive by never checking the row, and would let a
// real door archive nothing at all while reporting success.
const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))

/** A root chat belonging to a colleague, inserted the way `move-session.test.ts` does. */
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

const events = Effect.gen(function* () {
  return yield* EventV2.Service
})

const remember = (memory: MemoryClient.Interface, scope: string, text: string) =>
  memory.addMemory({ id: `mem_${scope}_${text.length}`, kind: "entity", text, scope })

/** A fixed retirement instant, so the set-aside scope name is deterministic. */
const AT = 1_787_000_000_000

describe("retiring a colleague", () => {
  it.effect("interrupts the officer and deletes its complete worker tree plus detached ghosts", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const eventBus = yield* events
      const root = SessionSchema.ID.make("ses_ghost_root")
      const child = SessionSchema.ID.make("ses_ghost_worker")
      const grandchild = SessionSchema.ID.make("ses_ghost_grandchild")
      const orphan = SessionSchema.ID.make("ses_ghost_orphan")
      yield* openChat(db, { id: root, agent: "ghost" })
      const workerRows: Array<{ id: SessionSchema.ID; parent_id: SessionSchema.ID; agent: string }> = [
        { id: child, parent_id: root, agent: "ghost" },
        // Parentage owns the process even if a corrupt/stale row disagrees about the agent id.
        { id: grandchild, parent_id: child, agent: "somebody-else" },
        { id: orphan, parent_id: SessionSchema.ID.make("ses_missing_parent"), agent: "ghost" },
      ]
      for (const row of workerRows)
        yield* db
          .insert(SessionTable)
          .values({
            ...row,
            slug: row.id,
            directory: process.cwd(),
            title: "worker",
            version: "test",
            time_created: 1,
            time_updated: 1,
          })
          .run()
          .pipe(Effect.orDie)

      const interrupted: string[] = []
      const evicted: string[] = []
      yield* AgentRemoval.removeWorkers({
        db,
        events: eventBus,
        execution: {
          interrupt: (id: SessionSchema.ID) => Effect.sync(() => void interrupted.push(id)),
        } as never,
        scheduler: { evict: (id: SessionSchema.ID) => Effect.sync(() => void evicted.push(id)) } as never,
        memory: MemoryClient.stub(),
        agent: "ghost",
      })

      const remaining = yield* db.select({ id: SessionTable.id }).from(SessionTable).all().pipe(Effect.orDie)
      expect(remaining.map((row) => row.id)).toEqual([root])
      expect(interrupted).toContain(root)
      expect(interrupted).toContain(child)
      expect(interrupted).toContain(grandchild)
      expect(interrupted).toContain(orphan)
      expect(evicted).toContain(root)
    }),
  )

  it.effect("SETS ASIDE the cabinet rather than destroying it", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const memory = MemoryClient.stub()
      yield* remember(memory, "agent:ghost", "The ghost knows where the bodies are buried.")
      yield* AgentUsage.record(db, { agent: "ghost", at: Date.now(), generated: 120 })

      yield* AgentRetire.everything({ db, events: yield* events, memory, agent: "ghost", at: AT })

      // The anti-bleed rule, unchanged: the id's own scope is empty, so a future colleague drawn on
      // that name inherits nothing.
      expect(yield* memory.search({ query: "bodies", scopes: ["agent:ghost"] })).toEqual([])
      expect(yield* AgentUsage.since(db, { agent: "ghost", minute: 0 })).toEqual([])
      // 🔴 …and the bytes are still THERE, under a scope nothing recalls from. Deleting satisfied the
      // rule and nothing else — it also made a retirement final, and Nova retires on its own
      // judgement. A model with a delete key and no undo is what "breaks in your hands" means.
      const setAside = yield* memory.search({ query: "bodies", scopes: [`retired:ghost:${AT}`] })
      expect(setAside.length).toBe(1)
      expect(setAside[0]!.text).toContain("bodies are buried")
    }),
  )

  it.effect("archives the chat, so the next holder of the id does not open into it", () =>
    Effect.gen(function* () {
      // 🔴 The SECOND half of the same bleed, and the one that would be read as a haunting rather
      // than a bug: `chatFor` finds a colleague's chat by AGENT ID alone. A live root session left
      // behind is months of somebody else's conversation, handed to whoever draws the name next.
      const { db } = yield* Database.Service
      yield* openChat(db, { id: SessionSchema.ID.make("ses_ghost_chat"), agent: "ghost" })
      expect(yield* RosterChat.chatFor(db, "ghost")).toBeDefined()

      yield* AgentRetire.everything({ db, events: yield* events, memory: MemoryClient.stub(), agent: "ghost", at: AT })

      // Archived, not deleted: the record survives for the user, and the lookup no longer finds it.
      expect(yield* RosterChat.chatFor(db, "ghost")).toBeUndefined()
      const rows = yield* db.select().from(SessionTable).all().pipe(Effect.orDie)
      expect(rows.length).toBe(1)
      expect(rows[0]!.time_archived).toBeGreaterThan(0)
      const retirements = yield* db.select().from(AgentRetirementTable).all().pipe(Effect.orDie)
      expect(retirements).toHaveLength(1)
      expect(retirements[0]!.agent).toBe("ghost")
      expect(retirements[0]!.retired_at).toBeGreaterThan(AT)
    }),
  )

  it.effect("an all-archived retirement still fences stale messages after the ID is reused", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const id = SessionSchema.ID.make("ses_ghost_archived")
      yield* openChat(db, { id, agent: "ghost" })
      yield* openChat(db, { id: SessionSchema.ID.make("ses_theron_stable"), agent: "theron" })
      yield* db.update(SessionTable).set({ time_archived: AT }).where(eq(SessionTable.id, id)).run().pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          {
            id: "msg_old_recipient",
            session_id: id,
            type: "colleague",
            seq: 1,
            time_created: AT + 1,
            data: { sender: "theron", turn: "ask", text: "old recipient" },
          },
          {
            id: "msg_late_sender",
            session_id: SessionSchema.ID.make("ses_theron_stable"),
            type: "colleague",
            seq: 1,
            time_created: AT + 1,
            data: { sender: "ghost", turn: "answer", text: "late predecessor output" },
          },
        ] as never)
        .run()
        .pipe(Effect.orDie)

      yield* AgentRetire.everything({ db, events: yield* events, memory: MemoryClient.stub(), agent: "ghost", at: AT })

      const retirements = yield* db.select().from(AgentRetirementTable).all().pipe(Effect.orDie)
      expect(retirements).toHaveLength(1)
      const cutoff = retirements[0]!.retired_at
      expect(cutoff).toBeGreaterThan(AT + 1)
      yield* db
        .insert(SessionTable)
        .values({
          id: SessionSchema.ID.make("ses_ghost_reused"),
          slug: "ghost-reused",
          directory: process.cwd(),
          title: "Reused Ghost",
          version: "test",
          agent: "ghost",
          time_created: cutoff + 1,
          time_updated: cutoff + 1,
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values({
          id: "msg_current",
          session_id: SessionSchema.ID.make("ses_ghost_reused"),
          type: "colleague",
          seq: 1,
          time_created: cutoff + 1,
          data: { sender: "theron", turn: "ask", text: "current identity" },
        } as never)
        .run()
        .pipe(Effect.orDie)
      const roster = [
        AgentV2.Info.empty(AgentV2.ID.make("nova")),
        AgentV2.Info.empty(AgentV2.ID.make("theron")),
        AgentV2.Info.make({
          ...AgentV2.Info.empty(AgentV2.ID.make("ghost")),
          superior: AgentV2.ID.make("theron"),
        }),
      ]
      const page = yield* AgentTeamChat.list(db, roster, "theron")
      expect(page.data.map((message) => message.id)).toEqual([SessionMessage.ID.make("msg_current")])
    }),
  )

  it.effect("touches nobody else's — the scope is the partition", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const memory = MemoryClient.stub()
      yield* remember(memory, "agent:ghost", "The ghost knows where the bodies are buried.")
      yield* remember(memory, "agent:theron", "Theron knows the auditor visits on Thursdays.")
      yield* remember(memory, "global", "The household recycling goes out on Tuesday.")
      yield* AgentUsage.record(db, { agent: "theron", at: Date.now(), generated: 7 })
      yield* openChat(db, { id: SessionSchema.ID.make("ses_theron_chat"), agent: "theron" })

      yield* AgentRetire.everything({ db, events: yield* events, memory, agent: "ghost", at: AT })

      // The negative that gives the positive its meaning: a retirement that took the household's
      // shared memory with it would be a far worse defect than the one being fixed.
      expect((yield* memory.search({ query: "auditor", scopes: ["agent:theron"] })).length).toBe(1)
      expect((yield* memory.search({ query: "recycling", scopes: ["global"] })).length).toBe(1)
      expect((yield* AgentUsage.since(db, { agent: "theron", minute: 0 })).length).toBe(1)
      expect(yield* RosterChat.chatFor(db, "theron")).toBeDefined()
    }),
  )

  it.effect("survives an unreachable memory engine — the retirement is not undone by it", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      // `disabled` fails every operation, which is what a broken embedder looks like from here. The
      // role is already gone from the store by the time this runs, so raising would leave the user
      // with a half-retired colleague and no way to finish. It must complete — and log.
      yield* AgentRetire.everything({
        db,
        events: yield* events,
        memory: MemoryClient.disabled("engine down"),
        agent: "ghost",
        at: AT,
      })
    }),
  )

  it.effect("retiring a colleague that remembered nothing is not an error", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* AgentRetire.everything({
        db,
        events: yield* events,
        memory: MemoryClient.stub(),
        agent: "never_spoke",
        at: AT,
      })
    }),
  )
})

// The set-aside cabinet must be out of reach of every AGENT, or "set aside" is just a rename of a
// leak: the point of retiring is that nobody inherits what that colleague knew.
describe("a set-aside cabinet is unreachable from any agent's own search", () => {
  test("no value of the kb tool's scope parameter can name it", () => {
    // `all` is the widest an agent can ask for, and it is still an EXPLICIT list — session, its own
    // cabinet, the household. There is no unscoped search on the agent-facing door, which is what
    // makes `retired:*` invisible without a rule that has to be remembered.
    for (const scope of ["session", "agent", "global", "all", undefined] as const) {
      const scopes = MemoryAccess.scopesForSearch("ses_1", "theron", scope)
      expect(scopes.every((entry) => !entry.startsWith("retired:"))).toBe(true)
      expect(scopes.length).toBeGreaterThan(0)
    }
  })

  test("NEGATIVE CONTROL: the widest ask really does widen", () => {
    // Without this, the assertion above would pass just as happily on a function that returned one
    // scope forever.
    expect(MemoryAccess.scopesForSearch("ses_1", "theron", "all")).toEqual(["ses_1", "agent:theron", "global"])
    expect(MemoryAccess.scopesForSearch("ses_1", "theron", "agent")).toEqual(["agent:theron"])
  })
})
