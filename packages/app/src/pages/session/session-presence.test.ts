import { describe, expect, test } from "bun:test"
import type { SessionPresenceSnapshot } from "@novaclaw/sdk/v2/client"
import { HANDOFF_NOTICE_SECONDS, presenceBadge, presenceHandoffNotice, presenceView } from "./session-presence"

const T0 = 1_700_000_000_000

const viewer = (viewerID: string, label: string, writing = false) => ({
  viewerID,
  kind: "human" as const,
  label,
  attachedAt: T0,
  writing,
})

const snapshot = (over: Partial<SessionPresenceSnapshot>): SessionPresenceSnapshot => ({
  state: "solo",
  viewers: [],
  ...over,
})

describe("presenceView — alone", () => {
  test("an unattended chat says nothing", () => {
    const view = presenceView(undefined, "me")
    expect(view.line).toBeUndefined()
    expect(view.canTakeOver).toBe(false)
  })

  test("the only viewer is driving and is told nothing — silence is the right copy", () => {
    const view = presenceView(snapshot({ state: "solo", viewers: [viewer("me", "this browser")], control: "me" }), "me")
    expect(view.driving).toBe(true)
    expect(view.line).toBeUndefined()
    expect(view.others).toEqual([])
  })
})

describe("presenceView — two attached viewers", () => {
  const both = snapshot({
    state: "watched",
    viewers: [viewer("me", "this browser"), viewer("them", "the desktop app")],
    control: "me",
  })

  test("the driver is told who else is here, not warned about them", () => {
    const view = presenceView(both, "me")
    expect(view.line).toEqual({ key: "presence.driving", values: { others: "the desktop app" } })
    expect(view.canTakeOver).toBe(false)
  })

  test("the watcher is told who is driving AND that it can still type", () => {
    const view = presenceView(both, "them")
    expect(view.line).toEqual({ key: "presence.watching", values: { driver: "this browser" } })
    // The copy behind this key ends "you can still type" — control is advisory, never a wall.
    expect(view.canTakeOver).toBe(true)
  })

  test("a surface that is not attached at all is offered no take-over", () => {
    expect(presenceView(both, "someone-else").canTakeOver).toBe(false)
  })

  test("three viewers name all the others", () => {
    const three = snapshot({
      state: "watched",
      viewers: [viewer("me", "this browser"), viewer("b", "the desktop app"), viewer("c", "another NovaClaw")],
      control: "me",
    })
    expect(presenceView(three, "me").line?.values.others).toBe("the desktop app, another NovaClaw")
  })
})

describe("presenceView — conflict", () => {
  const contended = snapshot({
    state: "contended",
    viewers: [viewer("me", "this browser", true), viewer("them", "the desktop app", true)],
    control: "me",
  })

  test("the driver is told WHO ELSE is writing, never that they themselves are", () => {
    // ⚠️ Regression pin. The first copy said "You and X are both writing" to the driver, which is
    // false whenever the driver has no draft — and a room is contended on the WATCHER's draft
    // alone. Caught by opening two windows, not by a test; this is that test.
    const quietDriver = snapshot({
      state: "contended",
      viewers: [viewer("me", "this browser", false), viewer("them", "the desktop app", true)],
      control: "me",
    })
    expect(presenceView(quietDriver, "me").line).toEqual({
      key: "presence.contended.driving",
      values: { writers: "the desktop app" },
    })
  })

  test("a writing watcher is told about its OWN draft against the driver", () => {
    expect(presenceView(contended, "them").line).toEqual({
      key: "presence.contended.youWriting",
      values: { driver: "this browser" },
    })
  })

  test("a third viewer that is writing is named — not the whole room", () => {
    const three = snapshot({
      state: "contended",
      viewers: [
        viewer("me", "this browser", false),
        viewer("driver", "the desktop app", false),
        viewer("noisy", "another NovaClaw", true),
      ],
      control: "driver",
    })
    expect(presenceView(three, "me").line).toEqual({
      key: "presence.contended.otherWriting",
      values: { writers: "another NovaClaw", driver: "the desktop app" },
    })
  })

  test("a conflict never takes the take-over away — the watcher can still resolve it", () => {
    expect(presenceView(contended, "them").canTakeOver).toBe(true)
  })
})

describe("presenceHandoffNotice", () => {
  const claimed = snapshot({
    state: "watched",
    viewers: [viewer("me", "this browser"), viewer("them", "the desktop app")],
    control: "them",
    handoff: {
      fromViewerID: "me",
      fromLabel: "this browser",
      toViewerID: "them",
      toLabel: "the desktop app",
      at: T0,
      reason: "claimed",
    },
  })

  test("the one who took over is told so in the first person", () => {
    expect(presenceHandoffNotice(claimed, "them", T0)).toEqual({ key: "presence.handoff.youTookOver", values: {} })
  })

  test("the one who lost the seat is told who has it", () => {
    expect(presenceHandoffNotice(claimed, "me", T0)).toEqual({
      key: "presence.handoff.otherTookOver",
      values: { who: "the desktop app" },
    })
  })

  test("inheriting from someone who left names them — the most useful notice there is", () => {
    const inherited = snapshot({
      state: "solo",
      viewers: [viewer("me", "this browser")],
      control: "me",
      handoff: {
        fromViewerID: "gone",
        fromLabel: "the desktop app",
        toViewerID: "me",
        toLabel: "this browser",
        at: T0,
        reason: "succession",
      },
    })
    // Shown to a viewer who is now ALONE: this is why the notice cannot live inside presenceView.
    expect(presenceHandoffNotice(inherited, "me", T0)).toEqual({
      key: "presence.handoff.youInherited",
      values: { who: "the desktop app" },
    })
    expect(presenceView(inherited, "me").line).toBeUndefined()
  })

  test("the notice stops being news after its window", () => {
    expect(presenceHandoffNotice(claimed, "them", T0 + HANDOFF_NOTICE_SECONDS * 1000)).toBeDefined()
    expect(presenceHandoffNotice(claimed, "them", T0 + HANDOFF_NOTICE_SECONDS * 1000 + 1)).toBeUndefined()
  })

  test("no handoff, no notice", () => {
    expect(presenceHandoffNotice(snapshot({ viewers: [viewer("me", "x")] }), "me", T0)).toBeUndefined()
  })
})

describe("presenceBadge — the Chats row", () => {
  test("nobody attached shows no badge at all, rather than a zero", () => {
    expect(presenceBadge(undefined)).toBeUndefined()
    expect(presenceBadge(snapshot({ state: "unattended", viewers: [] }))).toBeUndefined()
  })

  test("the badge counts every attached surface and names them for the tooltip", () => {
    const badge = presenceBadge(
      snapshot({ state: "watched", viewers: [viewer("a", "this browser"), viewer("b", "the desktop app")] }),
    )
    expect(badge).toEqual({ count: 2, list: "this browser, the desktop app", contended: false })
  })

  test("contention is carried to the row so Chats can show it without opening the chat", () => {
    const badge = presenceBadge(
      snapshot({ state: "contended", viewers: [viewer("a", "x", true), viewer("b", "y", true)] }),
    )
    expect(badge?.contended).toBe(true)
  })
})
