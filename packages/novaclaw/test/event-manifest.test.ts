import { describe, expect, test } from "bun:test"
import { SessionEvent } from "@novaclaw/core/session/event"
import { EventManifest as SchemaEventManifest } from "@novaclaw/schema/event-manifest"
import { SessionTodo } from "@novaclaw/schema/session-todo"
import { EventManifest } from "@/event-manifest"

describe("public event manifest", () => {
  test("contains every latest public wire type once", () => {
    // These three identity checks are this test's real job: novaclaw's `@/event-manifest`
    // must re-export the SAME manifest objects as `@novaclaw/schema`, not a fork. The exact
    // counts are owned + pinned by the schema package's manifest test (single source of truth);
    // re-asserting a literal size here only drifts out of sync (it did — was 88, schema is 89).
    expect(EventManifest.Definitions).toBe(SchemaEventManifest.Definitions)
    expect(EventManifest.Latest).toBe(SchemaEventManifest.Latest)
    expect(EventManifest.Durable).toBe(SchemaEventManifest.Durable)
    expect(EventManifest.Latest.get("session.next.step.ended")).toBe(SessionEvent.Step.Ended)
    expect(EventManifest.Latest.get("todo.updated")).toBe(SessionTodo.Event.Updated)
    expect(EventManifest.Latest.has("ide.installed")).toBe(false)
    // Transport envelopes belong to their streams, not to the published bus inventory.
    expect(EventManifest.Latest.has("server.connected")).toBe(false)
    expect(EventManifest.Latest.has("global.disposed")).toBe(false)
  })

  test("contains only the current step settlement versions", () => {
    expect(EventManifest.Durable.has("session.next.step.ended.1")).toBe(false)
    expect(EventManifest.Durable.get("session.next.step.ended.2")).toBe(SessionEvent.Step.Ended)
  })
})
