import { describe, expect, test } from "bun:test"
import {
  chatFor,
  chatToClear,
  formatRate,
  formatTokensPerSecond,
  liveFor,
  ratePerMinute,
  rosterState,
  rosterTask,
  terminalAttention,
  threadRate,
  threadOf,
  workersOf,
  type SessionLike,
} from "./roster-live"

const session = (over: Partial<SessionLike> & { id: string }): SessionLike => ({
  time: { created: 1 },
  ...over,
})

const tokens = (output: number) => ({ input: 0, output, reasoning: 0, cache: { read: 0, write: 0 } })

describe("the ONE chat a colleague has", () => {
  test("is the live root chat bound to that agent", () => {
    const sessions = [
      session({ id: "a", agent: "theron", time: { created: 1 } }),
      session({ id: "b", agent: "kallias", time: { created: 2 } }),
    ]
    expect(chatFor(sessions, "theron")?.id).toBe("a")
    expect(chatFor(sessions, "nobody")).toBeUndefined()
  })

  test("a sub-agent thread is never mistaken for the colleague's own chat", () => {
    // The nameless staff carry their officer's agent id through the config walk, so a child would
    // otherwise look exactly like a second chat for the same colleague.
    const sessions = [
      session({ id: "root", agent: "theron", time: { created: 1 } }),
      session({ id: "child", parentID: "root", agent: "theron", time: { created: 9 } }),
    ]
    expect(chatFor(sessions, "theron")?.id).toBe("root")
  })

  test("an ARCHIVED chat never wins, however recent", () => {
    // "Clear chat" archives the old conversation and starts fresh. Preferring recency alone would
    // hand the colleague straight back the chat the user just cleared.
    const sessions = [
      session({ id: "old", agent: "theron", time: { created: 1, updated: 99, archived: 100 } }),
      session({ id: "fresh", agent: "theron", time: { created: 50 } }),
    ]
    expect(chatFor(sessions, "theron")?.id).toBe("fresh")
  })

  test("with two live chats the most recently touched wins, deterministically", () => {
    const sessions = [
      session({ id: "stale", agent: "theron", time: { created: 1, updated: 2 } }),
      session({ id: "recent", agent: "theron", time: { created: 1, updated: 8 } }),
    ]
    expect(chatFor(sessions, "theron")?.id).toBe("recent")
    // Order of the input must not change the answer.
    expect(chatFor([...sessions].reverse(), "theron")?.id).toBe("recent")
  })
})

/**
 * WHICH transcript "Clear chat" acts on.
 *
 * 🔴 Reproduced from the owner's prod instance, 2026-09-03: colleague `umbris`, four root chats, all
 * four archived, the newest of them in the open tab with 19 messages. `chatFor` answers `undefined`
 * for that state — correctly, it is asked a different question — and Clear told the user there was
 * nothing to clear while they were looking at the thing they had asked it to clear.
 */
describe("the chat Clear acts on", () => {
  const umbris = [
    session({ id: "one", agent: "umbris", time: { created: 1, updated: 10, archived: 20 } }),
    session({ id: "two", agent: "umbris", time: { created: 2, updated: 30, archived: 40 } }),
    session({ id: "three", agent: "umbris", time: { created: 3, updated: 25, archived: 50 } }),
  ]

  test("the OWNER'S CASE: every chat archived, so the newest archived one is what Clear takes", () => {
    // Without this the toast said "There is no chat to clear yet" and nothing happened.
    expect(chatFor(umbris, "umbris")).toBeUndefined()
    expect(chatToClear(umbris, "umbris", "/")?.id).toBe("two")
  })

  test("the chat the ROUTE names wins, even when a live chat exists elsewhere", () => {
    // The user is looking at it, so it is the one they mean.
    const sessions = [...umbris, session({ id: "live", agent: "umbris", time: { created: 9, updated: 9 } })]
    expect(chatToClear(sessions, "umbris", "/session/local/three")?.id).toBe("three")
    expect(chatToClear(sessions, "umbris", "/")?.id).toBe("live")
  })

  test("a route naming ANOTHER colleague's chat does not drag it in", () => {
    const sessions = [...umbris, session({ id: "elsewhere", agent: "theron", time: { created: 9 } })]
    expect(chatToClear(sessions, "umbris", "/session/local/elsewhere")?.id).toBe("two")
  })

  test("it matches a whole path SEGMENT, never a substring of one", () => {
    // Ids are opaque, so a substring match would let one chat's id select another's. The two answers
    // have to differ for this to prove anything: `ses_ab` is a substring of the routed id and is the
    // OLDER archived row, so a substring match returns it and a segment match returns `ses_zz`.
    const sessions = [
      session({ id: "ses_ab", agent: "umbris", time: { created: 1, updated: 1, archived: 2 } }),
      session({ id: "ses_zz", agent: "umbris", time: { created: 3, updated: 9, archived: 4 } }),
    ]
    expect(chatToClear(sessions, "umbris", "/session/local/ses_abcdef")?.id).toBe("ses_zz")
    // And the real id in the route still selects its own row.
    expect(chatToClear(sessions, "umbris", "/session/local/ses_ab")?.id).toBe("ses_ab")
  })

  test("a sub-agent thread is never the thing cleared, even when the route names it", () => {
    const sessions = [
      session({ id: "root", agent: "umbris", time: { created: 1 } }),
      session({ id: "child", parentID: "root", agent: "umbris", time: { created: 5 } }),
    ]
    expect(chatToClear(sessions, "umbris", "/session/local/child")?.id).toBe("root")
  })

  test("a colleague that has never had a chat still reports nothing to clear", () => {
    expect(chatToClear(umbris, "nobody", "/")).toBeUndefined()
    expect(chatToClear([], "umbris", "/session/local/anything")).toBeUndefined()
  })
})

describe("what the colleague has spent", () => {
  test("rolls up its sub-agent threads — staff spend on their officer's behalf", () => {
    const sessions = [
      session({ id: "root", agent: "theron", tokens: tokens(100) }),
      session({ id: "child", parentID: "root", tokens: tokens(30) }),
      session({ id: "grandchild", parentID: "child", tokens: tokens(7) }),
      session({ id: "elsewhere", agent: "kallias", tokens: tokens(1000) }),
    ]
    expect(liveFor(sessions, "theron").tokens.generated).toBe(137)
  })

  test("a cycle in the parent chain terminates instead of hanging the first screen", () => {
    const sessions = [
      session({ id: "root", agent: "theron", parentID: "loop", tokens: tokens(1) }),
      session({ id: "loop", parentID: "root", tokens: tokens(1) }),
    ]
    // `root` is not a root session here, so the colleague has no chat — and the walk still returns.
    expect(threadOf(sessions, "root").map((item) => item.id)).toEqual(["root", "loop"])
  })
})

describe("an officer's live worker tree", () => {
  const sessions = [
    session({ id: "root", agent: "theron" }),
    session({ id: "worker", parentID: "root", type: "sub-agent", title: "Inspect logs" }),
    session({ id: "nested", parentID: "worker", type: "sub-agent" }),
    session({ id: "fork", parentID: "root", type: "interactive" }),
    session({ id: "elsewhere", agent: "kallias" }),
  ]

  test("lists only spawned workers, transitively", () => {
    expect(workersOf(sessions, "root").map((row) => row.id)).toEqual(["worker", "nested"])
  })

  test("removes settled, exited, failed, and interrupted branches from the current worker set", () => {
    const state = new Map([["worker", { execution: "interrupted" as const }]])
    expect(workersOf(sessions, "root", (id) => state.get(id) ?? {}).map((row) => row.id)).toEqual([])
    expect(
      workersOf(sessions, "root", (id) => (id === "nested" ? { execution: "settled" as const } : {})).map(
        (row) => row.id,
      ),
    ).toEqual(["worker"])
    expect(
      workersOf(sessions, "root", (id) =>
        id === "worker" ? { execution: "paused" as const } : { lifecycle: "idle" },
      ).map((row) => row.id),
    ).toEqual(["worker", "nested"])
  })

  test("adds every thread's current generated-token rate", () => {
    const rates: Record<string, number> = { root: 2, worker: 3, nested: 4, fork: 5, elsewhere: 99 }
    expect(threadRate(sessions, "root", (id) => rates[id])).toBe(14)
    expect(threadRate(sessions, "missing", (id) => rates[id])).toBeUndefined()
  })
})

describe("what a colleague with no chat yet reports", () => {
  test("nothing invented — no session, no title, zero spend", () => {
    // A brand-new hire has done nothing. Showing a zero rate or an empty title as if it were a
    // measurement is how a roster starts describing work that never happened.
    const live = liveFor([], "theron")
    expect(live).toMatchObject({ sessionID: undefined, title: undefined, updatedAt: undefined })
    expect(live.tokens.generated).toBe(0)
  })

  test("a chat with no title yet reports no title, not an empty string", () => {
    const live = liveFor([session({ id: "a", agent: "theron", title: "   " })], "theron")
    expect(live.title).toBeUndefined()
  })

  test("the auto-generated title is reused verbatim", () => {
    const live = liveFor([session({ id: "a", agent: "theron", title: "Glyph description request" })], "theron")
    expect(live.title).toBe("Glyph description request")
  })
})

describe("the rate on the row", () => {
  const now = 1_000 * 60_000 // minute 1000

  test("averages over the WINDOW, not over the minutes that happen to have rows", () => {
    // 600 tokens in one minute of the last ten is 60/min of sustained work, not 600. Dividing by
    // rows present would answer "how fast while working", which flatters every colleague to roughly
    // the same number and tells the user nothing about who is busy.
    expect(ratePerMinute([{ minute: 998, generated: 600 }], { now, window: 10 })).toBe(60)
  })

  test("sums every minute inside the window and ignores what falls outside it", () => {
    const series = [
      { minute: 1000, generated: 100 },
      { minute: 995, generated: 100 },
      { minute: 980, generated: 9999 }, // older than the window
    ]
    expect(ratePerMinute(series, { now, window: 10 })).toBe(20)
  })

  test("a quiet window is UNDEFINED, never 0", () => {
    // The series is sparse: no rows means "not working". A "0/min" badge reads as a measurement of
    // the colleague's speed, when what it measures is our decision to render it.
    expect(ratePerMinute([], { now, window: 10 })).toBeUndefined()
    expect(ratePerMinute([{ minute: 900, generated: 500 }], { now, window: 10 })).toBeUndefined()
  })

  test("a future row cannot inflate the rate", () => {
    // Clock skew between the writer and this reader is real; a bucket from the future would
    // otherwise be counted in a window it does not belong to.
    expect(ratePerMinute([{ minute: 1005, generated: 500 }], { now, window: 10 })).toBeUndefined()
  })
})

describe("printing the rate", () => {
  test("a rate below one per minute is `<1`, NEVER `0`", () => {
    // The trap this exists for: a real turn produced 2 tokens over a ten-minute window — 0.2/min —
    // and rounding printed the exact "0/min" badge the sparse series refuses to store. Measured on a
    // live turn, 2026-08-21.
    expect(formatRate(0.2)).toBe("<1")
    expect(formatRate(0.9)).toBe("<1")
  })

  test("small rates keep a decimal, larger ones round", () => {
    expect(formatRate(1)).toBe("1")
    expect(formatRate(2.5)).toBe("2.5")
    expect(formatRate(42.4)).toBe("42")
  })
})

describe("rosterTask", () => {
  test("🔴 the colleague's STATUS component is what the row shows", () => {
    /**
     * Owner, 2026-08-28: sessions are components and there are no session titles; the instance
     * derives a task line from the colleague's newest work every few hours. That line is what a
     * contacts row is for — a title was written once, from the first thing said, and never revisited.
     *
     * A/B: read `title` first and this returns the stale chat name instead.
     */
    expect(
      rosterTask({
        status: { task: "reviewing the P2P handshake" },
        title: "an old chat name",
        colleagueName: "Umbris",
      }),
    ).toBe("reviewing the P2P handshake")
  })

  test("🔴 the component wins even when it looks like the colleague's name", () => {
    // The echo guard applies to TITLES, which are seeded with the colleague's own name by
    // `startChat`. A status line is derived from what the colleague DID, so if it happens to read
    // like a name that is what the work is called — suppressing it would hide a real answer.
    expect(rosterTask({ status: { task: "Umbris" }, title: undefined, colleagueName: "Umbris" })).toBe("Umbris")
  })

  test("an empty or blank status falls through to the title", () => {
    // A status line appears only after the first sweep, so an instance running five minutes has
    // none — a roster that showed nothing until then would look broken on the day this shipped.
    expect(rosterTask({ status: { task: "   " }, title: "Port the DHT", colleagueName: "Umbris" })).toBe("Port the DHT")
    expect(rosterTask({ status: undefined, title: "Port the DHT", colleagueName: "Umbris" })).toBe("Port the DHT")
  })

  test("a chat titled after the colleague is NOT a task", () => {
    expect(rosterTask({ status: undefined, title: "Nova", colleagueName: "Nova" })).toBeUndefined()
    expect(rosterTask({ status: undefined, title: "  umbris ", colleagueName: "Umbris" })).toBeUndefined()
  })

  test("a real task survives", () => {
    expect(rosterTask({ status: undefined, title: "Port the DHT to TCP", colleagueName: "Umbris" })).toBe(
      "Port the DHT to TCP",
    )
  })

  test("no title and an empty title both mean no task", () => {
    expect(rosterTask({ status: undefined, title: undefined, colleagueName: "Nova" })).toBeUndefined()
    expect(rosterTask({ status: undefined, title: "   ", colleagueName: "Nova" })).toBeUndefined()
  })
})

describe("formatTokensPerSecond", () => {
  test("a silent window renders nothing, never a zero", () => {
    expect(formatTokensPerSecond(undefined)).toBeUndefined()
    expect(formatTokensPerSecond(0)).toBeUndefined()
  })

  test("converts the per-minute series rather than measuring twice", () => {
    expect(formatTokensPerSecond(600)).toBe("10")
    expect(formatTokensPerSecond(90)).toBe("1.5")
    expect(formatTokensPerSecond(3)).toBe("<0.1")
  })
})

describe("rosterState — the scheduler's answer, not a phase inspector", () => {
  test("running means Working", () => {
    expect(rosterState({ status: { type: "busy" }, working: true })).toBe("working")
  })

  test("not running means Idle", () => {
    expect(rosterState({ status: { type: "idle" }, working: false })).toBe("idle")
    expect(rosterState({ status: undefined, working: false })).toBe("idle")
  })

  test("a retrying provider is an ERROR, not an idle colleague", () => {
    // The reachability case: nothing can run, so "Idle" would read as a healthy pause.
    expect(rosterState({ status: { type: "retry" }, working: false })).toBe("error")
    expect(rosterState({ status: { type: "retry" }, working: true })).toBe("error")
  })

  test("a terminal recovery outcome is Paused, never healthy Idle", () => {
    for (const state of ["paused", "failed", "interrupted"] as const) {
      expect(rosterState({ status: { type: "idle" }, working: false, execution: { state } })).toBe("paused")
    }
  })

  test("a new live run outranks the previous attempt's paused outcome", () => {
    expect(rosterState({ status: { type: "busy" }, working: true, execution: { state: "paused" } })).toBe("working")
  })
})

describe("terminal attention", () => {
  test("a settled idle root produces one completion indication", () => {
    expect(terminalAttention({ lifecycle: "idle", execution: "settled" })).toBe("complete")
  })

  test("paused, failed, and interrupted roots produce recovery attention", () => {
    for (const execution of ["paused", "failed", "interrupted"] as const) {
      expect(terminalAttention({ lifecycle: "idle", execution })).toBe("recovery")
    }
  })

  test("an early idle does not claim a busy/recovering lease completed", () => {
    expect(terminalAttention({ lifecycle: "idle", execution: "busy" })).toBeUndefined()
    expect(terminalAttention({ lifecycle: "idle", execution: "recovering" })).toBeUndefined()
    expect(terminalAttention({ lifecycle: "busy", execution: "settled" })).toBeUndefined()
  })

  test("an exited lifecycle is completion because it follows the durable result event", () => {
    expect(terminalAttention({ lifecycle: "exited", execution: "busy" })).toBe("complete")
  })
})
