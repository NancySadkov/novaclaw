import { describe, expect, test } from "bun:test"
import {
  BURST_LIMIT,
  BURST_WINDOW_MS,
  captionFor,
  clearOverlay,
  decodeMemoryEvent,
  emptyActivity,
  FEED_MAX,
  FLARE_MAX_WAIT_MS,
  FLARE_MS,
  foldActivity,
  initialLink,
  isBurst,
  linkSentence,
  markSynced,
  mayReconcile,
  pruneActivity,
  RANK_RING_R,
  RANK_STAGGER_MAX_MS,
  rankDelayMs,
  rankPop,
  RECALL_HOLD_MS,
  RECONCILE_MIN_GAP_MS,
  stepLink,
  type ActivityState,
  type MemoryActivity,
} from "./activity"

const claim = (over: Partial<Extract<MemoryActivity, { kind: "claim" }>> = {}) =>
  ({
    kind: "claim",
    id: "c1",
    scope: "global",
    statement: "Ann works at Acme",
    status: "active",
    identified: true,
    deduped: false,
    superseded: [],
    subject: "ann",
    predicate: "works_at",
    ...over,
  }) as MemoryActivity

const recalled = (ids: readonly string[], over: Record<string, unknown> = {}) =>
  ({
    kind: "recalled",
    fingerprint: "qf_abc",
    surface: "auto-recall",
    scopes: ["global"],
    hits: ids.map((id, index) => ({ id, rank: index + 1, score: 1 - index / 10, scope: "global" })),
    considered: ids.length,
    ...over,
  }) as MemoryActivity

const fold = (state: ActivityState, activity: MemoryActivity, now: number, animate = true, missed = false) =>
  foldActivity(state, activity, { now, animate, missed })

describe("decodeMemoryEvent", () => {
  test("anything that is not a memory event is not ours", () => {
    expect(decodeMemoryEvent({ type: undefined, properties: {} })).toBeUndefined()
    expect(decodeMemoryEvent({ type: "memory.something.new", properties: {} })).toBeUndefined()
  })

  test("a payload with no id is DROPPED, never rendered as a memory with no name", () => {
    expect(decodeMemoryEvent({ type: "memory.claim.recorded", properties: { statement: "x" } })).toBeUndefined()
    expect(decodeMemoryEvent({ type: "memory.forgotten", properties: { mode: "purge" } })).toBeUndefined()
  })

  test("a claim decodes with its supersessions and its identity", () => {
    const activity = decodeMemoryEvent({
      type: "memory.claim.recorded",
      properties: {
        id: "c2",
        scope: "agent:scout",
        statement: "Ann works at Initech",
        status: "active",
        identified: true,
        deduped: false,
        superseded: ["c1", "c0"],
        subject: "ann",
        predicate: "works_at",
      },
    })
    expect(activity).toMatchObject({ kind: "claim", id: "c2", superseded: ["c1", "c0"], identified: true })
  })

  test("🔴 a malformed field degrades instead of throwing — the viewer never crashes to a dead end", () => {
    const activity = decodeMemoryEvent({
      type: "memory.recalled",
      properties: { fingerprint: 7, surface: "telepathy", scopes: "global", hits: [{ rank: "1" }, { id: "m1" }] },
    })
    expect(activity).toMatchObject({ kind: "recalled", fingerprint: "", surface: "unknown", scopes: [] })
    // the hit with no id is dropped; the one with a bad rank keeps its id and reads rank 0
    expect((activity as Extract<MemoryActivity, { kind: "recalled" }>).hits).toEqual([
      { id: "m1", rank: 0, score: 0, scope: "global" },
    ])
  })
})

describe("captionFor", () => {
  test("a correction says it CORRECTED, and a plain write says it learned", () => {
    expect(captionFor(claim({ superseded: ["old"] })).tone).toBe("correction")
    expect(captionFor(claim()).tone).toBe("write")
  })

  test("a deduped claim is still captioned — 'Nova already knew that' answers a real question", () => {
    expect(captionFor(claim({ deduped: true })).caption).toContain("Already knew")
  })

  test("🔴 an EMPTY recall is captioned, because 'why did it not remember' is the useful case", () => {
    const { caption, tone } = captionFor(recalled([]))
    expect(tone).toBe("recall")
    expect(caption).toContain("found nothing")
  })

  test("an unidentified claim says it can never be corrected, on demand rather than in the line", () => {
    const { caption, detail } = captionFor(claim({ identified: false }))
    expect(caption).not.toContain("identity")
    expect(detail).toContain("nothing can correct it later")
  })
})

describe("foldActivity", () => {
  test("a correction retires the priors AND flares them", () => {
    const state = fold(emptyActivity(), claim({ id: "new", superseded: ["old1", "old2"] }), 1000)
    expect([...state.retired]).toEqual(["old1", "old2"])
    expect(state.flares.get("old1")?.tone).toBe("retire")
    // the new claim ripples as an EDIT, not as a birth — an answer changed, one did not appear
    expect(state.flares.get("new")?.tone).toBe("edit")
  })

  test("🔴 animate:false keeps the CAPTION and the STATE and drops only the flare", () => {
    // This one line serves both reduced motion and a stale backlog. If it ever stops holding, the
    // reduced-motion user loses the fact along with the animation.
    const state = fold(emptyActivity(), claim({ id: "new", superseded: ["old"] }), 1000, false)
    expect(state.entries).toHaveLength(1)
    expect([...state.retired]).toEqual(["old"])
    expect(state.flares.size).toBe(0)
  })

  test("🔴 REDUCED MOTION is not a BACKLOG — only what the user could not have seen is counted", () => {
    // Both fold without a flare, and only one of them is news. Conflating them puts "N changes
    // arrived at once" on screen after every single event, for exactly the person who asked for
    // less movement.
    expect(fold(emptyActivity(), claim(), 1000, false, false).skipped).toBe(0)
    expect(fold(emptyActivity(), claim(), 1000, false, true).skipped).toBe(1)
  })

  test("a recall is a SLOT — the newest question replaces the last one", () => {
    let state = fold(emptyActivity(), recalled(["a", "b"]), 1000)
    state = fold(state, recalled(["c"]), 2000)
    expect(state.recall?.ranks.get("a")).toBeUndefined()
    expect(state.recall?.ranks.get("c")).toBe(1)
    expect(state.recall?.found).toBe(1)
  })

  test("🔴 a recall never marks the view dirty — an open viewer adds no work to the recall path", () => {
    const state = fold(emptyActivity(), recalled(["a"]), 1000)
    expect(state.dirty).toBe(false)
    expect(fold(state, claim(), 1100).dirty).toBe(true)
  })

  test("a DEDUPED claim changed nothing in the store, so it asks for no re-read", () => {
    expect(fold(emptyActivity(), claim({ deduped: true }), 1000).dirty).toBe(false)
  })

  test("the feed is bounded, and the bound drops the OLDEST", () => {
    let state = emptyActivity()
    for (let i = 0; i < FEED_MAX + 5; i++) state = fold(state, claim({ id: `c${i}`, statement: `s${i}` }), 1000 + i)
    expect(state.entries).toHaveLength(FEED_MAX)
    expect(state.entries[0]!.caption).toContain(`s${FEED_MAX + 4}`)
    expect(state.entries.some((entry) => entry.caption.includes("“s0”"))).toBe(false)
  })

  test("🔴 an existing entry keeps its OBJECT IDENTITY across a fold — `<For>` keys by reference", () => {
    const first = fold(emptyActivity(), claim({ id: "a" }), 1000)
    const second = fold(first, claim({ id: "b" }), 1100)
    expect(second.entries[1]).toBe(first.entries[0]!)
    expect(second.entries[0]!.key).not.toBe(second.entries[1]!.key)
  })

  test("forgetting retires; restoring un-retires", () => {
    let state = fold(emptyActivity(), { kind: "forgotten", id: "m1", mode: "invalidate" }, 1000)
    expect(state.retired.has("m1")).toBe(true)
    state = fold(state, { kind: "status", id: "m1", status: "active", reason: "restored" }, 1100)
    expect(state.retired.has("m1")).toBe(false)
  })
})

describe("pruneActivity", () => {
  test("nothing to do = the SAME object, so no memo downstream recomputes", () => {
    // ⚠️ The FIRST prune after a flare appears does mint a new state: it stamps the flare's
    // `shownAt`. The identity claim is about the steady state — an idle page pruning at 5 Hz must
    // not recompute every memo forever.
    const state = pruneActivity(fold(emptyActivity(), claim(), 1000), 1001)
    expect(pruneActivity(state, 1002)).toBe(state)
    expect(pruneActivity(state, 1000 + FLARE_MS - 1)).toBe(state)
  })

  test("a flare expires, and the recall outlives it", () => {
    let state = fold(emptyActivity(), claim(), 1000)
    state = fold(state, recalled(["a"]), 1000)
    state = pruneActivity(state, 1000) // the mark is on the canvas; the flare's clock starts here
    const pruned = pruneActivity(state, 1000 + FLARE_MS)
    expect(pruned.flares.size).toBe(0)
    expect(pruned.recall).toBeDefined()
    expect(pruneActivity(pruned, 1000 + RECALL_HOLD_MS).recall).toBeUndefined()
  })

  test("expiry never touches the FEED — captions outlive every animation", () => {
    const state = fold(emptyActivity(), claim(), 1000)
    expect(pruneActivity(state, 1000 + RECALL_HOLD_MS * 10).entries).toHaveLength(1)
  })

  test("🔴 a flare WAITS for its mark, then gets its full span", () => {
    // A written memory is captioned within milliseconds and drawn only after the debounced re-read.
    // Timing the flare from the EVENT spent most of its life on empty canvas.
    const invisible = { isVisible: () => false }
    const visible = { isVisible: () => true }
    let state = fold(emptyActivity(), claim({ id: "c1" }), 1000)
    // ...still nothing on the canvas one whole flare-span later, and the flare is still waiting
    state = pruneActivity(state, 1000 + FLARE_MS, invisible)
    expect(state.flares.has("c1")).toBe(true)
    expect(state.flares.get("c1")!.shownAt).toBeUndefined()
    // the node arrives; the clock starts NOW
    state = pruneActivity(state, 1000 + FLARE_MS + 10, visible)
    expect(state.flares.get("c1")!.shownAt).toBe(1000 + FLARE_MS + 10)
    expect(pruneActivity(state, 1000 + FLARE_MS + 10 + FLARE_MS - 1, visible).flares.has("c1")).toBe(true)
    expect(pruneActivity(state, 1000 + FLARE_MS + 10 + FLARE_MS, visible).flares.has("c1")).toBe(false)
  })

  test("⚠️ a mark that NEVER arrives does not wait forever", () => {
    // Filtered out by a kind chip, in another colleague's cabinet, outside the slice the server
    // sent — all real. Without the cap those flares would sit on the map indefinitely.
    const invisible = { isVisible: () => false }
    const state = fold(emptyActivity(), claim({ id: "c1" }), 1000)
    expect(pruneActivity(state, 1000 + FLARE_MAX_WAIT_MS - 1, invisible).flares.has("c1")).toBe(true)
    expect(pruneActivity(state, 1000 + FLARE_MAX_WAIT_MS, invisible).flares.has("c1")).toBe(false)
  })

  test("with no canvas to ask, a flare is visible at once and lives its ordinary span", () => {
    const state = pruneActivity(fold(emptyActivity(), claim(), 1000), 1000)
    expect(state.flares.get("c1")!.shownAt).toBe(1000)
    expect(pruneActivity(state, 1000 + FLARE_MS - 1).flares.size).toBe(1)
    expect(pruneActivity(state, 1000 + FLARE_MS).flares.size).toBe(0)
  })
})

describe("isBurst", () => {
  test("an ordinary trickle is not a burst", () => {
    let state = emptyActivity()
    for (let i = 0; i < BURST_LIMIT + 4; i++) state = fold(state, claim({ id: `c${i}` }), 1000 + i * 1000)
    expect(isBurst(state, 1000 + (BURST_LIMIT + 4) * 1000)).toBe(false)
  })

  test("🔴 a replay IS — a throttled tab delivers its backlog all at once", () => {
    let state = emptyActivity()
    for (let i = 0; i < BURST_LIMIT; i++) state = fold(state, claim({ id: `c${i}` }), 1000 + i)
    expect(isBurst(state, 1000 + BURST_LIMIT)).toBe(true)
    // ...and the window forgets: the same events are no longer a burst a second later
    expect(isBurst(state, 1000 + BURST_WINDOW_MS + 1)).toBe(false)
  })

  test("⚠️ the window is PRUNED as it slides — it is a rate meter, not a growing log", () => {
    // Found by A/B: deleting the prune inside `withRecent` left every assertion above green,
    // because `isBurst` re-checks the window anyway. What it would actually cost is an array that
    // grows for the life of an open tab — invisible to every test that only asks "is this a burst".
    let state = emptyActivity()
    for (let i = 0; i < 200; i++) state = fold(state, claim({ id: `c${i}` }), 1000 + i * 1000)
    expect(state.recent.length).toBe(1)
  })
})

describe("stepLink", () => {
  test("🔴 a FIRST connection is not a reconnection — it must not fire a re-read", () => {
    const opened = stepLink(initialLink(), "connected")
    expect(opened.reconcile).toBe(false)
    expect(opened.link.seen).toBe(true)
  })

  test("a drop and a return DOES reconcile — once", () => {
    let link = stepLink(initialLink(), "connected").link
    link = stepLink(link, "reconnecting").link
    const back = stepLink(link, "connected")
    expect(back.reconcile).toBe(true)
    // the very next `connected` (a duplicate status notification) must not reconcile again
    expect(stepLink(back.link, "connected").reconcile).toBe(false)
  })

  test("⚠️ `idle` counts as a loss — a stopped stream missed exactly as much as a dropped one", () => {
    let link = stepLink(initialLink(), "connected").link
    link = stepLink(link, "idle").link
    expect(stepLink(link, "connected").reconcile).toBe(true)
  })

  test("a stream that never connected cannot be lost", () => {
    const link = stepLink(initialLink(), "reconnecting").link
    expect(link.lost).toBe(false)
    expect(stepLink(link, "connected").reconcile).toBe(false)
  })
})

describe("mayReconcile", () => {
  test("the first one always may; a flapping link is rate-limited", () => {
    expect(mayReconcile(undefined, 5000)).toBe(true)
    expect(mayReconcile(5000, 5000 + RECONCILE_MIN_GAP_MS - 1)).toBe(false)
    expect(mayReconcile(5000, 5000 + RECONCILE_MIN_GAP_MS)).toBe(true)
  })
})

describe("linkSentence", () => {
  test("🔴 a HEALTHY stream says nothing — a permanent status light is one nobody reads", () => {
    expect(linkSentence("connected", false)).toBeUndefined()
  })

  test("every unhealthy state gets a calm sentence, never a stack trace", () => {
    expect(linkSentence("reconnecting", false)).toBe("Connection lost — reconnecting…")
    expect(linkSentence("connecting", false)).toBe("Connecting…")
    expect(linkSentence("idle", false)).toBe("Not watching yet.")
    for (const status of ["reconnecting", "connecting", "idle"] as const)
      expect(linkSentence(status, false)!).not.toMatch(/error|failed|Error/)
  })

  test("connected-but-reconciling is its own state, and says so", () => {
    // The stream is back and the store has not been re-read yet. Saying nothing here would let the
    // user act on a picture that is knowingly out of date.
    expect(linkSentence("connected", true)).toBe("Catching up…")
  })
})

describe("clearOverlay / markSynced", () => {
  test("a reconcile drops the overlay and KEEPS the feed", () => {
    let state = fold(emptyActivity(), claim(), 1000)
    state = fold(state, recalled(["a"]), 1000)
    const cleared = clearOverlay(state)
    expect(cleared.flares.size).toBe(0)
    expect(cleared.recall).toBeUndefined()
    expect(cleared.entries).toHaveLength(2)
    // nothing to clear = the same object
    expect(clearOverlay(cleared)).toBe(cleared)
  })

  test("syncing clears the dirty flag and the skipped counter", () => {
    const state = fold(emptyActivity(), claim(), 1000, false, true)
    const synced = markSynced(state)
    expect(synced.dirty).toBe(false)
    expect(synced.skipped).toBe(0)
    expect(markSynced(synced)).toBe(synced)
  })
})

describe("rankDelayMs", () => {
  test("rank 1 is immediate, later ranks stagger, and the stagger is capped", () => {
    expect(rankDelayMs(1)).toBe(0)
    expect(rankDelayMs(3)).toBeGreaterThan(rankDelayMs(2))
    expect(rankDelayMs(500)).toBe(RANK_STAGGER_MAX_MS)
  })
})

describe("rankPop", () => {
  test("🔴 the animation NEVER starts from an invisible value", () => {
    // Measured twice in the Browser pane: a SMIL animation that has begun pins its attribute to
    // values[0], and a hidden tab never advances the timeline. So values[0] IS what a stalled
    // clock renders — and if it were an opacity of 0, the rank badge would not exist.
    for (const rank of [1, 2, 7, 99]) {
      expect(Number(rankPop(rank).values.split(";")[0])).toBeGreaterThan(0)
    }
  })

  test("the delay lives in keyTimes, so the ring never settles and then jumps back out", () => {
    expect(rankPop(1).keyTimes.split(";")[1]).toBe("0.0000")
    expect(Number(rankPop(4).keyTimes.split(";")[1])).toBeGreaterThan(0)
    // ...and every pop ends at the resting radius, whatever its delay
    for (const rank of [1, 4, 40]) expect(rankPop(rank).values.endsWith(String(RANK_RING_R))).toBe(true)
  })
})
