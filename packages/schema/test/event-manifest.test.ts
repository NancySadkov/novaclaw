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
    expect(EventManifest.ServerDefinitions.length).toBe(66)
    expect(EventManifest.Definitions.length).toBe(87)
    // V1-nuke slice D: the record lifecycle events are native (Session.Info payloads, durable
    // v2); session.diff + command.executed died with the V1 wire schemas (no publishers).
    expect(SessionRecordEvent.Definitions).toEqual([
      SessionRecordEvent.Created,
      SessionRecordEvent.Updated,
      SessionRecordEvent.Deleted,
      SessionRecordEvent.Error,
    ])
    expect(EventManifest.Latest.size).toBe(87)
    expect(EventManifest.Durable.size).toBe(39)
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
