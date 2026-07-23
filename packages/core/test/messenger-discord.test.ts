import { describe, expect, test } from "bun:test"
import { Duration, Effect, Stream } from "effect"
import type { Messenger } from "@novaclaw/schema/messenger"
import { DiscordDriver } from "@novaclaw/core/messenger/driver/discord"
import type { DiscordSocket, DiscordSocketFactory } from "@novaclaw/core/messenger/driver/discord"
import type { InboundEvent } from "@novaclaw/core/messenger/driver"
import { it } from "./lib/effect"

// P7 gate (notes/messenger-plan.md §8): the Discord driver against a FAKE gateway + REST — the
// token gate, HELLO→IDENTIFY with intents, READY persists the resume cursor, RESUME when a
// cursor exists, MESSAGE_CREATE normalization (guild vs DM, attachments as CDN-url FileRefs,
// isSelf), 2000-char chunked sends, multipart file sends, and guild→channel listChats.

const makeFakeGateway = () => {
  const state = {
    wsSent: [] as { op: number; d?: unknown }[],
    restCalls: [] as { url: string; method: string; body?: unknown; form?: boolean }[],
    connectedURLs: [] as string[],
    reject401: false,
    moderationForbidden: false,
    guilds: [{ id: "g1", name: "NovaClaw HQ" }],
    channels: {
      g1: [
        { id: "c-support", type: 0, name: "support" },
        { id: "c-voice", type: 2, name: "lounge" },
        { id: "c-bugs", type: 15, name: "bug-reports" }, // a FORUM — where support posts land
      ],
    } as Record<string, { id: string; type: number; name: string }[]>,
    // Live forum posts: each is a thread whose parent is the forum channel.
    activeThreads: { g1: [{ id: "t-crash", type: 11, name: "Crash on save", parent_id: "c-bugs" }] } as Record<
      string,
      { id: string; type: number; name: string; parent_id: string }[]
    >,
    // Messages a channel returns to `GET /channels/:id/messages?after=…` (newest-first, like Discord).
    backfill: {} as Record<string, { id: string; channel_id: string; author: { id: string; username: string }; content: string }[]>,
  }
  let handlers: Parameters<DiscordSocketFactory>[1] | undefined
  const push = (frame: unknown) => handlers?.onMessage(JSON.stringify(frame))
  const closeSocket = (reason: string) => handlers?.onClose(reason)

  const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET"
    const isForm = init?.body instanceof FormData
    state.restCalls.push({
      url,
      method,
      ...(init?.body === undefined ? {} : { body: isForm ? undefined : JSON.parse(init.body as string) }),
      ...(isForm ? { form: true } : {}),
    })
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
    if (url.endsWith("/users/@me")) return state.reject401 ? json({ message: "401: Unauthorized" }, 401) : json({ id: "bot-1", username: "nova" })
    if (url.endsWith("/users/@me/guilds")) return json(state.guilds)
    const guildChannels = url.match(/\/guilds\/([^/]+)\/channels$/)
    if (guildChannels) return json(state.channels[guildChannels[1]!] ?? [])
    const activeThreads = url.match(/\/guilds\/([^/]+)\/threads\/active$/)
    if (activeThreads) return json({ threads: state.activeThreads[activeThreads[1]!] ?? [] })
    const channel = url.match(/\/channels\/([^/]+)$/)
    if (channel) {
      const id = channel[1]!
      const thread = Object.values(state.activeThreads).flat().find((t) => t.id === id)
      if (thread) return json({ ...thread, guild_id: "g1" })
      return json({ id, type: 0, name: "support", guild_id: "g1" })
    }
    // Reconnect backfill: messages posted while the bot was disconnected, fetched after an anchor.
    const backfillMatch = url.match(/\/channels\/([^/]+)\/messages\?after=/)
    if (backfillMatch && method === "GET") return json(state.backfill[backfillMatch[1]!] ?? [])
    if (/\/channels\/[^/]+\/messages$/.test(url)) return json({ id: "sent-" + state.restCalls.length })
    // Moderation routes (all succeed with an empty 200 unless a test flips a flag).
    if (state.moderationForbidden) return json({ message: "Missing Permissions" }, 403)
    if (/\/channels\/[^/]+\/messages\/[^/]+$/.test(url) && method === "DELETE") return json({}, 200)
    if (/\/channels\/[^/]+\/pins\/[^/]+$/.test(url) && method === "PUT") return json({}, 200)
    if (/\/guilds\/[^/]+\/bans\/[^/]+$/.test(url) && method === "PUT") return json({}, 200)
    if (/\/guilds\/[^/]+\/members\/[^/]+$/.test(url) && (method === "DELETE" || method === "PATCH")) return json({}, 200)
    if (url.startsWith("https://cdn.example/")) return new Response(new TextEncoder().encode("cdn-bytes"))
    return json({}, 404)
  }

  const socketFactory: DiscordSocketFactory = async (url, h) => {
    state.connectedURLs.push(url)
    handlers = h
    const socket: DiscordSocket = {
      send: (data) => state.wsSent.push(JSON.parse(data) as { op: number; d?: unknown }),
      close: () => undefined,
    }
    // HELLO arrives right after connect (a long heartbeat keeps tests deterministic).
    queueMicrotask(() => push({ op: 10, d: { heartbeat_interval: 60_000 } }))
    return socket
  }

  return { state, push, closeSocket, fetchImpl, socketFactory }
}

const ACCOUNT = {
  id: "msa_dc" as never,
  driverID: "discord",
  label: "discord",
  enabled: true,
  settings: {},
} as never as Messenger.AccountInfo

const connect = (
  fake: ReturnType<typeof makeFakeGateway>,
  options?: { cursor?: unknown; onCursor?: (value: unknown) => void },
) =>
  DiscordDriver.make(fake.fetchImpl, fake.socketFactory).connect({
    account: ACCOUNT,
    secret: "bot-token",
    cursor: {
      get: () => Effect.succeed(options?.cursor),
      set: (value) => Effect.sync(() => options?.onCursor?.(value)),
    },
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

describe("DiscordDriver", () => {
  test("readCursor round-trips and rejects junk", () => {
    expect(DiscordDriver.readCursor({ sessionID: "s", seq: 5, resumeURL: "wss://r" })).toEqual({
      sessionID: "s",
      seq: 5,
      resumeURL: "wss://r",
    })
    expect(DiscordDriver.readCursor({ sessionID: "s" })).toBeUndefined()
    expect(DiscordDriver.readCursor("junk")).toBeUndefined()
  })

  it.live("a rejected token parks legibly before any socket opens", () =>
    Effect.gen(function* () {
      const fake = makeFakeGateway()
      fake.state.reject401 = true
      const error = yield* Effect.scoped(connect(fake)).pipe(Effect.flip)
      expect(error._tag).toBe("MessengerDriver.ConnectError")
      if (error._tag === "MessengerDriver.ConnectError") expect(error.reason).toContain("rejected this bot token")
      expect(fake.state.connectedURLs).toHaveLength(0)
    }),
  )

  it.live("identifies with intents, persists READY as the resume cursor, and normalizes messages", () =>
    Effect.gen(function* () {
      const fake = makeFakeGateway()
      const cursors: unknown[] = []
      const received: InboundEvent[] = []
      yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(fake, { onCursor: (value) => cursors.push(value) })
          yield* eventually(() => fake.state.wsSent, (sent) => sent.some((f) => f.op === 2), "IDENTIFY sent")
          const identify = fake.state.wsSent.find((f) => f.op === 2)?.d as { intents: number; token: string }
          expect(identify.token).toBe("bot-token")
          expect(identify.intents & 32768).toBe(32768) // MESSAGE CONTENT
          fake.push({ op: 0, s: 1, t: "READY", d: { session_id: "sess-9", resume_gateway_url: "wss://resume.example", user: { id: "bot-1" } } })
          // A guild message with an attachment, then our own echo, then a DM.
          fake.push({
            op: 0,
            s: 2,
            t: "MESSAGE_CREATE",
            d: {
              id: "m1",
              channel_id: "c-support",
              guild_id: "g1",
              author: { id: "u9", username: "alice" },
              content: "here's the crash log",
              attachments: [{ id: "a1", filename: "crash.txt", size: 42, url: "https://cdn.example/a1", content_type: "text/plain" }],
            },
          })
          fake.push({
            op: 0,
            s: 3,
            t: "MESSAGE_CREATE",
            d: { id: "m2", channel_id: "c-support", guild_id: "g1", author: { id: "bot-1", username: "nova" }, content: "on it" },
          })
          fake.push({
            op: 0,
            s: 4,
            t: "MESSAGE_CREATE",
            d: { id: "m3", channel_id: "dm-1", author: { id: "u9", global_name: "Alice" }, content: "thanks!" },
          })
          yield* connection.inbound.pipe(
            Stream.take(3),
            Stream.runForEach((event) => Effect.sync(() => received.push(event))),
          )
          // Files down: the attachment ref's id IS the CDN url.
          const first = received[0]
          if (first?.kind === "message" && first.attachments?.[0] !== undefined) {
            const bytes = yield* connection.downloadFile!(first.attachments[0])
            expect(new TextDecoder().decode(bytes)).toBe("cdn-bytes")
          }
        }),
      )
      expect(cursors.some((value) => DiscordDriver.readCursor(value)?.sessionID === "sess-9")).toBe(true)
      const [guildMsg, echo, dm] = received
      if (guildMsg?.kind === "message") {
        expect(guildMsg.chat).toEqual({ chatID: "c-support", kind: "group", title: "#support" })
        expect(guildMsg.sender.isSelf).toBe(false)
        expect(guildMsg.attachments?.[0]?.name).toBe("crash.txt")
      }
      if (echo?.kind === "message") expect(echo.sender.isSelf).toBe(true)
      if (dm?.kind === "message") {
        expect(dm.chat.kind).toBe("dm")
        expect(dm.chat.title).toBe("Alice")
      }
    }),
  )

  it.live("a stored cursor RESUMEs (op 6); op 9 drops the session but KEEPS the catch-up anchors", () =>
    Effect.gen(function* () {
      const fake = makeFakeGateway()
      const cursors: unknown[] = []
      yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(fake, {
            cursor: { sessionID: "sess-9", seq: 41, resumeURL: "wss://resume.example", anchors: { "c-support": "m10" } },
            onCursor: (value) => cursors.push(value),
          })
          yield* eventually(() => fake.state.wsSent, (sent) => sent.some((f) => f.op === 6), "RESUME sent")
          const resume = fake.state.wsSent.find((f) => f.op === 6)?.d as { session_id: string; seq: number }
          expect(resume.session_id).toBe("sess-9")
          expect(resume.seq).toBe(41)
          expect(fake.state.connectedURLs[0]).toBe("wss://resume.example")
          // The server invalidates the session — the connection ends and the RESUME state clears…
          fake.push({ op: 9, d: false })
          yield* connection.inbound.pipe(Stream.runDrain, Effect.exit)
        }),
      )
      // …but the anchors persist through it, so the next fresh connect can still backfill the gap
      // (clearing them here — the old behaviour — is what silently lost a sleeping instance's mail).
      const afterInvalidation = cursors.at(-1) as { sessionID?: string; anchors?: Record<string, string> } | undefined
      expect(afterInvalidation?.sessionID).toBeUndefined()
      expect(afterInvalidation?.anchors).toEqual({ "c-support": "m10" })
    }),
  )

  it.live("sends chunk at 2000 chars; files ride multipart with the text as payload caption", () =>
    Effect.gen(function* () {
      const fake = makeFakeGateway()
      yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(fake)
          yield* connection.send("c-support", { text: "word ".repeat(600) }) // ~3000 chars
          yield* connection.send("c-support", {
            file: { name: "logo.svg", mime: "image/svg+xml", data: new TextEncoder().encode("<svg/>") },
            text: "the draft",
          })
        }),
      )
      const posts = fake.state.restCalls.filter((call) => call.method === "POST")
      const textPosts = posts.filter((call) => !call.form)
      expect(textPosts.length).toBeGreaterThan(1)
      for (const post of textPosts) expect(((post.body as { content: string }).content).length).toBeLessThanOrEqual(2000)
      expect(posts.some((call) => call.form)).toBe(true)
    }),
  )

  it.live("moderate routes to the right Discord REST call per act; resolves the channel's guild", () =>
    Effect.gen(function* () {
      const fake = makeFakeGateway()
      yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(fake)
          if (connection.moderate === undefined) throw new Error("Discord must expose moderation")
          yield* connection.moderate("c-support", { act: "delete", messageID: "m1" })
          yield* connection.moderate("c-support", { act: "pin", messageID: "m2" })
          yield* connection.moderate("c-support", { act: "ban", userID: "u9" })
          yield* connection.moderate("c-support", { act: "kick", userID: "u8" })
          yield* connection.moderate("c-support", { act: "mute", userID: "u7", seconds: 300 })
        }),
      )
      const calls = fake.state.restCalls
      const seen = (method: string, re: RegExp) => calls.some((c) => c.method === method && re.test(c.url))
      expect(seen("DELETE", /\/channels\/c-support\/messages\/m1$/)).toBe(true)
      expect(seen("PUT", /\/channels\/c-support\/pins\/m2$/)).toBe(true)
      expect(seen("PUT", /\/guilds\/g1\/bans\/u9$/)).toBe(true) // guild resolved from the channel
      expect(seen("DELETE", /\/guilds\/g1\/members\/u8$/)).toBe(true)
      const mute = calls.find((c) => c.method === "PATCH" && /\/guilds\/g1\/members\/u7$/.test(c.url))
      expect(mute).toBeDefined()
      expect(typeof (mute!.body as { communication_disabled_until?: unknown }).communication_disabled_until).toBe("string")
    }),
  )

  it.live("a moderation refusal (missing permission) surfaces as a ModerationError", () =>
    Effect.gen(function* () {
      const fake = makeFakeGateway()
      fake.state.moderationForbidden = true
      const error = yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(fake)
          return yield* connection.moderate!("c-support", { act: "delete", messageID: "m1" }).pipe(Effect.flip)
        }),
      )
      expect(error._tag).toBe("MessengerDriver.ModerationError")
      if (error._tag === "MessengerDriver.ModerationError") expect(error.reason).toContain("403")
    }),
  )

  it.live("listChats maps text channels, FORUMS, and live threads (voice skipped)", () =>
    Effect.gen(function* () {
      const fake = makeFakeGateway()
      const chats = yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(fake)
          return yield* connection.listChats!()
        }),
      )
      expect(chats).toEqual([
        { chatID: "c-support", kind: "group", title: "#support (NovaClaw HQ)" },
        // A forum is pickable and SAYS it's a forum — binding it covers every post inside.
        { chatID: "c-bugs", kind: "group", title: "#bug-reports (NovaClaw HQ · forum)" },
        // Each live post is a thread, listed under its forum, carrying the parent that routes it.
        { chatID: "t-crash", kind: "thread", title: "Crash on save (#bug-reports · NovaClaw HQ)", parentID: "c-bugs" },
      ])
      expect(DiscordDriver.driver.meta.capabilities.listChats).toBe("full")
    }),
  )

  it.live("a message in a forum post arrives as a THREAD carrying its parent forum", () =>
    Effect.gen(function* () {
      const fake = makeFakeGateway()
      const received: InboundEvent[] = []
      yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(fake)
          yield* eventually(() => fake.state.wsSent, (sent) => sent.some((f) => f.op === 2), "IDENTIFY sent")
          fake.push({ op: 0, s: 1, t: "READY", d: { session_id: "sess-1", user: { id: "bot-1" } } })
          fake.push({
            op: 0,
            s: 2,
            t: "MESSAGE_CREATE",
            d: { id: "m9", channel_id: "t-crash", guild_id: "g1", author: { id: "u5", username: "dave" }, content: "it crashes when I save" },
          })
          yield* connection.inbound.pipe(
            Stream.take(1),
            Stream.runForEach((event) => Effect.sync(() => received.push(event))),
          )
        }),
      )
      const post = received[0]
      if (post?.kind !== "message") throw new Error("expected a message")
      // Without parentID the gateway could never match this to the forum's binding — every
      // support post would be silently unheard.
      expect(post.chat).toEqual({ chatID: "t-crash", kind: "thread", title: "Crash on save", parentID: "c-bugs" })
    }),
  )

  // The product's users run on laptops that sleep and phones that background — and Discord replays
  // NOTHING a bot missed while disconnected. On a fresh reconnect the driver must pull the gap over
  // REST from the per-channel anchor, or a sleeping instance silently loses its support channel.
  it.live("on a fresh reconnect, messages missed while disconnected are replayed from the anchor", () =>
    Effect.gen(function* () {
      const fake = makeFakeGateway()
      // Two messages arrived in #support after the last one we processed (m10) while we were asleep.
      fake.state.backfill["c-support"] = [
        { id: "m12", channel_id: "c-support", author: { id: "u9", username: "alice" }, content: "second while away" },
        { id: "m11", channel_id: "c-support", author: { id: "u9", username: "alice" }, content: "first while away" },
      ]
      const received: InboundEvent[] = []
      yield* Effect.scoped(
        Effect.gen(function* () {
          // No resume session (a real sleep invalidates it) but a durable anchor at m10 → backfill.
          const connection = yield* connect(fake, { cursor: { anchors: { "c-support": "m10" } } })
          yield* eventually(() => fake.state.wsSent, (sent) => sent.some((f) => f.op === 2), "fresh IDENTIFY (not resume)")
          yield* connection.inbound.pipe(
            Stream.take(2),
            Stream.runForEach((event) => Effect.sync(() => received.push(event))),
          )
        }),
      )
      // The REST fetch used the anchor as `after`, and the two missed messages arrive in ORDER.
      expect(fake.state.restCalls.some((call) => /\/channels\/c-support\/messages\?after=m10/.test(call.url))).toBe(true)
      expect(received.map((event) => (event.kind === "message" ? event.text : undefined))).toEqual(["first while away", "second while away"])
    }),
  )

  it.live("with a valid resume session, the gateway replay is trusted — no REST backfill burst", () =>
    Effect.gen(function* () {
      const fake = makeFakeGateway()
      fake.state.backfill["c-support"] = [{ id: "m11", channel_id: "c-support", author: { id: "u9", username: "alice" }, content: "should not be pulled" }]
      yield* Effect.scoped(
        Effect.gen(function* () {
          // A resume session PRESENT → the gateway replays the gap; a REST burst would double-deliver.
          yield* connect(fake, { cursor: { sessionID: "sess-9", seq: 5, resumeURL: "wss://resume.example", anchors: { "c-support": "m10" } } })
          yield* eventually(() => fake.state.wsSent, (sent) => sent.some((f) => f.op === 6), "RESUME, not backfill")
          yield* Effect.sleep(Duration.millis(50)) // give any (unwanted) backfill a chance to fire
        }),
      )
      expect(fake.state.restCalls.some((call) => /messages\?after=/.test(call.url))).toBe(false)
    }),
  )

  it.live("a reply attaches to the message that asked — first chunk only", () =>
    Effect.gen(function* () {
      const fake = makeFakeGateway()
      yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(fake)
          yield* connection.send("c-support", { text: "word ".repeat(600), replyTo: "m1" }) // >2000 chars
        }),
      )
      const posts = fake.state.restCalls.filter((call) => call.method === "POST" && !call.form)
      expect(posts.length).toBeGreaterThan(1)
      const references = posts.map((call) => (call.body as { message_reference?: { message_id: string } }).message_reference)
      expect(references[0]).toEqual({ message_id: "m1", fail_if_not_exists: false } as never)
      // A five-deep quote chain reads awful — only the opening chunk quotes.
      expect(references.slice(1).every((reference) => reference === undefined)).toBe(true)
    }),
  )

  it.live("ban can take the spammer's recent messages with it (delete_message_seconds)", () =>
    Effect.gen(function* () {
      const fake = makeFakeGateway()
      yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(fake)
          yield* connection.moderate!("c-support", { act: "ban", userID: "spammer", purgeSeconds: 3600 })
          yield* connection.moderate!("c-support", { act: "ban", userID: "u9" })
        }),
      )
      const bans = fake.state.restCalls.filter((call) => call.method === "PUT" && /\/guilds\/g1\/bans\//.test(call.url))
      expect((bans[0]?.body as { delete_message_seconds?: number }).delete_message_seconds).toBe(3600)
      // A plain ban stays a plain ban — no messages deleted unless asked.
      expect((bans[1]?.body as { delete_message_seconds?: number }).delete_message_seconds).toBeUndefined()
    }),
  )
})
