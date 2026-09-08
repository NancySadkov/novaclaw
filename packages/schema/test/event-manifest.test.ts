import { describe, expect, test } from "bun:test"
import { FileSystem, Integration, Reference, Session, Workspace } from "../src"
import { EventManifest } from "../src/event-manifest"
import { SessionEvent } from "../src/session-event"
import { SessionTodo } from "../src/session-todo"
import { SessionRecordEvent } from "../src/session-record-event"
import { WorkspaceEvent } from "../src/workspace-event"

describe("public event manifest", () => {
  test("owns the complete public event surface", () => {
    // 2026-08-02: six durable recovery events joined the manifest: three provider-attempt lifecycle
    // events and three storage-linear stream checkpoints. 2026-08-08: device, priority and control-
    // binding switches joined as durable session-component projections. Keep the exact counts pinned
    // so adding a public wire event always requires an explicit contract review here.
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
    //
    // 2026-08-25 — the five `memory.*` store events (`` P2). Reviewed, not bumped:
    //   Â· NOT durable â none takes a `durable` block, so `Durable.size` stays 48. The graph is its
    //     own record and `claimHistory` is the timeline; a replayable second log of the same
    //     lifecycle is a copy that drifts. A missed event costs an animation, never a fact.
    //   Â· Payload content: ids, scopes, a lifecycle status, and a TRUNCATED statement/text for the
    //     feed's caption â the same user content the memory routes already serve to the same
    //     authenticated clients. `memory.recalled` deliberately carries a FINGERPRINT and never the
    //     query, because a recall query is built from the user's own words and a bus is the wrong
    //     place to copy the prompt stream to.
    //   Â· Server-visible by NECESSITY, not merely by design: auto-recall and auto-extraction run
    //     inside the session worker, and `session-worker/services.ts` forwards a publish to the host
    //     bus only for types in `ServerDefinitions`. Outside it, every memory event raised by a real
    //     turn would be a process-local no-op â the one producer the Memory app most needs to see.
    //   Â· Availability domain is the instance's own memory graph, which the memory routes already
    //     expose to the same clients. No new reach, so no new server.
    // Verdict: accepted as public wire events. ServerDefinitions 76 -> 81, Definitions/Latest 97 -> 102.
    //
    // 2026-09-03 — REVIEW PERFORMED, the event-stream ledger's rows
    // (`notes/reports/refactor-sweep-2026-08-31/24-contract-surface.md`). Two moves:
    //   · JOINED to the served set, +13: `session.error`, `session.status`, `session.compacted`,
    //     `installation.updated`, `installation.update-available`, `mcp.tools.changed`,
    //     `mcp.browser.open.failed`, `vcs.branch.updated`, `workspace.ready/failed/status`,
    //     `worktree.ready/failed`. Every one was already ON THE BUS and declared in `Definitions` — the
    //     public wire simply refused them, so the app's status row, error toast, updater and branch
    //     badge were contract consumers waiting on a union that named twenty arms the route dropped.
    //     No new reach: the same authenticated clients already received them on the legacy `/event`.
    //     NOT durable — none takes a `durable` block; `Durable.size` stays 48.
    //   · DELETED, −2: `permission.asked`, `permission.replied`. The consent-card island that
    //     published them left with the consent-card deletion (2026-09-01); a family nobody emits is not a contract (the
    //     `question.asked` family went the same way earlier the same day, −3).
    //   · What the served set still refuses is exactly `server.connected` and `global.disposed` — the
    //     streams' own lifecycle elements, declared for the union and emitted by the routes themselves.
    // Verdict: ServerDefinitions 79 -> 92, Definitions/Latest 99 -> 94 (−3 question, −2 permission).
    //   · Later the same day, +1 served: `server.instance.disposed` (`instance-event.ts`) — the one
    //     type the CLI could read only on the legacy `/event`, now a bus event the contract stream
    //     carries, so `/event` could be deleted. Payload: a directory. Not durable.
    // Verdict: ServerDefinitions 92 -> 93, Definitions/Latest 94 -> 95.
    //   · And last: `server.connected` and `global.disposed` LEFT the inventory. Neither was ever a
    //     bus event — the streams synthesize them (`protocol/groups/event.ts` declares the opener
    //     itself; `groups/global.ts` declares the disposal it relays off the `GlobalBus`) — so the
    //     inventory now IS the served set and `/api/event` refuses nothing. `Definitions` is
    //     `ServerDefinitions`, which is why the two numbers below are the same number.
    // Verdict: Definitions/Latest 95 -> 93.
    expect({
      server: EventManifest.ServerDefinitions.length,
      all: EventManifest.Definitions.length,
      latest: EventManifest.Latest.size,
      durable: EventManifest.Durable.size,
      // 2026-09-08: durable compaction progress keeps its visible counter across navigation/restart.
    }).toEqual({ server: 93, all: 93, latest: 93, durable: 50 })
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
    expect(Reference.Event.Definitions).toEqual([Reference.Event.Updated])
    expect(EventManifest.Definitions).toContain(SessionRecordEvent.Error)
    expect(EventManifest.Latest.get("session.next.message.recorded")).toBe(SessionEvent.MessageRecorded)
    expect(EventManifest.Durable.get("session.next.message.recorded.1")).toBe(SessionEvent.MessageRecorded)
    expect(EventManifest.Durable.get("session.next.permission.changed.1")).toBe(SessionEvent.PermissionChanged)
    expect(EventManifest.Durable.get("session.next.tool.labelled.1")).toBe(SessionEvent.Tool.Labelled)
    expect(EventManifest.Durable.has("session.next.step.ended.1")).toBe(false)
    expect(EventManifest.Durable.get("session.next.step.ended.2")).toBe(SessionEvent.Step.Ended)
  })

  test("keeps only reconstructable stream fragments live-only", () => {
    const liveOnly = SessionEvent.Definitions.filter((definition) => definition.durable === undefined).map(
      (definition) => definition.type,
    )

    // Each accepted arm is a partial stream value with a durable progress/full-value boundary.
    // A presentation update such as a generated title does not belong here: without a later full
    // value, reconnect silently replaces it with a fallback.
    expect(liveOnly).toEqual([
      SessionEvent.Text.Delta.type,
      SessionEvent.Reasoning.Delta.type,
      SessionEvent.Tool.Input.Delta.type,
      SessionEvent.Compaction.Delta.type,
    ])
  })
})
