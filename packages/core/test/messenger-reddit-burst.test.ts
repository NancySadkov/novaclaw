import { describe, expect, test } from "bun:test"
import { Duration, Effect, Stream } from "effect"
import type { Messenger } from "@novaclaw/schema/messenger"
import { RedditDriver } from "@novaclaw/core/messenger/driver/reddit"
import type { InboundEvent } from "@novaclaw/core/messenger/driver"
import { it } from "./lib/effect"

// A burst LARGER THAN ONE PAGE between two polls. Asserting on a small burst proves nothing here:
// the loss only begins at the page boundary, where `before=<anchor>` returns the NEWEST 100 items
// newer than the anchor and the old code then anchored to the newest of them — stepping over
// everything in between, which no later poll ever asks for again.

const ACCOUNT = {
  id: "msa_rd" as never,
  driverID: "reddit",
  label: "reddit",
  enabled: true,
  settings: { subreddit: "novaclaw", clientId: "cid", username: "novaclaw-bot" },
} as never as Messenger.AccountInfo

interface Thing {
  readonly kind: string
  readonly data: Record<string, unknown>
}

const comment = (n: number): Thing => ({
  kind: "t1",
  data: {
    name: `t1_c${n}`,
    id: `c${n}`,
    author: "erin",
    body: `comment ${n}`,
    link_id: "t3_aaa",
    link_title: "Crash on save",
    parent_id: "t3_aaa",
    created_utc: 1_700_000_000 + n,
  },
})

/** 251 comments, newest first — `t1_c250` … `t1_c0`. The seed (`t1_c0`) is what the first poll
 *  anchors on; the other 250 all land in the window between poll one and poll two. */
const BURST = 250
const ALL = Array.from({ length: BURST + 1 }, (_, index) => comment(BURST - index))

const makeFakeReddit = (options?: { readonly listing?: readonly Thing[]; readonly burstAfterFirstPoll?: boolean }) => {
  const state = { commentCalls: [] as string[], listing: options?.listing ?? ALL.slice(BURST) }

  /** Reddit's listing semantics, as the sweep evidence describes them: newest-first from the top,
   *  `before` bounded by the anchor (so a flood hands back the NEWEST page, not the adjacent one),
   *  `after` walking backwards into older items. */
  const page = (url: string): Thing[] => {
    const params = new URL(url).searchParams
    const limit = Number(params.get("limit") ?? "100")
    const list = state.listing as readonly Thing[]
    const indexOf = (name: string) => list.findIndex((thing) => thing.data["name"] === name)
    const after = params.get("after")
    if (after !== null) {
      const at = indexOf(after)
      return at === -1 ? [] : list.slice(at + 1, at + 1 + limit)
    }
    const before = params.get("before")
    if (before !== null) {
      const at = indexOf(before)
      return at <= 0 ? [] : list.slice(0, Math.min(limit, at))
    }
    return list.slice(0, limit)
  }

  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
    void init
    if (url.includes("/api/v1/access_token")) return json({ access_token: "at-1", expires_in: 3600 })
    if (url.includes("/api/v1/me")) return json({ name: "novaclaw-bot" })
    if (url.includes("/r/novaclaw/comments")) {
      const body = json({ data: { children: page(url) } })
      state.commentCalls.push(url)
      // Everything arrives between the first poll and the second — the window the cursor has to
      // cover, and the one the old cursor jumped over.
      if (options?.burstAfterFirstPoll === true && state.commentCalls.length === 1) state.listing = ALL
      return body
    }
    return json({ data: { children: [] } }) // /new and the modqueue stay quiet
  }
  return { state, fetchImpl }
}

const loopback = (() =>
  Effect.succeed({ redirectUri: "", waitForCode: Promise.resolve("") })) as never

const driverFor = (fake: ReturnType<typeof makeFakeReddit>) =>
  RedditDriver.make(fake.fetchImpl, loopback, () => Effect.void, { pollIntervalMs: 20, version: "9.9.9" })

const connect = (fake: ReturnType<typeof makeFakeReddit>) =>
  driverFor(fake).connect({
    account: ACCOUNT,
    secret: JSON.stringify({ refreshToken: "rt-1" }),
    cursor: { get: () => Effect.succeed(undefined), set: () => Effect.void },
  })

describe("RedditDriver listing cursor", () => {
  it.live("a burst larger than one page is retrieved WHOLE, not skipped past", () =>
    Effect.gen(function* () {
      const fake = makeFakeReddit({ burstAfterFirstPoll: true })
      const received: InboundEvent[] = []
      yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(fake)
          yield* connection.inbound.pipe(
            Stream.take(BURST + 1),
            Stream.runForEach((event) => Effect.sync(() => received.push(event))),
          )
        }),
        // Bounded so the FAILURE is an assertion on the count, not a hung test: without the
        // catch-up the stream simply stops at 101 and never reaches the take.
      ).pipe(Effect.timeout(Duration.seconds(8)), Effect.catchCause(() => Effect.void))

      const ids = received.flatMap((event) => (event.kind === "message" ? [event.messageID] : []))
      expect(ids).toHaveLength(BURST + 1)
      expect(new Set(ids).size).toBe(BURST + 1) // fetched twice would be a different bug
      for (let n = 0; n <= BURST; n += 1) expect(ids).toContain(`t1_c${n}`)
      // Chronological within the catch-up: the oldest of the burst is delivered first.
      expect(ids.indexOf("t1_c1")).toBeLessThan(ids.indexOf("t1_c250"))
      // Three requests covered the 250-item window (100 + 100 + 50) plus the first poll's one —
      // the walk stops when it meets what we already hold, it does not run to the page budget.
      expect(fake.state.commentCalls).toHaveLength(4)
    }),
  )

  it.live("CONTROL: an ordinary poll still costs exactly one request per listing", () =>
    Effect.gen(function* () {
      const fake = makeFakeReddit({ listing: ALL.slice(BURST - 2) }) // three items, well inside one page
      const received: InboundEvent[] = []
      yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(fake)
          yield* connection.inbound.pipe(
            Stream.take(3),
            Stream.runForEach((event) => Effect.sync(() => received.push(event))),
          )
        }),
      ).pipe(Effect.timeout(Duration.seconds(8)), Effect.catchCause(() => Effect.void))
      expect(received).toHaveLength(3)
      // One page in, one request out: a short page ends the walk before it starts.
      expect(fake.state.commentCalls).toHaveLength(1)
    }),
  )

  // A durable "I handled this", written by a caller that cannot see whether the item reached
  // anything, is a record of work nobody did. The crash is SIMULATED, not asserted about: the
  // durable write reaches the store and then never returns, and what the page had already handed
  // over by that moment is what the assertion reads.
  it.live("a crash AT the durable write loses nothing — the page is handed over first", () =>
    Effect.gen(function* () {
      const posts: Thing[] = [3, 2, 1].map((n) => ({
        kind: "t3",
        data: { name: `t3_p${n}`, id: `p${n}`, author: "dave", title: `post ${n}`, created_utc: 1700 + n },
      }))
      const anchors: (string | null)[] = []
      const durable = { value: undefined as unknown, writes: 0 }
      const fetchImpl = async (url: string): Promise<Response> => {
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
        if (url.includes("/api/v1/access_token")) return json({ access_token: "at-1", expires_in: 3600 })
        if (url.includes("/api/v1/me")) return json({ name: "novaclaw-bot" })
        if (!url.includes("/r/novaclaw/new")) return json({ data: { children: [] } })
        const before = new URL(url).searchParams.get("before")
        anchors.push(before)
        const at = posts.findIndex((thing) => thing.data["name"] === before)
        return json({ data: { children: before === null ? posts : at <= 0 ? [] : posts.slice(0, at) } })
      }
      const driver = RedditDriver.make(fetchImpl, loopback, () => Effect.void, {
        pollIntervalMs: 20,
        version: "9.9.9",
      })
      const secret = JSON.stringify({ refreshToken: "rt-1" })
      const received: InboundEvent[] = []
      const waitFor = (ready: () => boolean) =>
        Effect.gen(function* () {
          for (let round = 0; round < 100; round += 1) {
            if (ready()) return
            yield* Effect.sleep(Duration.millis(10))
          }
        })

      yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.connect({
            account: ACCOUNT,
            secret,
            cursor: {
              get: () => Effect.sync(() => durable.value),
              // The power cut: the store takes the write, and the driver never comes back from it.
              set: (value) =>
                Effect.sync(() => {
                  durable.value = value
                  durable.writes += 1
                }).pipe(Effect.flatMap(() => Effect.never)),
            },
          })
          yield* Effect.forkScoped(
            connection.inbound.pipe(Stream.runForEach((event) => Effect.sync(() => received.push(event)))),
          )
          yield* waitFor(() => durable.writes >= 1)
          yield* waitFor(() => received.length >= 3)
        }),
      ).pipe(Effect.timeout(Duration.seconds(8)), Effect.catchCause(() => Effect.void))

      expect(durable.writes).toBe(1)
      // Everything on the page reached the consumer BEFORE the anchor was durably stepped past it.
      expect(received.flatMap((event) => (event.kind === "message" ? [event.messageID] : []))).toEqual([
        "t3_p1",
        "t3_p2",
        "t3_p3",
      ])

      // And the restart: a fresh connection reads the anchor the crashed one left behind and does
      // not replay the page — the anchor is where it is BECAUSE the hand-over happened.
      const restarted: InboundEvent[] = []
      yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.connect({
            account: ACCOUNT,
            secret,
            cursor: { get: () => Effect.sync(() => durable.value), set: () => Effect.void },
          })
          yield* Effect.forkScoped(
            connection.inbound.pipe(Stream.runForEach((event) => Effect.sync(() => restarted.push(event)))),
          )
          yield* waitFor(() => anchors.includes("t3_p3"))
        }),
      ).pipe(Effect.timeout(Duration.seconds(8)), Effect.catchCause(() => Effect.void))
      expect(anchors).toContain("t3_p3") // it resumed from the crashed run's anchor…
      expect(restarted).toHaveLength(0) // …and nothing was delivered twice
    }),
  )

  test("the seen-set keeps the NEWEST of a burst, so an anchor drop cannot replay it", () => {
    const names = Array.from({ length: 500 }, (_, index) => `t1_n${500 - index}`) // newest first
    const advanced = RedditDriver.advanceCursor({ seen: [] }, names)
    expect(advanced.fresh).toHaveLength(500)
    expect(advanced.cursor.before).toBe("t1_n500")
    expect(advanced.cursor.seen).toContain("t1_n500") // the newest is remembered…
    expect(advanced.cursor.seen).not.toContain("t1_n1") // …and the far tail is what ages out
  })
})
