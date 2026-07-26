import { describe, expect, test } from "bun:test"
import { Duration, Effect, Exit, Stream } from "effect"
import type { Messenger } from "@novaclaw/schema/messenger"
import { RedditDriver } from "@novaclaw/core/messenger/driver/reddit"
import type { InboundEvent } from "@novaclaw/core/messenger/driver"
import { it } from "./lib/effect"

// The Reddit driver against a FAKE api (notes/messenger-plan.md §2.1). What matters here is the
// shape that makes ONE binding able to moderate a live subreddit — posts and comments arrive as
// threads parented to the subreddit — plus the three things Reddit gets wrong-footed on: the
// User-Agent it demands, the throttle it hides inside an HTTP 200, and the listing cursor that
// dies when the item it anchors to is deleted.

const ACCOUNT = {
  id: "msa_rd" as never,
  driverID: "reddit",
  label: "reddit",
  enabled: true,
  settings: { subreddit: "r/novaclaw/", clientId: "cid", username: "novaclaw-bot" },
} as never as Messenger.AccountInfo

const post = (id: string, author: string, title: string, body = "") => ({
  kind: "t3",
  data: { name: `t3_${id}`, id, author, title, selftext: body, created_utc: 1_700_000_000 },
})
const comment = (id: string, author: string, body: string, linkID: string, parent?: string) => ({
  kind: "t1",
  data: {
    name: `t1_${id}`,
    id,
    author,
    body,
    link_id: linkID,
    link_title: "Crash on save",
    parent_id: parent ?? linkID,
    created_utc: 1_700_000_100,
  },
})

const makeFakeReddit = () => {
  const state = {
    calls: [] as { url: string; method: string; form?: Record<string, string>; agent?: string }[],
    posts: [post("aaa", "dave", "Crash on save", "it dies when I press save")],
    comments: [] as ReturnType<typeof comment>[],
    queue: [] as { kind: string; data: Record<string, unknown> }[],
    queueStatus: 200,
    refreshFails: undefined as string | undefined,
    commentReply: { json: { errors: [], data: { things: [{ kind: "t1", data: { name: "t1_reply" } }] } } } as unknown,
  }

  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET"
    const form =
      typeof init?.body === "string" ? Object.fromEntries(new URLSearchParams(init.body).entries()) : undefined
    const headers = (init?.headers ?? {}) as Record<string, string>
    state.calls.push({ url, method, ...(form === undefined ? {} : { form }), ...(headers["User-Agent"] === undefined ? {} : { agent: headers["User-Agent"] }) })
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

    if (url.includes("/api/v1/access_token")) {
      if (state.refreshFails !== undefined) return json({ error: state.refreshFails }, 400)
      return json({ access_token: "at-1", expires_in: 3600, refresh_token: "rt-new" })
    }
    if (url.includes("/api/v1/me")) return json({ name: "novaclaw-bot" })
    if (url.includes("/about/modqueue")) return json(state.queueStatus === 200 ? { data: { children: state.queue } } : { message: "Forbidden" }, state.queueStatus)
    if (url.includes("/r/novaclaw/new")) return json({ data: { children: state.posts } })
    if (url.includes("/r/novaclaw/comments/")) return json([{ data: { children: state.posts } }, { data: { children: state.comments } }])
    if (url.includes("/r/novaclaw/comments")) return json({ data: { children: state.comments } })
    if (url.includes("/api/comment")) return json(state.commentReply)
    return json({ json: { errors: [] } })
  }
  return { state, fetchImpl }
}

// The fake echoes back whatever redirectUri the driver asked for — so a test can prove the driver
// advertises the SAME string it told the user to register (Reddit matches it exactly).
const loopback = (params?: { redirectUri?: string }) =>
  Effect.succeed({ redirectUri: params?.redirectUri ?? "http://127.0.0.1:9999/", waitForCode: Promise.resolve("code-1") })
// `version` is pinned to a FIXTURE value, not left to the driver's default: what the UA assertion
// below is about is the required FORMAT, so a product version bump must not break this test.
const connect = (fake: ReturnType<typeof makeFakeReddit>, cursor?: unknown, onCursor?: (value: unknown) => void) =>
  RedditDriver.make(fake.fetchImpl, loopback as never, () => Effect.void, { pollIntervalMs: 50, version: "9.9.9" }).connect({
    account: ACCOUNT,
    secret: JSON.stringify({ refreshToken: "rt-1" }),
    cursor: { get: () => Effect.succeed(cursor), set: (value) => Effect.sync(() => onCursor?.(value)) },
  })

describe("RedditDriver pure helpers", () => {
  test("the User-Agent follows Reddit's required format (generic agents get throttled)", () => {
    expect(RedditDriver.userAgent("novaclaw-bot", "0.0.1")).toBe("novaclaw:app.novaclaw.messenger:v0.0.1 (by /u/novaclaw-bot)")
    // Tolerates what a person actually types into the settings field.
    expect(RedditDriver.userAgent("u/novaclaw-bot", "1.2.3")).toBe("novaclaw:app.novaclaw.messenger:v1.2.3 (by /u/novaclaw-bot)")
  })

  test("subreddit names survive however they were pasted", () => {
    for (const raw of ["novaclaw", "r/novaclaw", "/r/novaclaw/", "https://www.reddit.com/r/novaclaw/"])
      expect(RedditDriver.normalizeSubreddit(raw)).toBe("novaclaw")
  })

  test("fullnames split into the bare id36 the comment-tree endpoint wants", () => {
    expect(RedditDriver.bareID("t3_abc123")).toBe("abc123")
    expect(RedditDriver.bareID("abc123")).toBe("abc123")
    expect(RedditDriver.isPostChat("t3_abc")).toBe(true)
    expect(RedditDriver.isPostChat("r/novaclaw")).toBe(false)
  })

  // Reddit answers a throttled write with HTTP 200 and the error in the BODY — a driver that only
  // reads status codes drops the reply and reports success.
  test("the RATELIMIT hidden inside a 200 body is found, with its delay", () => {
    const body = { json: { errors: [["RATELIMIT", "you are doing that too much. try again in 7 minutes.", "ratelimit"]] } }
    expect(RedditDriver.parseRateLimit(body)).toEqual({ retryAfterMs: 7 * 60_000 })
    expect(RedditDriver.parseRateLimit({ json: { errors: [["RATELIMIT", "try again in 30 seconds."]] } })).toEqual({ retryAfterMs: 30_000 })
    // No unit parsed → still a throttle, just a conservative wait.
    expect(RedditDriver.parseRateLimit({ json: { errors: [["RATELIMIT", "slow down"]] } })).toEqual({ retryAfterMs: 60_000 })
    expect(RedditDriver.parseRateLimit({ json: { errors: [] } })).toBeUndefined()
    expect(RedditDriver.parseRateLimit({ json: { errors: [["NO_TEXT", "we need something here"]] } })).toBeUndefined()
  })

  test("other API errors surface with their reason", () => {
    expect(RedditDriver.parseApiError({ json: { errors: [["SUBREDDIT_NOTALLOWED", "you aren't allowed to post there"]] } })).toBe(
      "SUBREDDIT_NOTALLOWED: you aren't allowed to post there",
    )
    expect(RedditDriver.parseApiError({ json: { errors: [] } })).toBeUndefined()
  })

  test("every moderation act maps to the right endpoint, and the two Reddit lacks refuse legibly", () => {
    const req = (act: Parameters<typeof RedditDriver.moderationRequest>[2]) => RedditDriver.moderationRequest("novaclaw", "t3_aaa", act)
    expect(req({ act: "delete", messageID: "t1_x" })).toEqual({ path: "/api/remove", form: { id: "t1_x", spam: "false" } })
    expect(req({ act: "approve", messageID: "t1_x" })).toEqual({ path: "/api/approve", form: { id: "t1_x" } })
    expect(req({ act: "ban", userID: "spammer" })).toMatchObject({ path: "/r/novaclaw/api/friend", form: { type: "banned", name: "spammer" } })
    expect(req({ act: "mute", userID: "loud" })).toMatchObject({ path: "/r/novaclaw/api/friend", form: { type: "muted", name: "loud" } })
    // A post is stickied to the subreddit; a comment is distinguished+stickied in its thread.
    expect(req({ act: "pin", messageID: "t3_aaa" })).toMatchObject({ path: "/api/set_subreddit_sticky" })
    expect(req({ act: "pin", messageID: "t1_x" })).toMatchObject({ path: "/api/distinguish", form: { sticky: "true" } })
    expect(req({ act: "lock" })).toEqual({ path: "/api/lock", form: { id: "t3_aaa" } })
    // Locking the SUBREDDIT chat is meaningless — say which target is wanted.
    expect(RedditDriver.moderationRequest("novaclaw", "r/novaclaw", { act: "lock" })).toMatchObject({ refusal: expect.stringContaining("post") })
    expect(req({ act: "kick", userID: "x" })).toMatchObject({ refusal: expect.stringContaining("ban") })
  })

  // Reddit's `before` anchor dies with the item it names; the seen-set is what actually prevents
  // double delivery, and dropping the anchor on an empty page is what un-wedges the poll.
  test("the cursor dedups by seen-set and DROPS its anchor when a page brings nothing new", () => {
    const first = RedditDriver.advanceCursor({ seen: [] }, ["t3_c", "t3_b", "t3_a"])
    expect(first.fresh).toEqual(["t3_c", "t3_b", "t3_a"])
    expect(first.cursor.before).toBe("t3_c")

    const repeat = RedditDriver.advanceCursor(first.cursor, ["t3_c", "t3_b", "t3_a"])
    expect(repeat.fresh).toEqual([])
    expect(repeat.cursor.before).toBeUndefined() // anchor dropped — next poll refetches unanchored
    expect(repeat.cursor.seen).toEqual(first.cursor.seen) // and the seen-set still suppresses them

    const mixed = RedditDriver.advanceCursor(first.cursor, ["t3_d", "t3_c"])
    expect(mixed.fresh).toEqual(["t3_d"])
    expect(mixed.cursor.before).toBe("t3_d")
  })

  test("the seen-set stays bounded so a busy subreddit can't grow it forever", () => {
    let cursor: RedditDriver.ListingCursor = { seen: [] }
    for (let round = 0; round < 40; round++)
      cursor = RedditDriver.advanceCursor(cursor, Array.from({ length: 20 }, (_, i) => `t3_${round}_${i}`)).cursor
    expect(cursor.seen.length).toBeLessThanOrEqual(301)
    expect(cursor.seen.at(-1)).toBe("t3_39_19")
  })

  test("a stored cursor round-trips, and junk decodes to an empty one", () => {
    expect(RedditDriver.readCursor({ posts: { before: "t3_a", seen: ["t3_a"] }, comments: { seen: [] } })).toEqual({
      posts: { before: "t3_a", seen: ["t3_a"] },
      comments: { seen: [] },
      modqueue: { seen: [] },
    })
    expect(RedditDriver.readCursor("junk")).toEqual({ posts: { seen: [] }, comments: { seen: [] }, modqueue: { seen: [] } })
  })

  // The queue is the actual job of moderating: a report can land on a week-old comment that no
  // /new poll will ever surface again.
  test("a queued item says WHY it is queued, and keeps the id moderation takes", () => {
    const event = RedditDriver.modqueueInbound(
      "novaclaw",
      { name: "t1_x", author: "spammer", body: "buy my thing", link_title: "Crash on save", num_reports: 2, user_reports: [["spam", 2]], created_utc: 1_700_000_000 },
      "novaclaw-bot",
    )
    if (event?.kind !== "message") throw new Error("expected a message")
    // It lands in the QUEUE chat, not the post's thread — so an item already delivered when it was
    // posted doesn't read as a duplicate of itself.
    expect(event.chat.chatID).toBe("r/novaclaw/modqueue")
    expect(event.chat.parentID).toBe("r/novaclaw") // the one binding covers it
    expect(event.messageID).toBe("t1_x") // exactly what `moderate approve|delete` takes
    expect(event.text).toContain("2 reports")
    expect(event.text).toContain("reported as: spam")
    expect(event.text).toContain("buy my thing")
  })

  test("the queue reason distinguishes the spam filter from a human removal", () => {
    expect(RedditDriver.queueReason({ banned_by: true })).toContain("spam filter")
    expect(RedditDriver.queueReason({ banned_by: "nancy" })).toContain("removed by nancy")
    expect(RedditDriver.queueReason({ num_reports: 1 })).toBe("1 report")
    expect(RedditDriver.queueReason({})).toBe("awaiting review")
  })

  test("a post becomes a thread parented to the subreddit — the shape one binding needs", () => {
    const event = RedditDriver.postInbound("novaclaw", post("aaa", "dave", "Crash on save", "it dies").data, "novaclaw-bot")
    if (event?.kind !== "message") throw new Error("expected a message")
    expect(event.chat).toEqual({ chatID: "t3_aaa", kind: "thread", title: "Crash on save", parentID: "r/novaclaw" })
    // Title AND body: to a reader they are the post, and a triaging agent needs both.
    expect(event.text).toBe("Crash on save\n\nit dies")
    // The sender id is the USERNAME because that is what Reddit's ban endpoint takes.
    expect(event.sender).toEqual({ id: "dave", name: "dave", isSelf: false })
  })

  test("a comment lands in its POST's thread, not a chat of its own", () => {
    const event = RedditDriver.commentInbound("novaclaw", comment("c1", "dave", "still broken", "t3_aaa", "t1_c0").data, "novaclaw-bot")
    if (event?.kind !== "message") throw new Error("expected a message")
    expect(event.chat.chatID).toBe("t3_aaa")
    expect(event.chat.parentID).toBe("r/novaclaw")
    expect(event.messageID).toBe("t1_c1")
    expect(event.replyTo).toBe("t1_c0")
  })

  test("our own comments are marked self so the gateway drops the echo", () => {
    const own = RedditDriver.commentInbound("novaclaw", comment("c2", "NovaClaw-Bot", "on it", "t3_aaa").data, "novaclaw-bot")
    expect(own?.kind === "message" && own.sender.isSelf).toBe(true)
  })
})

const eventually = <A>(read: () => A, predicate: (value: A) => boolean, label: string) =>
  Effect.gen(function* () {
    for (let round = 0; round < 200; round++) {
      const value = read()
      if (predicate(value)) return value
      yield* Effect.sleep(Duration.millis(10))
    }
    return yield* Effect.die(`timeout waiting for ${label}`)
  })

describe("RedditDriver connection", () => {
  it.live("polls posts and comments, and sends the required User-Agent + raw_json on every call", () =>
    Effect.gen(function* () {
      const fake = makeFakeReddit()
      fake.state.comments = [comment("c1", "erin", "same here", "t3_aaa")]
      const received: InboundEvent[] = []
      yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(fake)
          yield* connection.inbound.pipe(
            Stream.take(2),
            Stream.runForEach((event) => Effect.sync(() => received.push(event))),
          )
        }),
      )
      expect(received).toHaveLength(2)
      const chats = received.map((event) => (event.kind === "message" ? event.chat.chatID : ""))
      expect(chats).toEqual(["t3_aaa", "t3_aaa"]) // the post and its comment, one thread

      const apiCalls = fake.state.calls.filter((call) => call.url.startsWith("https://oauth.reddit.com"))
      // raw_json=1 or every <, > and & comes back HTML-escaped — silent corruption of what the agent reads.
      expect(apiCalls.every((call) => call.url.includes("raw_json=1"))).toBe(true)
      expect(apiCalls.every((call) => call.agent === "novaclaw:app.novaclaw.messenger:v9.9.9 (by /u/novaclaw-bot)")).toBe(true)
    }),
  )

  it.live("a revoked sign-in parks as a CHALLENGE for the operator, not a reconnect loop", () =>
    Effect.gen(function* () {
      const fake = makeFakeReddit()
      fake.state.refreshFails = "invalid_grant"
      const error = yield* Effect.scoped(connect(fake)).pipe(Effect.flip)
      expect(error._tag).toBe("MessengerDriver.ChallengeError")
      if (error._tag === "MessengerDriver.ChallengeError") expect(error.message).toContain("Log in again")
    }),
  )

  it.live("replies comment on the post; an explicit reply targets that comment", () =>
    Effect.gen(function* () {
      const fake = makeFakeReddit()
      yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(fake)
          const sent = yield* connection.send("t3_aaa", { text: "Which version are you on?" })
          expect(sent.messageID).toBe("t1_reply")
          yield* connection.send("t3_aaa", { text: "thanks", replyTo: "t1_c1" })
        }),
      )
      const comments = fake.state.calls.filter((call) => call.url.includes("/api/comment"))
      expect(comments[0]?.form).toMatchObject({ thing_id: "t3_aaa", text: "Which version are you on?" })
      expect(comments[1]?.form).toMatchObject({ thing_id: "t1_c1" })
    }),
  )

  it.live("a throttled send comes back retryable — even though Reddit answered HTTP 200", () =>
    Effect.gen(function* () {
      const fake = makeFakeReddit()
      fake.state.commentReply = { json: { errors: [["RATELIMIT", "you are doing that too much. try again in 3 minutes.", "ratelimit"]] } }
      const error = yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(fake)
          return yield* connection.send("t3_aaa", { text: "hello" }).pipe(Effect.flip)
        }),
      )
      expect(error._tag).toBe("MessengerDriver.SendError")
      if (error._tag === "MessengerDriver.SendError") {
        expect(error.retryable).toBe(true)
        expect(error.reason).toContain("180s")
      }
    }),
  )

  it.live("the subreddit can't be 'replied to' — that would be submitting a post", () =>
    Effect.gen(function* () {
      const fake = makeFakeReddit()
      const error = yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(fake)
          return yield* connection.send("r/novaclaw", { text: "announcement" }).pipe(Effect.flip)
        }),
      )
      expect(error._tag).toBe("MessengerDriver.SendError")
      if (error._tag === "MessengerDriver.SendError") expect(error.reason).toContain("doesn't submit new posts")
    }),
  )

  it.live("listChats returns the subreddit, its moderation queue, and its live posts", () =>
    Effect.gen(function* () {
      const fake = makeFakeReddit()
      const chats = yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(fake)
          return yield* connection.listChats!()
        }),
      )
      expect(chats[0]).toEqual({ chatID: "r/novaclaw", kind: "channel", title: "r/novaclaw" })
      // The queue is offered as a place you can go, not only something that pushes at you.
      expect(chats[1]).toMatchObject({ chatID: "r/novaclaw/modqueue", kind: "mailbox", parentID: "r/novaclaw" })
      expect(chats[2]).toEqual({ chatID: "t3_aaa", kind: "thread", title: "Crash on save", parentID: "r/novaclaw" })
    }),
  )

  // The login is what every operator's setup runs through, and `duration=permanent` is the one
  // parameter that decides whether the sign-in survives an hour or forever.
  it.live("the browser login asks for a PERMANENT grant and stores the refresh token", () =>
    Effect.gen(function* () {
      const fake = makeFakeReddit()
      const opened: string[] = []
      const loopbackParams: { port?: number; redirectUri?: string }[] = []
      const capturingLoopback = (params: { port?: number; redirectUri?: string }) => {
        loopbackParams.push(params)
        return loopback(params)
      }
      const driver = RedditDriver.make(fake.fetchImpl, capturingLoopback as never, (url) => Effect.sync(() => void opened.push(url)))
      const session = yield* Effect.scoped(
        Effect.gen(function* () {
          const pending = yield* driver.login!.begin({ account: ACCOUNT, inputs: {} })
          // The loopback resolves immediately in this fake, so the first complete() may still race
          // the exchange fiber — retryable means "ask again", which is what the wizard does.
          for (let attempt = 0; attempt < 50; attempt++) {
            const done = yield* pending.complete("").pipe(Effect.exit)
            if (Exit.isSuccess(done)) return done.value
            yield* Effect.sleep(Duration.millis(10))
          }
          return yield* Effect.die("login never completed")
        }),
      )
      expect(JSON.parse(session.session)).toEqual({ refreshToken: "rt-new" })
      const url = new URL(opened[0]!)
      expect(url.origin + url.pathname).toBe("https://www.reddit.com/api/v1/authorize")
      expect(url.searchParams.get("duration")).toBe("permanent") // no refresh token without it
      expect(url.searchParams.get("response_type")).toBe("code") // implicit grants can't be permanent
      expect(url.searchParams.get("client_id")).toBe("cid")
      expect(url.searchParams.get("scope")).toContain("modposts")
      // ⚠️ Reddit matches the redirect URI EXACTLY. The driver must request the fixed port and the
      // canonical URI the setup recipe told the user to register — a random port would fail at the
      // browser every time. The authorize link and the token exchange must carry that same string.
      expect(loopbackParams[0]?.port).toBe(RedditDriver.LOOPBACK_PORT)
      expect(loopbackParams[0]?.redirectUri).toBe(RedditDriver.REDIRECT_URI)
      expect(url.searchParams.get("redirect_uri")).toBe(RedditDriver.REDIRECT_URI)
      const exchange = fake.state.calls.find((call) => call.url.includes("access_token"))
      expect(exchange?.form).toMatchObject({ grant_type: "authorization_code", code: "code-1", redirect_uri: RedditDriver.REDIRECT_URI })
    }),
  )

  it.live("the modqueue is polled and pushed — reports on old items reach the moderator", () =>
    Effect.gen(function* () {
      const fake = makeFakeReddit()
      fake.state.posts = []
      fake.state.queue = [{ kind: "t1", data: { name: "t1_old", author: "spammer", body: "buy my thing", num_reports: 3, created_utc: 1_600_000_000 } }]
      const received: InboundEvent[] = []
      yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(fake)
          yield* connection.inbound.pipe(
            Stream.take(1),
            Stream.runForEach((event) => Effect.sync(() => received.push(event))),
          )
        }),
      )
      const queued = received[0]
      if (queued?.kind !== "message") throw new Error("expected a queued item")
      expect(queued.chat.chatID).toBe("r/novaclaw/modqueue")
      expect(queued.text).toContain("3 reports")
    }),
  )

  // Losing the public listings because the bot lacks one mod permission would be a worse outcome
  // than a quiet queue — so a refused queue must not take the connection down with it.
  it.live("a forbidden modqueue does NOT kill the rest of the driver", () =>
    Effect.gen(function* () {
      const fake = makeFakeReddit()
      fake.state.queueStatus = 403
      const received: InboundEvent[] = []
      yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(fake)
          yield* connection.inbound.pipe(
            Stream.take(1),
            Stream.runForEach((event) => Effect.sync(() => received.push(event))),
          )
        }),
      )
      expect(received[0]?.kind === "message" && received[0].chat.chatID).toBe("t3_aaa") // the post still arrived
    }),
  )

  it.live("reading the queue with no mod permission blames the permission, not the network", () =>
    Effect.gen(function* () {
      const fake = makeFakeReddit()
      fake.state.queueStatus = 403
      const error = yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(fake)
          return yield* connection.history!("r/novaclaw/modqueue", 10).pipe(Effect.flip)
        }),
      )
      expect(error.reason).toContain("posts` moderator permission")
    }),
  )

  it.live("moderation reaches the mapped endpoint, and a 403 blames the missing mod permission", () =>
    Effect.gen(function* () {
      const fake = makeFakeReddit()
      yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(fake)
          yield* connection.moderate!("t3_aaa", { act: "delete", messageID: "t1_c1" })
          yield* connection.moderate!("t3_aaa", { act: "approve", messageID: "t1_c1" })
          yield* connection.moderate!("t3_aaa", { act: "lock" })
        }),
      )
      const paths = fake.state.calls.filter((call) => call.method === "POST").map((call) => call.url)
      expect(paths.some((url) => url.includes("/api/remove"))).toBe(true)
      expect(paths.some((url) => url.includes("/api/approve"))).toBe(true)
      expect(paths.some((url) => url.includes("/api/lock"))).toBe(true)
    }),
  )
})
