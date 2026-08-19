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
    // 2026-08-02: six durable recovery events joined the manifest: three provider-attempt lifecycle
    // events and three storage-linear stream checkpoints. 2026-08-08: device, priority and control-
    // binding switches joined as durable session-component projections. 2026-08-09: the Auto-mode
    // permission card joined as a durable audit event: no user-ceiling write, no model-context replay,
    // and one transcript projection. Keep the exact counts pinned so adding a public wire event always
    // requires an explicit contract review here.
    //
    // 2026-08-19 — REVIEW PERFORMED, +1: `session.presence.updated` (`session-presence.ts`), added by
    // 86deddb58 without this review. The pin caught it; the review is recorded rather than the number
    // quietly bumped. Findings:
    //   · NOT durable — `define` takes no `durable` block for it, so `Durable.size` stays 48 and no
    //     shipped database grows a new aggregate. The subsystem is in-memory on purpose (persisting
    //     presence resurrects ghost viewers across a restart that only a timeout could clear).
    //   · Payload carries NO user content: a sessionID plus attendance (viewerID, kind, client-minted
    //     label, attachedAt, writing), the driver, and the last handoff. No transcript, no draft text —
    //     `writing` is a boolean, never the draft itself.
    //   · Server-visible by design (it is in ServerDefinitions): an instance publishes it only for the
    //     sessions it already owns, to clients already authenticated to it. That keeps presence's
    //     availability domain identical to the session's, which is the test for "did this grow a
    //     server" — AGENTS.md's atomic-instance rule.
    //   · One event carries the WHOLE snapshot, so client folds are idempotent and there is no ordering
    //     to reconcile — no partial-update vocabulary enters the wire.
    // Verdict: accepted as a public wire event. ServerDefinitions 75 -> 76, Definitions/Latest 96 -> 97.
    //
    // ⚠️ The four counts are asserted as ONE object on purpose. As four separate `toBe`s the test
    // stopped at the first mismatch, so the 2026-08-19 drift reported ONLY "ServerDefinitions 76 vs
    // 75" while Definitions and Latest had BOTH also moved — a reviewer reading that failure would
    // have reviewed a third of the change. A contract pin must report the whole delta in one run.
    expect({
      server: EventManifest.ServerDefinitions.length,
      all: EventManifest.Definitions.length,
      latest: EventManifest.Latest.size,
      durable: EventManifest.Durable.size,
    }).toEqual({ server: 76, all: 97, latest: 97, durable: 48 })
    // V1-nuke slice D: the record lifecycle events are native (Session.Info payloads, durable
    // v2); session.diff + command.executed died with the V1 wire schemas (no publishers).
    expect(SessionRecordEvent.Definitions).toEqual([
      SessionRecordEvent.Created,
      SessionRecordEvent.Updated,
      SessionRecordEvent.Deleted,
      SessionRecordEvent.Error,
    ])
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
    expect(EventManifest.Durable.get("session.next.permission.changed.1")).toBe(SessionEvent.PermissionChanged)
    expect(EventManifest.Durable.has("session.next.step.ended.1")).toBe(false)
    expect(EventManifest.Durable.get("session.next.step.ended.2")).toBe(SessionEvent.Step.Ended)
  })
})
