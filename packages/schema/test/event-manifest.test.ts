import { describe, expect, test } from "bun:test"
import { FileSystem, Integration, Permission, Reference, Session, Workspace } from "../src"
import { EventManifest } from "../src/event-manifest"
import { IdeEvent } from "../src/ide-event"
import { SessionEvent } from "../src/session-event"
import { SessionTodo } from "../src/session-todo"
import { SessionRecordEvent } from "../src/session-record-event"
import { WorkspaceEvent } from "../src/workspace-event"

describe("public event manifest", () => {
  test("owns the complete public event surface", () => {
    // 2026-07-29: each count fell by one when `session.next.retried` was deleted — it was published by
    // the runner and consumed by nothing (see the note in `src/session-event.ts`).
    expect(EventManifest.ServerDefinitions.length).toBe(65)
    expect(EventManifest.Definitions.length).toBe(86)
    // V1-nuke slice D: the record lifecycle events are native (Session.Info payloads, durable
    // v2); session.diff + command.executed died with the V1 wire schemas (no publishers).
    expect(SessionRecordEvent.Definitions).toEqual([
      SessionRecordEvent.Created,
      SessionRecordEvent.Updated,
      SessionRecordEvent.Deleted,
      SessionRecordEvent.Error,
    ])
    expect(EventManifest.Latest.size).toBe(86)
    expect(EventManifest.Durable.size).toBe(38)
    // A retired durable type must stay retired: rows keyed `session.next.retried.1` still exist in
    // shipped databases and are skipped (never decoded) because both read paths filter to this manifest.
    expect(EventManifest.Durable.has("session.next.retried.1")).toBe(false)
  })

  test("uses canonical definitions for current public events", () => {
    expect(Session.Event).toBe(SessionEvent)
    expect(Session.Event.Definitions).toBe(SessionEvent.Definitions)
    expect(Workspace.Event).toBe(WorkspaceEvent)
    expect(Workspace.Event.Definitions).toBe(WorkspaceEvent.Definitions)
    expect(EventManifest.Latest.get("session.next.step.ended")).toBe(SessionEvent.Step.Ended)
    expect(EventManifest.Latest.get("todo.updated")).toBe(SessionTodo.Event.Updated)
    expect(FileSystem.Event.Definitions).toEqual([FileSystem.Event.Edited])
    expect(Integration.Event.Definitions).toEqual([Integration.Event.Updated, Integration.Event.ConnectionUpdated])
    expect(Permission.Event.Definitions).toEqual([Permission.Event.Asked, Permission.Event.Replied])
    expect(Reference.Event.Definitions).toEqual([Reference.Event.Updated])
    expect(EventManifest.Latest.has("ide.installed")).toBe(false)
    expect(IdeEvent.Definitions).toEqual([IdeEvent.Installed])
    expect(EventManifest.Definitions).toContain(SessionRecordEvent.Error)
    expect(EventManifest.Latest.get("session.next.message.recorded")).toBe(SessionEvent.MessageRecorded)
    expect(EventManifest.Durable.get("session.next.message.recorded.1")).toBe(SessionEvent.MessageRecorded)
    expect(EventManifest.Durable.has("session.next.step.ended.1")).toBe(false)
    expect(EventManifest.Durable.get("session.next.step.ended.2")).toBe(SessionEvent.Step.Ended)
  })
})
