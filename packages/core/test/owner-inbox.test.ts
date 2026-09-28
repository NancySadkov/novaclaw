import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import { AgentV2 } from "../src/agent"
import { AgentConfigTable } from "../src/agent-config/sql"
import { Database } from "../src/database/database"
import ownerMigration from "../src/database/migration/20260928140000_owner_inbox"
import { AppNodeBuilder } from "../src/effect/app-node-builder"
import { LayerNode } from "../src/effect/layer-node"
import { EventV2 } from "../src/event"
import { ColleagueHandoff } from "../src/session/colleague-handoff"
import { ColleagueRoute } from "../src/session/colleague-route"
import { ColleagueStall } from "../src/session/colleague-stall"
import { SessionInput } from "../src/session/input"
import { SessionMessage } from "../src/session/message"
import * as OwnerInbox from "../src/session/owner-inbox"
import { Prompt } from "../src/session/prompt"
import { SessionProjector } from "../src/session/projector"
import { SessionSchema } from "../src/session/schema"
import { SessionStore } from "../src/session/store"
import { SessionInputTable, SessionMessageTable, SessionTable } from "../src/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node])),
)
const officer = (id: string, superior?: string) =>
  AgentV2.Info.make({
    id: AgentV2.ID.make(id),
    mode: "primary",
    hidden: false,
    request: { headers: {}, body: {} },
    permissions: [],
    ...(superior ? { superior: AgentV2.ID.make(superior) } : {}),
    ...(id === "owner" ? { kind: "human" as const } : {}),
  })

describe("the owner belongs to the same organization", () => {
  const roster = [
    officer("owner", "owner"),
    officer("nova", "owner"),
    officer("direct", "owner"),
    officer("engineer", "nova"),
  ]
  test("owner is self-supervised and Nova reports to owner", () => {
    expect(String(AgentV2.resolveSuperior("owner", undefined, roster)?.id)).toBe("owner")
    expect(String(AgentV2.resolveSuperior("nova", undefined, roster)?.id)).toBe("owner")
    expect(AgentV2.isProtected("owner")).toBe(true)
  })
  test("direct reports can reach owner while deeper officers follow the chain", () => {
    for (const agent of ["nova", "direct"])
      expect(ColleagueRoute.route({ agent }, "owner", roster)).toEqual({
        kind: "officer",
        recipient: "owner",
        redirected: false,
      })
    expect(ColleagueRoute.route({ agent: "engineer" }, "owner", roster)).toEqual({
      kind: "officer",
      recipient: "nova",
      redirected: true,
    })
  })
})

it.effect("questions and saved messages appear immediately; later replies reach the officer exactly once", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const store = yield* SessionStore.Service
    const owner = SessionSchema.ID.make("ses_owner_inbox")
    const nova = SessionSchema.ID.make("ses_owner_nova")
    for (const [id, agent] of [
      [owner, "owner"],
      [nova, "nova"],
    ] as const)
      yield* db
        .insert(SessionTable)
        .values({ id, agent, slug: id, directory: process.cwd(), title: agent, version: "test" })
        .run()
        .pipe(Effect.orDie)
    let wakes = 0
    const handoff = ColleagueHandoff.fromParts({
      db,
      events,
      store: {} as never,
      session: (id) => store.get(id),
      chat: (id) => Effect.succeed(id === "owner" ? owner : nova),
      roster: Effect.succeed([officer("owner", "owner"), officer("nova", "owner")]),
      wake: () =>
        Effect.sync(() => {
          wakes++
          return true
        }),
      refresh: Effect.void,
      takenNames: Effect.succeed([]),
      forget: () => Effect.void,
    })
    const result = yield* handoff.deliver({
      from: nova,
      colleague: "owner",
      message: "Which destination should I use?",
    })
    expect(result).toMatchObject({ delivered: true, started: false, human: true, recipient: "owner" })
    expect(wakes).toBe(0)
    const received = (yield* store.context(owner))[0]!
    expect(received).toMatchObject({
      type: "colleague",
      sender: "nova",
      senderSessionID: nova,
      text: "Which destination should I use?",
    })
    expect(yield* SessionInput.listPending(db, owner)).toEqual([])
    expect(yield* ColleagueStall.sweep(db, events, Date.now() + 2 * 60 * 60_000)).toBe(0)
    const savedID = SessionMessage.ID.create()
    const saved = {
      id: savedID,
      sessionID: owner,
      prompt: Prompt.make({ text: "Remember this for myself." }),
      delivery: "queue" as const,
    }
    yield* SessionInput.admit(db, events, saved)
    yield* SessionInput.admit(db, events, saved)
    expect((yield* store.context(owner)).filter((item) => item.id === savedID)).toHaveLength(1)
    const reply = { sessionID: owner, messageID: received.id, replyID: SessionMessage.ID.create(), text: "Use Berlin." }
    const sessions: Parameters<typeof OwnerInbox.reply>[0]["sessions"] = {
      prompt: (input) =>
        SessionInput.admit(db, events, {
          id: input.id ?? SessionMessage.ID.create(),
          sessionID: input.sessionID,
          prompt: Prompt.make({ text: input.prompt.text }),
          delivery: "queue",
        }),
    }
    yield* OwnerInbox.reply({ db, store, sessions }, reply)
    yield* OwnerInbox.reply({ db, store, sessions }, reply)
    const pending = yield* SessionInput.listPending(db, nova)
    expect(pending).toHaveLength(1)
    expect(pending[0]!.prompt).toMatchObject({ text: "Use Berlin." })
    expect(pending[0]!.prompt.origin).toBeUndefined()
    expect((yield* store.context(owner)).filter((item) => item.id === reply.replyID)).toHaveLength(1)
    const denied = yield* OwnerInbox.reply({ db, store, sessions }, { ...reply, sessionID: nova }).pipe(Effect.exit)
    expect(denied._tag).toBe("Failure")
  }),
)

it.effect("Chat and Human reject all harness steers, including previously queued ones after a mode change", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const id = SessionSchema.ID.make("ses_mode_boundary")
    yield* db
      .insert(SessionTable)
      .values({ id, agent: "mode_test", slug: id, directory: process.cwd(), title: "Modes", version: "test" })
      .run()
      .pipe(Effect.orDie)
    const first = yield* SessionInput.steer(db, events, id, "Agent nudge")
    expect(first).toBeDefined()
    yield* db
      .insert(AgentConfigTable)
      .values({ name: "mode_test", layers: [{ kind: "chat" }] })
      .run()
      .pipe(Effect.orDie)
    expect(yield* SessionInput.steer(db, events, id, "Session restarted. Recover and proceed.")).toBeUndefined()
    yield* SessionInput.promoteSteers(db, events, id, Number.MAX_SAFE_INTEGER)
    expect(yield* SessionInput.listPending(db, id)).toEqual([])
    expect(
      yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, id))
        .all()
        .pipe(Effect.orDie),
    ).toEqual([])
    yield* db
      .update(AgentConfigTable)
      .set({ layers: [{ kind: "human" }] })
      .where(eq(AgentConfigTable.name, "mode_test"))
      .run()
      .pipe(Effect.orDie)
    expect(yield* SessionInput.steer(db, events, id, "Another nudge")).toBeUndefined()
    expect(
      yield* SessionInput.automated(db, events, {
        id: SessionMessage.ID.create(),
        sessionID: id,
        prompt: Prompt.make({ text: "Automatic notice" }),
        delivery: "queue",
      }),
    ).toBeUndefined()
    expect(
      yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.session_id, id)).all().pipe(Effect.orDie),
    ).toEqual([])
  }),
)

it.effect("the upgrade exposes the existing owner while preserving a customized name and profile", () =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(AgentConfigTable)
      .values({
        name: "owner",
        layers: [
          { name: "Owner", kind: "human", hidden: true },
          { name: "Alex", description: "My saved messages", superior: "nova" },
        ],
      })
      .run()
      .pipe(Effect.orDie)
    yield* db.transaction((tx) => ownerMigration.up(tx)).pipe(Effect.orDie)
    const row = yield* db
      .select()
      .from(AgentConfigTable)
      .where(eq(AgentConfigTable.name, "owner"))
      .get()
      .pipe(Effect.orDie)
    expect(row?.layers).toEqual([{}, { name: "Alex", description: "My saved messages" }])
  }),
)
