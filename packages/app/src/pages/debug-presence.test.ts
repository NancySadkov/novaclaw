import { describe, expect, test } from "bun:test"
import type { SessionPresenceSnapshot } from "@novaclaw/sdk/v2/client"
import {
  debugPresenceBusy,
  debugPresenceCell,
  debugPresenceOrphanText,
  debugPresenceOrphans,
  type DebugPresenceOrphan,
} from "./debug-presence"
import { VIEWER_TTL_SECONDS } from "./session/session-presence"

const NOW = 1_700_000_000_000

const viewer = (viewerID: string, label: string, over: { writing?: boolean; kind?: "human" | "agent" | "peer" } = {}) => ({
  viewerID,
  kind: over.kind ?? ("human" as const),
  label,
  attachedAt: NOW - 60_000,
  writing: over.writing ?? false,
})

const snapshot = (over: Partial<SessionPresenceSnapshot>): SessionPresenceSnapshot => ({
  state: "solo",
  viewers: [],
  ...over,
})

/** A cell whose snapshot was read from the instance a moment ago — the normal case. */
const cell = (input: { snapshot?: SessionPresenceSnapshot; busy?: boolean; readAt?: number | undefined }) =>
  debugPresenceCell({
    snapshot: input.snapshot,
    busy: input.busy ?? false,
    readAt: "readAt" in input ? input.readAt : NOW - 1_000,
    now: NOW,
  })

describe("debugPresenceCell — attendance", () => {
  test("no viewers reads as unattended, and claims no staleness it has no rows for", () => {
    const view = cell({ snapshot: undefined })
    expect(view.attached).toBe(0)
    expect(view.text).toBe("unattended")
    expect(view.unverified).toBe(false)
    expect(view.title).toBe("")
  })

  test("a room the store kept but that emptied out still reads as unattended", () => {
    expect(cell({ snapshot: snapshot({ state: "unattended", viewers: [] }) }).text).toBe("unattended")
  })

  test("one viewer names it and marks it driving", () => {
    const view = cell({
      snapshot: snapshot({ state: "solo", viewers: [viewer("vw_a", "this browser")], control: "vw_a" }),
    })
    expect(view.text).toBe("1 attached · this browser (driving)")
    expect(view.viewers).toEqual([
      { viewerID: "vw_a", label: "this browser", kind: "human", driving: true, writing: false },
    ])
    // Raw ids belong to a Developer surface — but in the tooltip, not in the line.
    expect(view.title).toBe("vw_a (human)")
  })

  test("several viewers: exactly one is marked driving, and a draft is marked writing", () => {
    const view = cell({
      snapshot: snapshot({
        state: "contended",
        viewers: [
          viewer("vw_a", "a browser window"),
          viewer("vw_b", "a browser window", { writing: true }),
          viewer("vw_c", "Nova on the Spark", { kind: "peer" }),
        ],
        control: "vw_a",
      }),
    })
    expect(view.text).toBe(
      "3 attached · a browser window (driving), a browser window (writing), Nova on the Spark",
    )
    expect(view.viewers.filter((row) => row.driving).map((row) => row.viewerID)).toEqual(["vw_a"])
    // Two windows of one browser stay "a browser window" — the line does not invent a distinction,
    // and the only honest separator (the opaque id) rides the tooltip.
    expect(view.title).toBe("vw_a (human) · vw_b (human) · vw_c (peer)")
  })

  test("the driver's own draft shows both flags on one row", () => {
    const view = cell({
      snapshot: snapshot({
        state: "watched",
        viewers: [viewer("vw_a", "this browser", { writing: true }), viewer("vw_b", "the desktop app")],
        control: "vw_a",
      }),
    })
    expect(view.text).toBe("2 attached · this browser (driving, writing), the desktop app")
  })

  test("a room with no control marks nobody driving rather than guessing the first row", () => {
    const view = cell({ snapshot: snapshot({ state: "solo", viewers: [viewer("vw_a", "this browser")] }) })
    expect(view.text).toBe("1 attached · this browser")
    expect(view.viewers.some((row) => row.driving)).toBe(false)
  })
})

describe("debugPresenceCell — busy is composed, never read from presence", () => {
  test("a busy session with nobody attached is the interesting state and says so", () => {
    const view = cell({ snapshot: undefined, busy: true })
    expect(view.text).toBe("unattended · busy")
    expect(view.busy).toBe(true)
    expect(view.attached).toBe(0)
  })

  test("busy rides alongside attendance without altering it", () => {
    const view = cell({
      snapshot: snapshot({ state: "solo", viewers: [viewer("vw_a", "this browser")], control: "vw_a" }),
      busy: true,
    })
    expect(view.text).toBe("1 attached · this browser (driving) · busy")
  })

  test("an idle session adds no word for it — the status column already carries idle", () => {
    expect(cell({ snapshot: undefined, busy: false }).text).not.toContain("idle")
  })

  // Running it caught this: the first wiring composed busy from the Sessions panel's STATUS COLUMN,
  // which shows the durable execution state when there is one — so a session whose worker had
  // exited (state "paused", phase "drain") read as busy. `debugPresenceBusy` reaches the one owner.
  test("busy comes from the status ALLOWLIST, so a terminal session is not busy", () => {
    expect(debugPresenceBusy({ type: "busy" })).toBe(true)
    expect(debugPresenceBusy({ type: "retry", attempt: 1, message: "reconnecting", next: 0 })).toBe(true)
    expect(debugPresenceBusy({ type: "idle" })).toBe(false)
    expect(debugPresenceBusy({ type: "exited" })).toBe(false)
    expect(debugPresenceBusy(undefined)).toBe(false)
  })
})

describe("debugPresenceCell — a cached room that may have outlived its viewers", () => {
  const attached = snapshot({ state: "solo", viewers: [viewer("vw_a", "this browser")], control: "vw_a" })

  test("a snapshot older than the instance's own expiry budget is marked unverified", () => {
    const view = debugPresenceCell({
      snapshot: attached,
      busy: false,
      readAt: NOW - (VIEWER_TTL_SECONDS * 1000 + 1_000),
      now: NOW,
    })
    expect(view.unverified).toBe(true)
    expect(view.text).toBe("1 attached · this browser (driving) · unverified (read 41s ago)")
  })

  test("a fresh read inside the budget asserts the rows plainly", () => {
    const view = debugPresenceCell({
      snapshot: attached,
      busy: false,
      readAt: NOW - (VIEWER_TTL_SECONDS * 1000 - 1_000),
      now: NOW,
    })
    expect(view.unverified).toBe(false)
    expect(view.text).toBe("1 attached · this browser (driving)")
  })

  test("before the first read lands, viewer rows are shown but not vouched for", () => {
    const view = debugPresenceCell({ snapshot: attached, busy: false, readAt: undefined, now: NOW })
    expect(view.unverified).toBe(true)
    expect(view.text).toBe("1 attached · this browser (driving) · unverified (not read yet)")
  })

  test("long ages read in minutes rather than a three-digit second count", () => {
    const view = debugPresenceCell({ snapshot: attached, busy: false, readAt: NOW - 300_000, now: NOW })
    expect(view.text).toContain("unverified (read 5m ago)")
  })

  test("an unattended cell is never marked unverified, however old the read", () => {
    const view = debugPresenceCell({ snapshot: undefined, busy: true, readAt: NOW - 3_600_000, now: NOW })
    expect(view.unverified).toBe(false)
    expect(view.text).toBe("unattended · busy")
  })
})

describe("debugPresenceOrphans — a room whose session this table does not list", () => {
  const presence: Record<string, SessionPresenceSnapshot | undefined> = {
    ses_live: snapshot({ state: "solo", viewers: [viewer("vw_a", "this browser")], control: "vw_a" }),
    ses_gone: snapshot({
      state: "watched",
      viewers: [viewer("vw_b", "a browser window"), viewer("vw_c", "the desktop app")],
      control: "vw_b",
    }),
  }

  test("a room for a session the client no longer lists is reported, not dropped", () => {
    expect(debugPresenceOrphans(presence, new Set(["ses_live"]))).toEqual([{ sessionID: "ses_gone", attached: 2 }])
  })

  test("nothing is orphaned when every room's session is listed", () => {
    expect(debugPresenceOrphans(presence, new Set(["ses_live", "ses_gone"]))).toEqual([])
  })

  test("an empty room for an unknown session is not worth reporting", () => {
    expect(debugPresenceOrphans({ ses_empty: snapshot({ state: "unattended", viewers: [] }) }, new Set())).toEqual([])
    expect(debugPresenceOrphans({ ses_undef: undefined }, new Set())).toEqual([])
  })

  test("orphans are ordered so the line does not reshuffle between renders", () => {
    const out = debugPresenceOrphans(
      {
        ses_z: snapshot({ state: "solo", viewers: [viewer("vw_z", "a browser window")] }),
        ses_a: snapshot({ state: "solo", viewers: [viewer("vw_a", "a browser window")] }),
      },
      new Set(),
    )
    expect(out.map((orphan) => orphan.sessionID)).toEqual(["ses_a", "ses_z"])
  })

  test("the line names the raw session ids — a Developer surface may", () => {
    const orphans: DebugPresenceOrphan[] = [
      { sessionID: "ses_gone", attached: 2 },
      { sessionID: "ses_other", attached: 1 },
    ]
    expect(debugPresenceOrphanText(orphans)).toBe(
      "presence for 2 sessions not listed above: ses_gone (2 attached), ses_other (1 attached)",
    )
    expect(debugPresenceOrphanText([{ sessionID: "ses_gone", attached: 1 }])).toBe(
      "presence for 1 session not listed above: ses_gone (1 attached)",
    )
  })

  test("no orphans means no line at all, not an empty one", () => {
    expect(debugPresenceOrphanText([])).toBeUndefined()
    expect(debugPresenceOrphanText([], true)).toBeUndefined()
  })

  // Found by running it: with presence reads failing, every row said "unverified" while this line
  // below them went on asserting "1 attached". Same cached map, same doubt.
  test("a stale read makes the orphan line say so too", () => {
    expect(debugPresenceOrphanText([{ sessionID: "ses_gone", attached: 1 }], true)).toBe(
      "presence for 1 session not listed above: ses_gone (1 attached) · unverified",
    )
  })
})
