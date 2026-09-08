import { describe, expect, test } from "bun:test"
import type { SessionV2Info as Session } from "@novaclaw/sdk/v2/client"
import { applyControlPatch, controlPatch } from "./control-fold"

// P2 (ui-arch-hardening): every V2 control event folds into the client record exactly like the
// server projector folds it into SessionTable. A control event NOT mapped here leaves open views
// stale until reload — the convention (app AGENTS.md) says that must never happen silently.

const envelope = (type: string, properties: Record<string, unknown>) => ({ type, properties })

describe("controlPatch", () => {
  test("folds the short Chat posture into the live session record", () => {
    expect(
      controlPatch(envelope("session.next.feature.switched", { sessionID: "s", feature: "shortChat", enabled: true })),
    ).toEqual({ sessionID: "s", patch: { shortChat: true } })
  })
  test("maps every switch event onto its record field", () => {
    expect(controlPatch(envelope("session.next.agent.switched", { sessionID: "s", agent: "review" }))).toEqual({
      sessionID: "s",
      patch: { agent: "review" },
    })
    expect(
      controlPatch(envelope("session.next.model.switched", { sessionID: "s", model: { id: "m", providerID: "p" } })),
    ).toEqual({ sessionID: "s", patch: { model: { id: "m", providerID: "p" } } })
    expect(
      controlPatch(envelope("session.next.responder.switched", { sessionID: "s", responder: "operator" })),
    ).toEqual({ sessionID: "s", patch: { responder: "operator" } })
    expect(controlPatch(envelope("session.next.mode.switched", { sessionID: "s", permissionMode: "bypass" }))).toEqual({
      sessionID: "s",
      patch: { permissionMode: "bypass" },
    })
    expect(
      controlPatch(envelope("session.next.strict.switched", { sessionID: "s", strict: { enabled: true } })),
    ).toEqual({ sessionID: "s", patch: { strict: { enabled: true } } })
    expect(
      controlPatch(envelope("session.next.feature.switched", { sessionID: "s", feature: "quality", enabled: true })),
    ).toEqual({ sessionID: "s", patch: { quality: true } })
    expect(
      controlPatch(envelope("session.next.prompt-override.switched", { sessionID: "s", override: "be brief" })),
    ).toEqual({ sessionID: "s", patch: { systemPromptOverride: "be brief" } })
    expect(
      controlPatch(envelope("session.next.type.switched", { sessionID: "s", sessionType: "auto-prompting" })),
    ).toEqual({ sessionID: "s", patch: { type: "auto-prompting" } })
    // T3 shape: the move patches the record's `location` struct (+ subpath), never a flat
    // top-level `directory` — that field doesn't exist on the record and patching it left every
    // reader (folder chip, Chats grouping) on the OLD folder until reload.
    expect(controlPatch(envelope("session.next.moved", { sessionID: "s", location: { directory: "C:\\x" } }))).toEqual({
      sessionID: "s",
      patch: { location: { directory: "C:\\x" }, subpath: undefined },
    })
    expect(
      controlPatch(
        envelope("session.next.moved", { sessionID: "s", location: { directory: "C:\\x" }, subdirectory: "sub" }),
      ),
    ).toEqual({ sessionID: "s", patch: { location: { directory: "C:\\x" }, subpath: "sub" } })
  })

  test("null clears map to undefined (field goes absent, matching a fresh server read)", () => {
    expect(controlPatch(envelope("session.next.strict.switched", { sessionID: "s", strict: null }))?.patch).toEqual({
      strict: undefined,
    })
    expect(
      controlPatch(envelope("session.next.feature.switched", { sessionID: "s", feature: "affective", enabled: null }))
        ?.patch,
    ).toEqual({ affective: undefined })
    expect(
      controlPatch(envelope("session.next.prompt-override.switched", { sessionID: "s", override: null }))?.patch,
    ).toEqual({ systemPromptOverride: undefined })
  })

  test("🔴 the provider-attempt latch is set AND cleared on the record", () => {
    // The defect this pins (owner-hit 2026-08-11): a finished reply was followed by the composer's
    // "A previous reply was interrupted" dock on every turn. The server row was correct throughout;
    // only the client's copy was stale, because `.settled` publishes no `session.updated` and had no
    // arm here. Set and clear are asserted together — an arm for `started` alone would produce a
    // latch that can only ever appear.
    const recovery = { attemptID: "evt_1", assistantMessageID: "msg_1", toolProtocol: false }
    expect(
      controlPatch(envelope("session.next.provider-attempt.started", { sessionID: "s", recovery })),
    ).toEqual({ sessionID: "s", patch: { providerRecovery: recovery } })
    for (const type of ["session.next.provider-attempt.settled", "session.next.provider-attempt.abandoned"])
      expect(controlPatch(envelope(type, { sessionID: "s", attemptID: "evt_1" })), type).toEqual({
        sessionID: "s",
        patch: { providerRecovery: undefined },
      })
  })

  test("🔴 a settled attempt leaves NO latch on the record the dock reads", () => {
    // End to end through the applier, because "patch: {providerRecovery: undefined}" is only a fix
    // if it DELETES the field — the dock's condition is truthiness of the record's value.
    const draft = { id: "s" } as unknown as Session
    const started = controlPatch(
      envelope("session.next.provider-attempt.started", {
        sessionID: "s",
        recovery: { attemptID: "evt_1", assistantMessageID: "msg_1", toolProtocol: false },
      }),
    )!
    applyControlPatch(draft, started.patch)
    expect((draft as Record<string, unknown>).providerRecovery, "set while the attempt runs").toBeDefined()

    const settled = controlPatch(
      envelope("session.next.provider-attempt.settled", { sessionID: "s", attemptID: "evt_1" }),
    )!
    applyControlPatch(draft, settled.patch)
    expect("providerRecovery" in draft, "cleared the moment it settles").toBe(false)
  })

  test("ignores non-control events, unknown features, and missing sessionIDs", () => {
    expect(controlPatch(envelope("session.next.prompted", { sessionID: "s" }))).toBeUndefined()
    expect(controlPatch(envelope("session.updated", { info: {} }))).toBeUndefined()
    expect(
      controlPatch(envelope("session.next.feature.switched", { sessionID: "s", feature: "bogus" })),
    ).toBeUndefined()
    expect(controlPatch(envelope("session.next.agent.switched", { agent: "x" }))).toBeUndefined()
  })
})

describe("applyControlPatch", () => {
  test("sets fields and DELETES cleared ones off the draft", () => {
    const draft = { id: "s", strict: { enabled: true }, quality: true } as unknown as Session
    applyControlPatch(draft, { strict: undefined, quality: false, agent: "review" })
    expect("strict" in draft).toBe(false)
    expect((draft as Record<string, unknown>).quality).toBe(false)
    expect((draft as Record<string, unknown>).agent).toBe("review")
  })
})
