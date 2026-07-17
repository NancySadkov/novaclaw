import { describe, expect } from "bun:test"
import { asc, eq } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { EventTable } from "@novaclaw/core/event/sql"
import { ModelV2 } from "@novaclaw/core/model"
import { Project } from "@novaclaw/core/project"
import { ProviderV2 } from "@novaclaw/core/provider"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionV2 } from "@novaclaw/core/session"
import { SessionEvent } from "@novaclaw/core/session/event"
import { SessionMessage } from "@novaclaw/core/session/message"
import { SessionProjector } from "@novaclaw/core/session/projector"
import { SessionTable, SessionMessageTable } from "@novaclaw/core/session/sql"
import { testEffect } from "./lib/effect"

const it = testEffect(LayerNode.compile(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))
const timestamp = DateTime.makeUnsafe(1)
const model = { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("provider") }

const content = (text: string) => [{ type: "text" as const, text }]

describe("Tool.Progress", () => {
  it.effect("projects durable progress and keeps final settlements durable", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      const service = yield* EventV2.Service
      const sessionID = SessionV2.ID.make("ses_tool_progress_projector")
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          slug: "progress",
          directory: "/project",
          title: "progress",
          version: "test",
        })
        .run()
        .pipe(Effect.orDie)
      const assistantMessageID = SessionMessage.ID.create()
      yield* service.publish(SessionEvent.Step.Started, {
        sessionID,
        assistantMessageID,
        timestamp,
        agent: "build",
        model,
      })
      const readAssistant = Effect.gen(function* () {
        const row = yield* db
          .select()
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.id, assistantMessageID))
          .get()
          .pipe(Effect.orDie)
        if (!row) return yield* Effect.die("Missing projected assistant")
        return Schema.decodeUnknownSync(SessionMessage.Assistant)({ ...row.data, id: row.id, type: row.type })
      })
      const start = (callID: string) =>
        Effect.gen(function* () {
          yield* service.publish(SessionEvent.Tool.Input.Started, {
            sessionID,
            timestamp,
            assistantMessageID,
            callID,
            name: "bash",
          })
          yield* service.publish(SessionEvent.Tool.Called, {
            sessionID,
            timestamp,
            assistantMessageID,
            callID,
            tool: "bash",
            input: { command: "pwd" },
            provider: { executed: false },
          })
        })

      yield* start("call-success")
      expect((yield* readAssistant).content[0]).toMatchObject({
        state: { status: "running", structured: {}, content: [] },
      })

      yield* service.publish(SessionEvent.Tool.Progress, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-success",
        structured: { phase: "checkpoint" },
        content: content("saved"),
      })
      expect((yield* readAssistant).content[0]).toMatchObject({
        state: { status: "running", structured: { phase: "checkpoint" }, content: content("saved") },
      })

      const success = yield* service.publish(SessionEvent.Tool.Success, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-success",
        structured: { phase: "done" },
        content: content("complete"),
        provider: { executed: false },
      })
      expect((yield* readAssistant).content[0]).toMatchObject({
        state: { status: "completed", structured: { phase: "done" }, content: content("complete") },
      })

      yield* start("call-failed")
      yield* service.publish(SessionEvent.Tool.Progress, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-failed",
        structured: { phase: "checkpoint" },
        content: content("before failure"),
      })
      const failed = yield* service.publish(SessionEvent.Tool.Failed, {
        sessionID,
        timestamp,
        assistantMessageID,
        callID: "call-failed",
        error: { type: "unknown", message: "boom" },
        provider: { executed: false },
      })
      expect((yield* readAssistant).content[1]).toMatchObject({
        state: {
          status: "error",
          structured: { phase: "checkpoint" },
          content: content("before failure"),
          error: { type: "unknown", message: "boom" },
        },
      })
      expect(Schema.is(SessionEvent.Durable)(success)).toBe(true)
      expect(Schema.is(SessionEvent.Durable)(failed)).toBe(true)

      const rows = yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, sessionID))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)
      expect(rows.map((row) => row.type)).toContain(EventV2.versionedType(SessionEvent.Tool.Progress.type, 1))
      expect(rows.map((row) => row.type)).toContain(EventV2.versionedType(SessionEvent.Tool.Success.type, 1))
      expect(rows.map((row) => row.type)).toContain(EventV2.versionedType(SessionEvent.Tool.Failed.type, 1))
    }),
  )
})
