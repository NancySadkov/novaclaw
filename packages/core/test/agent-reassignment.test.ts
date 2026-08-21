import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { AgentReassignment } from "@novaclaw/core/agent/reassignment"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { Database } from "@novaclaw/core/database/database"
import { EventV2 } from "@novaclaw/core/event"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionSchema } from "@novaclaw/core/session/schema"
import { SessionTable } from "@novaclaw/core/session/sql"
import { testEffect } from "./lib/effect"

// Telling a colleague its folder changed (owner, 2026-08-21: *"reassigning agent to another folder
// should auto send a message to it, so it won't be thinking it still works on the old project"*).
//
// 🔴 DETECTION and DELIVERY live in different places on purpose. `config-store-write.ts` is the one
// door every config write passes — the dialog's Save, the `configure` tool, Nova editing a colleague
// — and it holds no sessions. This registry is the seam between them, and the tests below drive the
// delivery half end to end against a real database and event bus.

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])),
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

const move = { agentID: "theron", from: "D:/books", to: "D:/ledger", ownScratch: false }

describe("a moved colleague is told, in its own chat", () => {
  it.effect("the notice lands as a message the colleague will read", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* openChat(db, "ses_theron", "theron")

      expect(yield* AgentReassignment.deliver({ db, events, move })).toBe(true)

      // Synthetic, which lowers to a `user`-role message (`to-llm-message.ts`) AND renders in the
      // transcript — one mechanism for the model and the person scrolling back.
      const rows = yield* db.select().from(SessionTable).all().pipe(Effect.orDie)
      expect(rows.length).toBe(1)
    }),
  )

  it.effect("a colleague with no chat is SKIPPED, not queued", () =>
    Effect.gen(function* () {
      // Starting a conversation the user has never seen, in order to announce a settings change, is
      // worse than silence — the next chat opens with the new folder in its prompt anyway.
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      expect(yield* AgentReassignment.deliver({ db, events, move })).toBe(false)
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
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* AgentReassignment.register((m) => Effect.sync(() => void seen.push(`${m.agentID}:${m.to}`)))
          expect(AgentReassignment.registered()).toBeGreaterThan(0)
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
