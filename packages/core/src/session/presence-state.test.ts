import { describe, expect, test } from "bun:test"
import { SessionPresenceState as P } from "./presence-state"

const T0 = 1_700_000_000_000
const SECOND = 1000

const tab = (viewerID: string, label = viewerID) => ({ viewerID, kind: "human" as const, label })

describe("presence — idle", () => {
  test("a session nobody is looking at is unattended, with no driver", () => {
    const snapshot = P.derive(P.empty, T0)
    expect(snapshot.state).toBe("unattended")
    expect(snapshot.viewers).toEqual([])
    expect(snapshot.control).toBeUndefined()
  })

  test("busy is NOT part of presence — an unattended room says nothing about the agent", () => {
    // Pinned deliberately: `session.status`/`session_working` owns "is it working". A second
    // answer here is the two-sources-of-truth defect this component exists to avoid.
    expect(Object.keys(P.derive(P.empty, T0))).toEqual(["state", "viewers"])
  })
})

describe("presence — one viewer", () => {
  test("the first surface to attach is solo and drives, and nothing is announced", () => {
    const room = P.report(P.empty, tab("a"), T0)
    const snapshot = P.derive(room, T0)
    expect(snapshot.state).toBe("solo")
    expect(snapshot.control).toBe("a")
    expect(snapshot.handoff).toBeUndefined()
  })

  test("a heartbeat is the same call as an attach and does not re-attach", () => {
    const first = P.report(P.empty, tab("a"), T0)
    const beat = P.report(first, tab("a"), T0 + 10 * SECOND)
    expect(beat.records).toHaveLength(1)
    expect(beat.records[0]!.attachedAt).toBe(T0)
    expect(beat.records[0]!.lastSeenAt).toBe(T0 + 10 * SECOND)
  })

  test("a lone viewer writing is not a conflict", () => {
    const room = P.report(P.empty, { ...tab("a"), writing: true }, T0)
    expect(P.derive(room, T0).state).toBe("solo")
  })
})

describe("presence — two attached viewers", () => {
  const two = () => {
    const first = P.report(P.empty, tab("a", "this browser"), T0)
    return P.report(first, tab("b", "the desktop app"), T0 + SECOND)
  }

  test("the second surface watches; the first keeps driving", () => {
    const snapshot = P.derive(two(), T0 + SECOND)
    expect(snapshot.state).toBe("watched")
    expect(snapshot.control).toBe("a")
    expect(snapshot.viewers.map((viewer) => viewer.viewerID)).toEqual(["a", "b"])
  })

  test("viewers are listed oldest first — the succession order is visible, not implied", () => {
    const room = P.report(P.report(P.empty, tab("z"), T0 + 5 * SECOND), tab("a"), T0)
    expect(P.derive(room, T0 + 5 * SECOND).viewers.map((viewer) => viewer.viewerID)).toEqual(["a", "z"])
  })

  test("arriving second announces nothing — attaching is not a takeover", () => {
    expect(P.derive(two(), T0 + SECOND).handoff).toBeUndefined()
  })
})

describe("presence — handoff", () => {
  test("claiming control moves the seat and names both sides", () => {
    const before = P.report(P.report(P.empty, tab("a", "this browser"), T0), tab("b", "the desktop app"), T0 + SECOND)
    const after = P.claim(before, "b", T0 + 2 * SECOND)
    const snapshot = P.derive(after, T0 + 2 * SECOND)
    expect(snapshot.control).toBe("b")
    expect(snapshot.handoff).toEqual({
      fromViewerID: "a",
      fromLabel: "this browser",
      toViewerID: "b",
      toLabel: "the desktop app",
      at: T0 + 2 * SECOND,
      reason: "claimed",
    })
  })

  test("the driver claiming again changes nothing and announces nothing", () => {
    const room = P.report(P.empty, tab("a"), T0)
    expect(P.derive(P.claim(room, "a", T0 + SECOND), T0 + SECOND).handoff).toBeUndefined()
  })

  test("a claim from a viewer that already timed out is ignored, not an error", () => {
    const room = P.report(P.empty, tab("a"), T0)
    const claimed = P.claim(room, "ghost", T0 + SECOND)
    expect(P.derive(claimed, T0 + SECOND).control).toBe("a")
  })

  test("when the driver says goodbye, control succeeds — it never goes vacant", () => {
    const before = P.report(P.report(P.empty, tab("a", "this browser"), T0), tab("b", "the desktop app"), T0 + SECOND)
    const after = P.detach(before, "a", T0 + 2 * SECOND)
    const snapshot = P.derive(after, T0 + 2 * SECOND)
    expect(snapshot.state).toBe("solo")
    expect(snapshot.control).toBe("b")
    expect(snapshot.handoff).toEqual({
      fromViewerID: "a",
      fromLabel: "this browser",
      toViewerID: "b",
      toLabel: "the desktop app",
      at: T0 + 2 * SECOND,
      reason: "succession",
    })
  })
})

describe("presence — conflict", () => {
  const bothWriting = () => {
    const first = P.report(P.empty, { ...tab("a"), writing: true }, T0)
    return P.report(first, { ...tab("b"), writing: true }, T0 + SECOND)
  }

  test("a watcher who starts writing makes the room contended", () => {
    expect(P.derive(bothWriting(), T0 + SECOND).state).toBe("contended")
  })

  test("contention is reported, never resolved — both viewers stay attached and the driver is unchanged", () => {
    const snapshot = P.derive(bothWriting(), T0 + SECOND)
    expect(snapshot.viewers).toHaveLength(2)
    expect(snapshot.control).toBe("a")
  })

  test("only the DRIVER writing is ordinary work, not contention", () => {
    const first = P.report(P.empty, { ...tab("a"), writing: true }, T0)
    const room = P.report(first, tab("b"), T0 + SECOND)
    expect(P.derive(room, T0 + SECOND).state).toBe("watched")
  })

  test("clearing the draft clears the contention", () => {
    const calm = P.report(bothWriting(), { ...tab("b"), writing: false }, T0 + 2 * SECOND)
    expect(P.derive(calm, T0 + 2 * SECOND).state).toBe("watched")
  })
})

describe("presence — a stale viewer must EXPIRE", () => {
  const ttl = P.VIEWER_TTL_SECONDS * SECOND

  test("the heartbeat budget is three missed beats, not one", () => {
    expect(P.VIEWER_TTL_SECONDS / P.HEARTBEAT_SECONDS).toBeGreaterThanOrEqual(3)
  })

  test("a viewer still inside the budget is present", () => {
    const room = P.report(P.empty, tab("a"), T0)
    expect(P.derive(room, T0 + ttl).viewers).toHaveLength(1)
  })

  test("a closed tab that never said goodbye stops being attached", () => {
    const room = P.report(P.empty, tab("a"), T0)
    const snapshot = P.derive(room, T0 + ttl + 1)
    expect(snapshot.state).toBe("unattended")
    expect(snapshot.viewers).toEqual([])
  })

  test("a stale DRIVER hands the seat to whoever is still here", () => {
    const before = P.report(P.report(P.empty, tab("a", "the closed tab"), T0), tab("b", "this browser"), T0 + SECOND)
    const alive = P.report(before, tab("b", "this browser"), T0 + ttl)
    const snapshot = P.derive(alive, T0 + ttl + 1)
    expect(snapshot.control).toBe("b")
    expect(snapshot.handoff?.reason).toBe("succession")
    expect(snapshot.handoff?.fromLabel).toBe("the closed tab")
  })

  test("a room that empties out FORGETS its handoff, so a later arrival is not told a stale story", () => {
    const before = P.report(P.report(P.empty, tab("a"), T0), tab("b"), T0 + SECOND)
    const emptied = P.expire(P.detach(before, "a", T0 + 2 * SECOND), T0 + ttl + 10 * SECOND)
    expect(P.isEmpty(emptied)).toBe(true)
    const later = P.report(emptied, tab("c"), T0 + 10 * ttl)
    const snapshot = P.derive(later, T0 + 10 * ttl)
    expect(snapshot.handoff).toBeUndefined()
    expect(snapshot.control).toBe("c")
  })

  test("expiry is applied on READ too, so a snapshot is never stale even if no sweep ran", () => {
    const room = P.report(P.empty, tab("a"), T0)
    expect(P.derive(room, T0 + 10 * ttl).state).toBe("unattended")
  })
})

describe("presence — republish gate", () => {
  test("a heartbeat that changes nothing produces an identical snapshot", () => {
    const first = P.report(P.empty, tab("a"), T0)
    const beat = P.report(first, tab("a"), T0 + P.HEARTBEAT_SECONDS * SECOND)
    expect(P.sameSnapshot(P.derive(first, T0), P.derive(beat, T0 + P.HEARTBEAT_SECONDS * SECOND))).toBe(true)
  })

  test("a heartbeat that starts a draft does NOT compare equal", () => {
    const first = P.report(P.report(P.empty, tab("a"), T0), tab("b"), T0)
    const beat = P.report(first, { ...tab("b"), writing: true }, T0 + P.HEARTBEAT_SECONDS * SECOND)
    expect(P.sameSnapshot(P.derive(first, T0), P.derive(beat, T0 + P.HEARTBEAT_SECONDS * SECOND))).toBe(false)
  })
})

describe("presence — a peer instance is just another viewer", () => {
  test("a remote peer attaches through the same call and appears in the same list", () => {
    const room = P.report(
      P.report(P.empty, tab("a", "this browser"), T0),
      { viewerID: "peer-1", kind: "peer", label: "Nova on the Spark" },
      T0 + SECOND,
    )
    const snapshot = P.derive(room, T0 + SECOND)
    expect(snapshot.viewers.map((viewer) => viewer.kind)).toEqual(["human", "peer"])
    expect(snapshot.state).toBe("watched")
  })

  test("a peer can take control like anyone else — there is no privileged surface", () => {
    const room = P.report(
      P.report(P.empty, tab("a"), T0),
      { viewerID: "peer-1", kind: "peer", label: "Nova on the Spark" },
      T0 + SECOND,
    )
    expect(P.derive(P.claim(room, "peer-1", T0 + 2 * SECOND), T0 + 2 * SECOND).control).toBe("peer-1")
  })
})
