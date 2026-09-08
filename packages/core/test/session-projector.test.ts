import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { DateTime, Effect, Schema } from "effect"
import { asc, eq } from "drizzle-orm"
import { AgentUsage } from "@novaclaw/core/agent/usage"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { EventV2 } from "@novaclaw/core/event"
import { EventTable } from "@novaclaw/core/event/sql"
import { ModelV2 } from "@novaclaw/core/model"
import { Project } from "@novaclaw/core/project"
import { ProviderV2 } from "@novaclaw/core/provider"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionEvent } from "@novaclaw/core/session/event"
import { SessionMessage } from "@novaclaw/core/session/message"
import { Prompt } from "@novaclaw/core/session/prompt"
import { SessionMessageUpdater } from "@novaclaw/core/session/message-updater"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionExecution } from "@novaclaw/core/session/execution"
import { SessionInput } from "@novaclaw/core/session/input"
import {
  SessionCompactionTable,
  SessionInputTable,
  SessionMessageTable,
  SessionTable,
} from "@novaclaw/core/session/sql"
import { testEffect } from "./lib/effect"
import { Snapshot } from "@novaclaw/core/snapshot"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))
const sessionsLayer = AppNodeBuilder.build(SessionV2.node, [[SessionExecution.node, SessionExecution.noopLayer]])
const sessionID = SessionV2.ID.make("ses_projector_test")
const created = DateTime.makeUnsafe(0)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }
const encodeMessage = Schema.encodeSync(SessionMessage.Message)

const assistantRow = (
  id: SessionMessage.ID,
  seq: number,
  time: { created: DateTime.Utc; completed?: DateTime.Utc } = { created },
) => {
  const {
    id: _,
    type,
    ...data
  } = encodeMessage(SessionMessage.Assistant.make({ id, type: "assistant", agent: "build", model, content: [], time }))
  return { id, session_id: sessionID, type, seq, time_created: DateTime.toEpochMillis(time.created), data }
}

describe("SessionProjector", () => {
  test("registers every durable session projection", () => {
    const source = readFileSync(new URL("../src/session/projector.ts", import.meta.url), "utf8")
    const paths = [...source.matchAll(/events\.project\(SessionEvent\.([A-Za-z.]+)/g)].map((match) => match[1]!)
    const definitionAt = (path: string) =>
      path.split(".").reduce((value, key) => (value as Record<string, unknown>)[key], SessionEvent as unknown)
    const projected = new Set(paths.map((path) => (definitionAt(path) as { readonly type: string }).type))

    // Every durable session event changes a projection. A missing wire here means state can appear
    // live and then disappear on navigation or restart.
    const durableJournalOnly = new Set<string>()
    expect(
      SessionEvent.DurableDefinitions.filter(
        (definition) => !projected.has(definition.type) && !durableJournalOnly.has(definition.type),
      ).map((definition) => definition.type),
    ).toEqual([])
    expect(
      [...durableJournalOnly].filter(
        (type) => !SessionEvent.DurableDefinitions.some((definition) => definition.type === type),
      ),
    ).toEqual([])
  })

  it.effect("keeps only the current unsettled provider attempt", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db
        .insert(SessionTable)
        .values({ id: sessionID, slug: "test", directory: "/project", title: "test", version: "test" })
        .run()
      const events = yield* EventV2.Service
      const first = EventV2.ID.make("evt_provider_first")
      const second = EventV2.ID.make("evt_provider_second")
      const assistantMessageID = SessionMessage.ID.make("msg_provider_recovery")
      const startedAt = DateTime.makeUnsafe(100)
      const start = (attemptID: EventV2.ID) =>
        events.publish(SessionEvent.ProviderAttempt.Started, {
          sessionID,
          timestamp: startedAt,
          recovery: { attemptID, assistantMessageID, model, startedAt, toolProtocol: false },
        })

      yield* start(first)
      yield* start(second)
      yield* events.publish(SessionEvent.ProviderAttempt.Settled, {
        sessionID,
        timestamp: startedAt,
        attemptID: first,
        outcome: "failed",
      })
      expect(
        (yield* db.select({ recovery: SessionTable.provider_recovery }).from(SessionTable).get())?.recovery,
      ).toMatchObject({ attemptID: second, assistantMessageID, startedAt: 100 })

      yield* events.publish(SessionEvent.ProviderAttempt.Abandoned, {
        sessionID,
        timestamp: startedAt,
        attemptID: second,
        reason: "new-input",
      })
      expect(
        (yield* db.select({ recovery: SessionTable.provider_recovery }).from(SessionTable).get())?.recovery,
      ).toBeNull()

      const stopped = EventV2.ID.make("evt_provider_stopped")
      yield* start(stopped)
      yield* events.publish(SessionEvent.ProviderAttempt.Settled, {
        sessionID,
        timestamp: startedAt,
        attemptID: stopped,
        outcome: "interrupted",
      })
      expect(
        (yield* db.select({ recovery: SessionTable.provider_recovery }).from(SessionTable).get())?.recovery,
        "a user stop must clear the session projection as well as the execution lease",
      ).toBeNull()
    }),
  )

  it.effect("applies stream checkpoints once for live clients and from scratch after reconnect", () =>
    Effect.gen(function* () {
      const assistantMessageID = SessionMessage.ID.make("msg_checkpoint")
      const started = {
        id: EventV2.ID.create(),
        type: SessionEvent.Step.Started.type,
        data: { sessionID, assistantMessageID, timestamp: created, agent: "build", model },
      } as EventV2.Payload<typeof SessionEvent.Step.Started>
      const textStarted = {
        id: EventV2.ID.create(),
        type: SessionEvent.Text.Started.type,
        data: { sessionID, assistantMessageID, timestamp: created, textID: "text" },
      } as EventV2.Payload<typeof SessionEvent.Text.Started>
      const live = {
        id: EventV2.ID.create(),
        type: SessionEvent.Text.Delta.type,
        data: { sessionID, assistantMessageID, timestamp: created, textID: "text", delta: "hello" },
      } as EventV2.Payload<typeof SessionEvent.Text.Delta>
      const checkpoint = {
        id: EventV2.ID.create(),
        type: SessionEvent.Text.Progress.type,
        data: { sessionID, assistantMessageID, timestamp: created, textID: "text", offset: 0, delta: "hello" },
      } as EventV2.Payload<typeof SessionEvent.Text.Progress>
      const textOf = (state: SessionMessageUpdater.MemoryState) =>
        state.messages
          .flatMap((message) => (message.type === "assistant" ? message.content : []))
          .find((part) => part.type === "text")?.text

      const connected: SessionMessageUpdater.MemoryState = { messages: [] }
      const connectedAdapter = SessionMessageUpdater.memory(connected)
      yield* SessionMessageUpdater.update(connectedAdapter, started)
      yield* SessionMessageUpdater.update(connectedAdapter, textStarted)
      yield* SessionMessageUpdater.update(connectedAdapter, live)
      yield* SessionMessageUpdater.update(connectedAdapter, checkpoint)
      expect(textOf(connected)).toBe("hello")

      const reconnected: SessionMessageUpdater.MemoryState = { messages: [] }
      const reconnectAdapter = SessionMessageUpdater.memory(reconnected)
      yield* SessionMessageUpdater.update(reconnectAdapter, started)
      yield* SessionMessageUpdater.update(reconnectAdapter, textStarted)
      yield* SessionMessageUpdater.update(reconnectAdapter, checkpoint)
      expect(textOf(reconnected)).toBe("hello")
    }),
  )

  it.effect("persists generated tool titles in the transcript and durable event stream", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(SessionTable)
        .values({ id: sessionID, slug: "test", directory: "/project", title: "test", version: "test" })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const assistantMessageID = SessionMessage.ID.make("msg_labelled_tool")
      const callID = "call_labelled_tool"

      yield* events.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp: created,
        agent: "build",
        model,
      })
      yield* events.publish(SessionEvent.Tool.Input.Started, {
        sessionID,
        assistantMessageID,
        callID,
        timestamp: created,
        name: "bash",
      })
      yield* events.publish(SessionEvent.Tool.Called, {
        sessionID,
        assistantMessageID,
        callID,
        timestamp: created,
        tool: "bash",
        sideEffect: "read",
        input: { command: "ls" },
        provider: { executed: true },
      })
      const labelled = yield* events.publish(SessionEvent.Tool.Labelled, {
        sessionID,
        assistantMessageID,
        callID,
        timestamp: DateTime.makeUnsafe(1),
        title: "Inspect the durable command titles",
      })

      expect(labelled.durable).toMatchObject({ aggregateID: sessionID, version: 1 })
      expect(
        (yield* db
          .select({ type: EventTable.type })
          .from(EventTable)
          .where(eq(EventTable.id, labelled.id))
          .get()
          .pipe(Effect.orDie))?.type,
      ).toBe(EventV2.versionedType(SessionEvent.Tool.Labelled.type, 1))

      const row = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, assistantMessageID))
        .get()
        .pipe(Effect.orDie)
      const message = Schema.decodeUnknownSync(SessionMessage.Message)({
        ...row?.data,
        id: row?.id,
        type: row?.type,
      })
      expect(message).toMatchObject({
        type: "assistant",
        content: [{ type: "tool", id: callID, title: "Inspect the durable command titles" }],
      })
    }),
  )

  it.effect("projects staged, cleared, and committed reverts", () =>
    Effect.gen(function* () {
      const db = (yield* Database.Service).db
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
      const boundary = SessionMessage.ID.make("msg_boundary")
      yield* db
        .insert(SessionMessageTable)
        .values([assistantRow(boundary, 1), assistantRow(SessionMessage.ID.make("msg_later"), 2)])
        .run()
      const events = yield* EventV2.Service
      yield* events.publish(SessionEvent.RevertEvent.Staged, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        revert: { messageID: boundary, snapshot: Snapshot.ID.make("tree"), diff: "patch", files: [] },
      })
      expect((yield* db.select({ revert: SessionTable.revert }).from(SessionTable).get())?.revert).toMatchObject({
        messageID: boundary,
        snapshot: "tree",
        files: [],
      })
      yield* events.publish(SessionEvent.RevertEvent.Cleared, { sessionID, timestamp: DateTime.makeUnsafe(2) })
      expect((yield* db.select({ revert: SessionTable.revert }).from(SessionTable).get())?.revert).toBeNull()
      yield* events.publish(SessionEvent.RevertEvent.Staged, {
        sessionID,
        timestamp: DateTime.makeUnsafe(3),
        revert: { messageID: boundary, files: [] },
      })
      yield* events.publish(SessionEvent.RevertEvent.Committed, {
        sessionID,
        messageID: boundary,
        timestamp: DateTime.makeUnsafe(4),
      })
      expect(
        (yield* db.select({ id: SessionMessageTable.id }).from(SessionMessageTable).all()).map((row) => row.id),
      ).toEqual([boundary])
    }),
  )

  it.effect("orders projected messages and context by durable aggregate sequence", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service

      yield* events.publish(
        SessionEvent.Prompted,
        {
          sessionID,
          messageID: SessionMessage.ID.make("msg_first"),
          timestamp: created,
          prompt: Prompt.make({ text: "first" }),
          delivery: "steer",
        },
        { id: EventV2.ID.make("evt_z") },
      )
      yield* events.publish(
        SessionEvent.Prompted,
        {
          sessionID,
          messageID: SessionMessage.ID.make("msg_second"),
          timestamp: created,
          prompt: Prompt.make({ text: "second" }),
          delivery: "steer",
        },
        { id: EventV2.ID.make("evt_a") },
      )

      const sessions = yield* SessionV2.Service
      const firstPage = yield* sessions.messages({ sessionID, limit: 1, order: "asc" })
      expect(firstPage.map((message) => (message.type === "user" ? message.text : message.type))).toEqual(["first"])
      const secondPage = yield* sessions.messages({
        sessionID,
        limit: 1,
        order: "asc",
        cursor: { id: firstPage[0]!.id, direction: "next" },
      })
      expect(secondPage.map((message) => (message.type === "user" ? message.text : message.type))).toEqual(["second"])
      expect(
        (yield* sessions.messages({
          sessionID,
          limit: 1,
          order: "asc",
          cursor: { id: secondPage[0]!.id, direction: "previous" },
        })).map((message) => (message.type === "user" ? message.text : message.type)),
      ).toEqual(["first"])
      expect(
        (yield* sessions.context(sessionID)).map((message) => (message.type === "user" ? message.text : message.type)),
      ).toEqual(["first", "second"])
      // The sequence reaches the reader, because the client orders the transcript by it — sorting on
      // `time.created` instead is what filed an answer under the following prompt (2026-08-11).
      const withSeq = yield* sessions.messages({ sessionID, order: "asc" })
      expect(withSeq.map((message) => message.seq)).toEqual(
        [...withSeq.keys()].map((i) => withSeq[i]!.seq).sort((a, b) => a! - b!),
      )
      expect(withSeq.every((message) => typeof message.seq === "number")).toBe(true)
      // ⚠️ And a seq of ZERO must decode. The aggregate emits one, and this pair of assertions is
      // here because declaring the field `PositiveInt` made such a message fail to decode — which
      // does not misorder it, it removes it from the transcript entirely. Order is cosmetic;
      // content is not, so no ordering hint may ever cost a message.
      expect(withSeq.map((message) => message.seq)).toContain(0)
    }).pipe(Effect.provide(sessionsLayer)),
  )

  it.effect("marks an inbox row promoted with the Prompted event sequence", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const id = SessionMessage.ID.make("msg_admitted")
      const admitted = yield* SessionInput.admit(db, events, {
        id,
        sessionID,
        prompt: Prompt.make({ text: "promote me" }),
        delivery: "steer",
      })
      if (!admitted) return yield* Effect.die("Prompt admission failed")

      const event = yield* events.publish(SessionEvent.Prompted, {
        sessionID,
        timestamp: admitted.timeCreated,
        messageID: id,
        prompt: Prompt.make({ text: "promote me" }),
        delivery: "steer",
      })

      expect(
        yield* db.select().from(SessionInputTable).where(eq(SessionInputTable.id, id)).get().pipe(Effect.orDie),
      ).toMatchObject({ promoted_seq: event.durable?.seq })
    }),
  )

  it.effect("projects durable context messages supported by the updater", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service

      yield* events.publish(SessionEvent.AgentSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        agent: "build",
      })
      yield* events.publish(SessionEvent.ModelSwitched, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        model,
      })
      yield* events.publish(SessionEvent.Synthetic, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        text: "synthetic context",
      })
      yield* events.publish(SessionEvent.PermissionChanged, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        op: "lower",
        previous: "bypass",
        mode: "plan",
        ceiling: "bypass",
        justification: "reading the codebase first; changing nothing yet",
      })
      yield* events.publish(SessionEvent.Shell.Started, {
        sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: created,
        callID: "shell-1",
        command: "pwd",
      })
      yield* events.publish(SessionEvent.Shell.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        callID: "shell-1",
        output: "/project",
      })
      const compactionID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: created,
        reason: "manual",
      })
      yield* events.publish(SessionEvent.Compaction.Delta, {
        sessionID,
        messageID: compactionID,
        timestamp: created,
        text: "partial",
      })
      expect(
        yield* db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(eq(EventTable.type, SessionEvent.Compaction.Delta.type))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([])
      yield* events.publish(SessionEvent.Compaction.Progress, {
        sessionID,
        messageID: compactionID,
        timestamp: created,
        generatedChars: 7,
      })
      expect(
        yield* db
          .select({ id: SessionMessageTable.id })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.type, "compaction-status"))
          .all()
          .pipe(Effect.orDie),
      ).toEqual([{ id: compactionID }])
      yield* events.publish(SessionEvent.Compaction.Ended, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1),
        reason: "manual",
        text: "summary",
        recent: "recent context",
        prefixSeq: 0,
        prefixHash: "0".repeat(64),
        generatedChars: 12,
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.seq))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )

      expect(messages.map((message) => message.type)).toEqual([
        "agent-switched",
        "model-switched",
        "synthetic",
        "permission-changed",
        "shell",
        "compaction",
      ])
      expect(messages.find((message) => message.type === "permission-changed")).toMatchObject({
        previous: "bypass",
        mode: "plan",
        ceiling: "bypass",
        justification: "reading the codebase first; changing nothing yet",
      })
      expect(messages.find((message) => message.type === "shell")).toMatchObject({
        output: "/project",
        time: { completed: DateTime.makeUnsafe(1) },
      })
      expect(messages.find((message) => message.type === "compaction")).toMatchObject({
        generatedChars: 12,
        summary: "summary",
        time: { created, completed: DateTime.makeUnsafe(1) },
      })
      expect(yield* db.select().from(SessionCompactionTable).get().pipe(Effect.orDie)).toMatchObject({
        summary: "summary",
        recent: "recent context",
        prefix_seq: 0,
        prefix_hash: "0".repeat(64),
      })
      expect(
        yield* db.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get().pipe(Effect.orDie),
      ).toMatchObject({
        agent: "build",
        model,
        time_updated: DateTime.toEpochMillis(created),
      })
    }),
  )

  it.effect("rejects distinct creator events that reuse one projected message ID", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const events = yield* EventV2.Service
      const id = SessionMessage.ID.make("msg_creator_collision")

      yield* events.publish(SessionEvent.Synthetic, { sessionID, messageID: id, timestamp: created, text: "keep me" })
      const exit = yield* events
        .publish(SessionEvent.Step.Started, {
          sessionID,
          assistantMessageID: id,
          timestamp: created,
          agent: "build",
          model,
        })
        .pipe(Effect.exit)

      expect(exit._tag).toBe("Failure")
      expect(
        yield* db.select().from(SessionMessageTable).where(eq(SessionMessageTable.id, id)).get().pipe(Effect.orDie),
      ).toMatchObject({ type: "synthetic" })
    }),
  )

  it.effect("backfills a successful pre-audit compaction with its measured start and completion", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* db
        .insert(SessionTable)
        .values({ id: sessionID, slug: "test", directory: "/project", title: "test", version: "test" })
        .run()
      const compactionID = SessionMessage.ID.create()
      const started = yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1_000),
        reason: "auto",
      })
      yield* db.delete(SessionMessageTable).where(eq(SessionMessageTable.id, compactionID)).run().pipe(Effect.orDie)
      yield* db
        .insert(SessionCompactionTable)
        .values({
          id: compactionID,
          session_id: sessionID,
          seq: (started.durable?.seq ?? 0) + 1,
          prefix_seq: 0,
          prefix_hash: "0".repeat(64),
          reason: "auto",
          summary: "restored summary",
          recent: "tail",
          time_created: 4_500,
        })
        .run()
        .pipe(Effect.orDie)

      yield* SessionProjector.backfillCompactionTranscript(db)
      const restored = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, compactionID))
        .get()
        .pipe(Effect.orDie)
      expect(restored?.seq).toBe(started.durable?.seq)
      expect(
        Schema.decodeUnknownSync(SessionMessage.Message)({
          ...restored!.data,
          id: restored!.id,
          type: restored!.type,
        }),
      ).toMatchObject({
        type: "compaction",
        summary: "restored summary",
        time: { created: DateTime.makeUnsafe(1_000), completed: DateTime.makeUnsafe(4_500) },
      })
    }),
  )

  it.effect("settles a compaction that was interrupted by process restart", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const events = yield* EventV2.Service
      yield* db
        .insert(SessionTable)
        .values({ id: sessionID, slug: "test", directory: "/project", title: "test", version: "test" })
        .run()
      const compactionID = SessionMessage.ID.create()
      yield* events.publish(SessionEvent.Compaction.Started, {
        sessionID,
        messageID: compactionID,
        timestamp: DateTime.makeUnsafe(1_000),
        reason: "auto",
      })

      yield* SessionProjector.settleInterruptedCompactions(db, DateTime.makeUnsafe(3_500))
      const row = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.id, compactionID))
        .get()
        .pipe(Effect.orDie)
      expect(
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row!.data, id: row!.id, type: row!.type }),
      ).toMatchObject({
        type: "compaction-status",
        status: "failed",
        failure: "process-restarted",
        time: { created: DateTime.makeUnsafe(1_000), completed: DateTime.makeUnsafe(3_500) },
      })
    }),
  )

  it.effect("does not revive a stale incomplete in-memory assistant projection", () =>
    Effect.gen(function* () {
      const stale = SessionMessage.Assistant.make({
        id: SessionMessage.ID.make("msg_assistant_stale"),
        type: "assistant",
        agent: "build",
        model,
        content: [],
        time: { created },
      })
      const completed = SessionMessage.Assistant.make({
        id: SessionMessage.ID.make("msg_assistant_completed"),
        type: "assistant",
        agent: "build",
        model,
        content: [],
        time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
      })

      expect(
        yield* SessionMessageUpdater.memory({ messages: [stale, completed] }).getCurrentAssistant(),
      ).toBeUndefined()
    }),
  )

  it.effect("updates only the newest incomplete assistant projection", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(SessionMessage.ID.make("msg_assistant_1"), 0),
          assistantRow(SessionMessage.ID.make("msg_assistant_2"), 1),
        ])
        .run()
        .pipe(Effect.orDie)

      const service = yield* EventV2.Service
      yield* service.publish(SessionEvent.Step.Ended, {
        sessionID,
        timestamp: DateTime.makeUnsafe(1),
        assistantMessageID: SessionMessage.ID.make("msg_assistant_2"),
        finish: "stop",
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        context: {
          window: 32_000,
          estimatedTokens: 12_000,
          droppedMessages: 2,
          elidedOutputs: 1,
          promptAnchor: {
            sessionID,
            contextEpoch: 7,
            providerID: "provider",
            modelID: "model",
            serverKey: "http://device",
            routeID: "route",
            protocolID: "protocol",
            controllerKey: "plain",
            shapeKey: "abc123",
            heuristicTokens: 12_000,
            reportedTokens: 13_000,
          },
          findings: [
            {
              kind: "duplicate-tool-output",
              tool: "read",
              target: "src/a.ts",
              occurrences: 2,
              repeatedTokens: 1_200,
              elided: true,
            },
          ],
        },
        timing: {
          startedAt: 10,
          completedAt: 40,
          phases: [{ phase: "provider-prefill", startedAt: 20, completedAt: 30 }],
          providerAttempts: [{ attempt: 1, dispatchedAt: 20, firstTokenAt: 30, completedAt: 40, outcome: "completed" }],
        },
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.id))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )
      expect(messages[0]).not.toHaveProperty("time.completed")
      expect(messages[1]).toMatchObject({
        type: "assistant",
        finish: "stop",
        context: {
          window: 32_000,
          promptAnchor: {
            sessionID,
            contextEpoch: 7,
            heuristicTokens: 12_000,
            reportedTokens: 13_000,
          },
          findings: [{ kind: "duplicate-tool-output", target: "src/a.ts" }],
        },
        timing: {
          startedAt: 10,
          completedAt: 40,
          providerAttempts: [{ attempt: 1, firstTokenAt: 30, outcome: "completed" }],
        },
        time: { completed: DateTime.makeUnsafe(1) },
      })
    }),
  )

  it.effect("a finished step lands in the colleague's per-minute series — and a quiet one does not", () =>
    Effect.gen(function* () {
      // The roster's work column is fed from HERE (owner, 2026-08-21). The store's own rules are
      // pinned in `agent-usage.test.ts`; this asserts the projector actually calls it, with the
      // right owner, on the real event — the half a store test cannot see.
      const { db } = yield* Database.Service
      const sessionID = SessionV2.ID.make("ses_minute_series")
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
          agent: "theron",
        })
        .run()
        .pipe(Effect.orDie)

      const service = yield* EventV2.Service
      const step = (output: number, reasoning: number) =>
        service.publish(SessionEvent.Step.Ended, {
          sessionID,
          timestamp: DateTime.makeUnsafe(1),
          assistantMessageID: SessionMessage.ID.make("msg_assistant_1"),
          finish: "stop",
          cost: 0,
          tokens: { input: 500, output, reasoning, cache: { read: 0, write: 0 } },
          context: { window: 32_000, estimatedTokens: 1, droppedMessages: 0, elidedOutputs: 0, findings: [] },
          timing: { startedAt: 10, completedAt: 40, phases: [], providerAttempts: [] },
        })

      yield* step(40, 2)
      // A pure tool call: prompt tokens went in, nothing came out. It must leave NO row — an absent
      // minute means nothing happened, and a stored zero would make it a measurement.
      yield* step(0, 0)

      const series = yield* AgentUsage.since(db, { agent: "theron", minute: 0 })
      expect(series).toHaveLength(1)
      expect(series[0]!.generated).toBe(42)
    }),
  )

  it.effect("does not revive a stale incomplete assistant projection", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          slug: "test",
          directory: "/project",
          title: "test",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      yield* db
        .insert(SessionMessageTable)
        .values([
          assistantRow(SessionMessage.ID.make("msg_assistant_stale"), 0),
          assistantRow(SessionMessage.ID.make("msg_assistant_completed"), 1, {
            created: DateTime.makeUnsafe(1),
            completed: DateTime.makeUnsafe(2),
          }),
        ])
        .run()
        .pipe(Effect.orDie)

      const service = yield* EventV2.Service
      yield* service.publish(SessionEvent.Text.Started, {
        sessionID,
        assistantMessageID: SessionMessage.ID.make("msg_assistant_completed"),
        timestamp: DateTime.makeUnsafe(3),
        textID: "text-stale",
      })

      const rows = yield* db
        .select()
        .from(SessionMessageTable)
        .where(eq(SessionMessageTable.session_id, sessionID))
        .orderBy(asc(SessionMessageTable.id))
        .all()
        .pipe(Effect.orDie)
      const messages = rows.map((row) =>
        Schema.decodeUnknownSync(SessionMessage.Message)({ ...row.data, id: row.id, type: row.type }),
      )
      expect(messages).toEqual([
        SessionMessage.Assistant.make({
          id: SessionMessage.ID.make("msg_assistant_completed"),
          type: "assistant",
          agent: "build",
          model,
          content: [SessionMessage.AssistantText.make({ type: "text", id: "text-stale", text: "" })],
          time: { created: DateTime.makeUnsafe(1), completed: DateTime.makeUnsafe(2) },
        }),
        SessionMessage.Assistant.make({
          id: SessionMessage.ID.make("msg_assistant_stale"),
          type: "assistant",
          agent: "build",
          model,
          content: [],
          time: { created },
        }),
      ])
    }),
  )
})
