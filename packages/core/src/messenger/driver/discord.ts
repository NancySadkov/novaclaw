export * as DiscordDriver from "./discord"

import { Duration, Effect, Queue, Schema, Stream } from "effect"
import { Messenger } from "@novaclaw/schema/messenger"
import { MessengerFormat } from "../format"
import type { ChatSnapshot, Connection, ConnectContext, Driver, FileRef, HistoryEntry, InboundEvent, ModerationAct, OutboundFile } from "../driver"
import { ConnectError, FileError, ModerationError, SendError } from "../driver"

// The Discord BOT driver (messenger-plan §2.1): REST over HTTPS + the Gateway WebSocket, both
// behind injectable seams (fetch + a socket factory) so tests drive fakes. `key` auth = a bot
// token; the MESSAGE CONTENT privileged intent must be enabled on the app or message text
// arrives empty (the probe cannot see that setting — the driver docs the failure legibly).
// Durable cursor = { sessionID, seq, resumeURL } so a reconnect RESUMEs instead of replaying
// (op 9 invalid-session clears it and the next attempt re-identifies).

const API_BASE = "https://discord.com/api/v10"
const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json"
// GUILDS + GUILD_MESSAGES + DIRECT_MESSAGES + MESSAGE_CONTENT
const INTENTS = 1 | 512 | 4096 | 32768

// Discord channel types we care about. A support server keeps its traffic in text channels AND
// in FORUMS, where every user post is its own thread — so threads are first-class here: they
// carry `parent_id`, and the gateway routes a thread's messages to the parent's binding
// (driver.ts ChatSnapshot.parentID), which is the only way one binding can cover a live forum.
const CHANNEL_TEXT = 0
const CHANNEL_ANNOUNCEMENT = 5
const CHANNEL_FORUM = 15
const CHANNEL_MEDIA = 16
const THREAD_TYPES = new Set([10, 11, 12])
const LISTABLE_TYPES = new Set([CHANNEL_TEXT, CHANNEL_ANNOUNCEMENT, CHANNEL_FORUM, CHANNEL_MEDIA])

const chatKindOf = (type: number | undefined, dm: boolean): Messenger.ChatKind => {
  if (dm) return "dm"
  if (type !== undefined && THREAD_TYPES.has(type)) return "thread"
  if (type === CHANNEL_ANNOUNCEMENT) return "channel"
  return "group"
}

const CAPS: Messenger.Capabilities = {
  listChats: "full", // guilds → text channels; DMs join via the seen-cache
  files: { up: true, down: true, maxBytes: 8_000_000 },
  edits: true,
  typing: true,
  threads: true,
  moderation: { delete: true, ban: true, kick: true, mute: true, pin: true, lock: true, approve: false },
  format: "markdown",
  maxChars: 2000,
}

/** The gateway frames we decode; unknown fields are ignored. */
const Frame = Schema.Struct({
  op: Schema.Number,
  s: Schema.optional(Schema.NullOr(Schema.Number)),
  t: Schema.optional(Schema.NullOr(Schema.String)),
  d: Schema.optional(Schema.Unknown),
})
const Hello = Schema.Struct({ heartbeat_interval: Schema.Number })
const Ready = Schema.Struct({
  session_id: Schema.String,
  resume_gateway_url: Schema.optional(Schema.String),
  user: Schema.Struct({ id: Schema.String, username: Schema.optional(Schema.String) }),
})
const Author = Schema.Struct({
  id: Schema.String,
  username: Schema.optional(Schema.String),
  global_name: Schema.optional(Schema.NullOr(Schema.String)),
})
const Attachment = Schema.Struct({
  id: Schema.String,
  filename: Schema.String,
  size: Schema.optional(Schema.Number),
  url: Schema.String,
  content_type: Schema.optional(Schema.String),
})
const MessageCreate = Schema.Struct({
  id: Schema.String,
  channel_id: Schema.String,
  guild_id: Schema.optional(Schema.String),
  author: Author,
  content: Schema.optional(Schema.String),
  attachments: Schema.optional(Schema.Array(Attachment)),
  referenced_message: Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.String }))),
  timestamp: Schema.optional(Schema.String),
})
const Me = Schema.Struct({ id: Schema.String, username: Schema.optional(Schema.String) })
const Guild = Schema.Struct({ id: Schema.String, name: Schema.String })
const Channel = Schema.Struct({
  id: Schema.String,
  type: Schema.Number,
  name: Schema.optional(Schema.NullOr(Schema.String)),
  parent_id: Schema.optional(Schema.NullOr(Schema.String)),
})
const ActiveThreads = Schema.Struct({ threads: Schema.Array(Channel) })
const SentMessage = Schema.Struct({ id: Schema.String })

const decodeFrame = Schema.decodeUnknownOption(Frame)
const decodeHello = Schema.decodeUnknownOption(Hello)
const decodeReady = Schema.decodeUnknownOption(Ready)
const decodeMessageCreate = Schema.decodeUnknownOption(MessageCreate)
const decodeMe = Schema.decodeUnknownOption(Me)
const decodeGuilds = Schema.decodeUnknownOption(Schema.Array(Guild))
const decodeChannels = Schema.decodeUnknownOption(Schema.Array(Channel))
const decodeChannel = Schema.decodeUnknownOption(Channel)
const decodeActiveThreads = Schema.decodeUnknownOption(ActiveThreads)
const decodeSent = Schema.decodeUnknownOption(SentMessage)
const decodeMessages = Schema.decodeUnknownOption(Schema.Array(MessageCreate))
// A cap on catch-up per channel: after a very long downtime we replay the most recent page and note
// the gap rather than paging endlessly through a backlog nobody will read.
const BACKFILL_PAGE = 100

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** The WebSocket surface the driver needs — production wraps `new WebSocket(url)`; tests fake it. */
export interface DiscordSocket {
  readonly send: (data: string) => void
  readonly close: () => void
}
export type DiscordSocketFactory = (
  url: string,
  handlers: {
    readonly onMessage: (data: string) => void
    readonly onClose: (reason: string) => void
  },
) => Promise<DiscordSocket>

export interface Cursor {
  readonly sessionID: string
  readonly seq: number
  readonly resumeURL?: string
}

export const readCursor = (value: unknown): Cursor | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const { sessionID, seq, resumeURL } = value as Record<string, unknown>
  if (typeof sessionID !== "string" || typeof seq !== "number") return undefined
  return { sessionID, seq, ...(typeof resumeURL === "string" ? { resumeURL } : {}) }
}

/**
 * Per-channel "last message id I delivered" anchors, persisted ALONGSIDE the resume state and —
 * critically — surviving an invalid-session wipe. Discord's gateway does not replay messages a bot
 * missed while it was disconnected (a laptop asleep, a phone backgrounded); on a fresh reconnect the
 * driver replays them itself over REST, starting after these anchors. So they must outlive the very
 * event (op 9) that clears the resume session — which is exactly when catch-up is needed. Read
 * independently of `readCursor` for that reason.
 */
export const readAnchors = (value: unknown): Record<string, string> => {
  if (typeof value !== "object" || value === null) return {}
  const anchors = (value as Record<string, unknown>)["anchors"]
  if (typeof anchors !== "object" || anchors === null) return {}
  const out: Record<string, string> = {}
  for (const [channelID, messageID] of Object.entries(anchors)) if (typeof messageID === "string") out[channelID] = messageID
  return out
}

const authorName = (author: typeof Author.Type): string => author.global_name ?? author.username ?? author.id

/** What the caller's channel cache knows about the message's channel (the gateway event carries
 *  ids only — no name, no type, no parent). */
export interface ChannelMeta {
  readonly title?: string
  readonly type?: number
  readonly parentID?: string
}

/** Normalize one MESSAGE_CREATE. A thread (a forum post is one) reports its parent channel, so a
 *  single binding on the forum covers every post inside it. */
export const toInbound = (
  message: typeof MessageCreate.Type,
  selfID: string | undefined,
  channel: ChannelMeta | undefined,
): InboundEvent => {
  const dm = message.guild_id === undefined
  const chat: ChatSnapshot = {
    chatID: message.channel_id,
    kind: chatKindOf(channel?.type, dm),
    title: channel?.title ?? (dm ? authorName(message.author) : `#${message.channel_id}`),
    ...(channel?.parentID === undefined ? {} : { parentID: channel.parentID }),
  }
  const attachments: FileRef[] | undefined =
    message.attachments === undefined || message.attachments.length === 0
      ? undefined
      : message.attachments.map((attachment) => ({
          id: attachment.url,
          name: attachment.filename,
          ...(attachment.content_type === undefined ? {} : { mime: attachment.content_type }),
          ...(attachment.size === undefined ? {} : { size: attachment.size }),
        }))
  return {
    kind: "message",
    chat,
    messageID: message.id,
    sender: {
      id: message.author.id,
      name: authorName(message.author),
      isSelf: selfID !== undefined && message.author.id === selfID,
    },
    ...(message.content !== undefined && message.content.length > 0 ? { text: message.content } : {}),
    ...(attachments === undefined ? {} : { attachments }),
    ...(message.referenced_message == null ? {} : { replyTo: message.referenced_message.id }),
    at: message.timestamp !== undefined ? Date.parse(message.timestamp) || Date.now() : Date.now(),
  }
}

export const make = (fetchImpl: FetchLike, socketFactory: DiscordSocketFactory): Driver => ({
  id: "discord",
  meta: {
    id: "discord",
    name: "Discord (bot)",
    icon: "speech-bubble",
    auth: "key",
    settings: [],
    // Discord is the one messenger where the credential takes a trip through a developer portal,
    // and two of its switches fail SILENTLY when missed (message content arrives empty without the
    // intent; a private app refuses to save while an install link is set). So the recipe names
    // every button, in order, including the traps.
    setup: {
      url: "https://discord.com/developers/applications",
      urlLabel: "Open the Discord Developer Portal",
      steps: [
        "Press New Application, give it the name your users will see, and accept the terms.",
        "Open Bot in the left sidebar, press Reset Token, and copy the token into the field below — Discord shows it only once.",
        "Still on Bot, switch ON Message Content Intent (under Privileged Gateway Intents). Without it your bot receives every message EMPTY and will look like it is ignoring people.",
        "Recommended: switch OFF Public Bot so only you can add it. If Discord refuses to save, first set Installation → Install Link to None, then try again.",
        "Open OAuth2 → URL Generator: tick the scope bot, choose Integration Type Guild Install, then tick View Channels, Send Messages, Send Messages in Threads and Read Message History. For moderation duty add Manage Messages, Moderate Members, Kick Members and Ban Members.",
        "Open the URL it builds at the bottom, pick your server, and confirm. The bot appears in your member list — offline until you finish here.",
        "Paste the token below and save. Then open a chat's Tuning → Remote chat to point NovaClaw at the channel it should work in.",
      ],
    },
    capabilities: CAPS,
  },
  capabilities: () => CAPS,
  connect: (ctx: ConnectContext) =>
    Effect.gen(function* () {
      const token = ctx.secret
      if (token === undefined || token.length === 0)
        return yield* Effect.fail(new ConnectError({ reason: "No bot token — add one in Settings → Messengers." }))

      const rest = (route: string, init?: RequestInit) =>
        Effect.tryPromise({
          try: async () => {
            const response = await fetchImpl(`${API_BASE}${route}`, {
              ...init,
              headers: { Authorization: `Bot ${token}`, ...(init?.headers ?? {}) },
            })
            return { status: response.status, body: (await response.json().catch(() => undefined)) as unknown }
          },
          catch: (error) => new ConnectError({ reason: `Discord ${route} failed: ${String(error)}` }),
        })

      // The token gate (the Telegram getMe lesson): a rejected token must park legibly, never
      // leave the account "connected" while the socket loops 4004s.
      const meResponse = yield* rest("/users/@me")
      if (meResponse.status === 401 || meResponse.status === 403)
        return yield* Effect.fail(
          new ConnectError({ reason: "Discord rejected this bot token — check it in Settings → Messengers." }),
        )
      const me = decodeMe(meResponse.body)
      const selfID = me._tag === "Some" ? me.value.id : undefined

      // Lazily learned channel metadata — name, type, and (for a thread / forum post) its parent.
      // The gateway events carry ids only, and the parent is what makes ONE binding cover a whole
      // support forum, so this lookup is load-bearing, not cosmetic.
      const channelMeta = new Map<string, ChannelMeta>()
      const describeChannel = (channelID: string, dm: boolean) =>
        Effect.gen(function* () {
          if (dm) return undefined
          const known = channelMeta.get(channelID)
          if (known !== undefined) return known
          const response = yield* rest(`/channels/${channelID}`).pipe(Effect.orElseSucceed(() => undefined))
          const channel = response === undefined ? undefined : decodeChannel(response.body)
          if (channel === undefined || channel._tag === "None") return undefined
          // A thread's name is a POST TITLE ("Crash on save"), not a channel handle — only
          // channels get the leading #.
          const label = channel.value.name == null ? undefined : THREAD_TYPES.has(channel.value.type) ? channel.value.name : `#${channel.value.name}`
          const meta: ChannelMeta = {
            ...(label === undefined ? {} : { title: label }),
            type: channel.value.type,
            ...(channel.value.parent_id == null ? {} : { parentID: channel.value.parent_id }),
          }
          channelMeta.set(channelID, meta)
          return meta
        })

      const queue = yield* Queue.unbounded<InboundEvent>()
      const rawCursor = yield* ctx.cursor.get().pipe(Effect.orElseSucceed(() => undefined))
      const stored = readCursor(rawCursor)
      // Per-channel catch-up anchors survive an invalid-session wipe (see readAnchors) — they are
      // what the REST backfill starts after so a laptop that slept doesn't drop its support channel.
      const anchors = new Map<string, string>(Object.entries(readAnchors(rawCursor)))
      let session: Cursor | undefined = stored
      let seq = stored?.seq ?? 0
      let acked = true

      // Dedup shared by the live pump and the reconnect backfill: a brief drop RESUMEs (gateway
      // replay) while backfill also runs, so the same message can arrive twice — deliver it once.
      const delivered = new Set<string>()
      const deliveredOrder: string[] = []
      const deliverOnce = (messageID: string): boolean => {
        if (delivered.has(messageID)) return false
        delivered.add(messageID)
        deliveredOrder.push(messageID)
        if (deliveredOrder.length > 2000) {
          const evicted = deliveredOrder.shift()
          if (evicted !== undefined) delivered.delete(evicted)
        }
        return true
      }

      const socketHolder: { current?: DiscordSocket } = {}
      const sendFrame = (frame: unknown) => Effect.sync(() => socketHolder.current?.send(JSON.stringify(frame)))

      // The frame pump rides callbacks → an inner queue, so the Effect side stays a plain loop.
      const frames = yield* Queue.unbounded<{ kind: "frame"; data: string } | { kind: "closed"; reason: string }>()
      const url = session?.resumeURL ?? GATEWAY_URL
      socketHolder.current = yield* Effect.tryPromise({
        try: () =>
          socketFactory(url, {
            onMessage: (data) => void Queue.offerUnsafe(frames, { kind: "frame", data }),
            onClose: (reason) => void Queue.offerUnsafe(frames, { kind: "closed", reason }),
          }),
        catch: (error) => new ConnectError({ reason: `Could not reach the Discord gateway: ${String(error)}` }),
      })
      yield* Effect.addFinalizer(() => Effect.sync(() => socketHolder.current?.close()))

      const heartbeat = (intervalMs: number) =>
        Effect.gen(function* () {
          while (true) {
            yield* Effect.sleep(Duration.millis(intervalMs))
            if (!acked) {
              // A missed ack means a zombie connection — surface and let backoff+resume recover.
              yield* Queue.offer(frames, { kind: "closed", reason: "heartbeat ack missed" })
              return
            }
            acked = false
            yield* sendFrame({ op: 1, d: seq === 0 ? null : seq })
          }
        })

      // Persist the resume state AND the anchors together; anchors are written even with no live
      // session (after an invalid-session wipe) so the next fresh connect can still catch up.
      const persistCursor = Effect.suspend(() =>
        ctx.cursor
          .set({
            ...(session === undefined ? {} : { sessionID: session.sessionID, seq, ...(session.resumeURL === undefined ? {} : { resumeURL: session.resumeURL }) }),
            anchors: Object.fromEntries(anchors),
          })
          .pipe(Effect.ignore),
      )

      // Deliver one normalized message, moving its channel anchor forward. Used by both the live
      // pump and the backfill so anchoring and dedup are identical on either path.
      const deliver = (message: typeof MessageCreate.Type, meta: ChannelMeta | undefined) =>
        Effect.gen(function* () {
          anchors.set(message.channel_id, message.id) // anchor on EVERY message (incl. our own) so we never refetch it
          if (!deliverOnce(message.id)) return
          yield* Queue.offer(queue, toInbound(message, selfID, meta))
        })

      // Reconnect catch-up: Discord replays nothing a bot missed while disconnected, so on a FRESH
      // identify (no resume session) we pull each known channel's messages since its anchor and feed
      // them through as if they had arrived live — oldest first. Poll-based drivers get this for
      // free; a push driver must do it by hand or a sleeping instance silently loses messages.
      const backfill = Effect.gen(function* () {
        for (const [channelID, afterID] of [...anchors.entries()]) {
          const response = yield* rest(`/channels/${channelID}/messages?after=${afterID}&limit=${BACKFILL_PAGE}`).pipe(
            Effect.orElseSucceed(() => undefined),
          )
          if (response === undefined || response.status >= 400) continue
          const decoded = decodeMessages(response.body)
          if (decoded._tag === "None" || decoded.value.length === 0) continue
          const meta = yield* describeChannel(channelID, false)
          // Discord returns newest-first; replay chronologically so threads read in order.
          for (const message of [...decoded.value].reverse()) yield* deliver(message, meta)
          yield* persistCursor
          if (decoded.value.length >= BACKFILL_PAGE)
            yield* Effect.logInfo(`discord: caught up ${BACKFILL_PAGE}+ missed messages in ${channelID}; older ones beyond the page were skipped`)
        }
      })
      // Only on a fresh identify: a RESUME already replays the gap through the gateway, and running
      // both would double-deliver (the dedup set guards the overlap, but skipping the REST burst
      // when it isn't needed is cheaper and kinder to the rate limit).
      if (stored === undefined && anchors.size > 0) yield* Effect.forkScoped(backfill.pipe(Effect.catchCause(() => Effect.void)))

      const pump = Effect.gen(function* () {
        while (true) {
          const item = yield* Queue.take(frames)
          if (item.kind === "closed")
            return yield* Effect.fail(new ConnectError({ reason: `Discord gateway closed: ${item.reason}` }))
          const frame = decodeFrame(JSON.parse(item.data) as unknown)
          if (frame._tag === "None") continue
          const { op, d, t } = frame.value
          if (typeof frame.value.s === "number") seq = frame.value.s
          switch (op) {
            case 10: {
              const hello = decodeHello(d)
              if (hello._tag === "Some") yield* Effect.forkScoped(heartbeat(hello.value.heartbeat_interval).pipe(Effect.ignore))
              acked = true
              if (session !== undefined) {
                yield* sendFrame({ op: 6, d: { token, session_id: session.sessionID, seq } })
              } else {
                yield* sendFrame({
                  op: 2,
                  d: {
                    token,
                    intents: INTENTS,
                    properties: { os: "novaclaw", browser: "novaclaw", device: "novaclaw" },
                  },
                })
              }
              continue
            }
            case 1:
              yield* sendFrame({ op: 1, d: seq === 0 ? null : seq })
              continue
            case 11:
              acked = true
              continue
            case 7:
              // The server asks us to reconnect — end cleanly; backoff + RESUME pick it up.
              return yield* Effect.fail(new ConnectError({ reason: "Discord asked to reconnect (resumable)" }))
            case 9:
              // Invalid session: drop the resume state but KEEP the catch-up anchors — the next
              // fresh identify uses them to backfill exactly the messages this gap would have lost.
              session = undefined
              yield* persistCursor
              return yield* Effect.fail(new ConnectError({ reason: "Discord session invalidated — re-identifying" }))
            case 0: {
              if (t === "READY") {
                const ready = decodeReady(d)
                if (ready._tag === "Some") {
                  session = {
                    sessionID: ready.value.session_id,
                    seq,
                    ...(ready.value.resume_gateway_url === undefined ? {} : { resumeURL: ready.value.resume_gateway_url }),
                  }
                  yield* persistCursor
                }
                continue
              }
              if (t === "MESSAGE_CREATE") {
                const message = decodeMessageCreate(d)
                if (message._tag === "Some") {
                  const meta = yield* describeChannel(message.value.channel_id, message.value.guild_id === undefined)
                  yield* deliver(message.value, meta)
                  yield* persistCursor
                }
                continue
              }
              continue
            }
            default:
              continue
          }
        }
      })
      yield* Effect.forkScoped(pump.pipe(Effect.catchCause(() => Queue.shutdown(queue))))

      const send = (chatID: string, message: { text?: string; file?: OutboundFile; replyTo?: string }) =>
        Effect.gen(function* () {
          // Reply reference: in a channel with a dozen people talking, an unattached answer is
          // noise. `fail_if_not_exists: false` so a deleted question still gets its answer posted
          // (a hard failure would swallow the reply entirely).
          const reference =
            message.replyTo === undefined ? {} : { message_reference: { message_id: message.replyTo, fail_if_not_exists: false } }
          const post = (body: RequestInit) =>
            rest(`/channels/${chatID}/messages`, { method: "POST", ...body }).pipe(
              Effect.mapError((error) => new SendError({ reason: error.reason, retryable: true })),
              Effect.flatMap((response) =>
                response.status >= 400
                  ? Effect.fail(
                      new SendError({
                        reason: `Discord refused the message (${response.status}${
                          typeof (response.body as { message?: unknown })?.message === "string"
                            ? `: ${(response.body as { message: string }).message}`
                            : ""
                        })`,
                        retryable: response.status === 429 || response.status >= 500,
                      }),
                    )
                  : Effect.succeed(response),
              ),
            )
          if (message.file !== undefined) {
            const form = new FormData()
            form.set(
              "payload_json",
              JSON.stringify({
                ...(message.text !== undefined && message.text.length > 0 ? { content: message.text.slice(0, 2000) } : {}),
                ...reference,
              }),
            )
            form.set("files[0]", new Blob([message.file.data as BlobPart], { type: message.file.mime }), message.file.name)
            const response = yield* post({ body: form })
            const sent = decodeSent(response.body)
            return { messageID: sent._tag === "Some" ? sent.value.id : "0" }
          }
          if (message.text === undefined || message.text.length === 0) return { messageID: "0" }
          const chunks = MessengerFormat.chunk(MessengerFormat.downgrade(message.text, "markdown"), {
            maxChars: CAPS.maxChars,
          })
          let lastID = "0"
          let first = true
          for (const chunk of chunks) {
            // Only the first chunk quotes the question — a reply chain of five quotes reads awful.
            const response = yield* post({
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ content: chunk, ...(first ? reference : {}) }),
            })
            first = false
            const sent = decodeSent(response.body)
            if (sent._tag === "Some") lastID = sent.value.id
          }
          return { messageID: lastID }
        })

      // Read a channel's recent posts. Discord replays nothing on demand through the gateway, so this is
      // plain REST — the same endpoint the reconnect backfill uses, just caller-driven.
      //
      // This is what makes the module usable as a RESEARCH SOURCE (todo.md → messenger as a research
      // source): a studio's #announcements channel is often where a release lands first, and its web page
      // is unreadable, so an agent needs to read it HERE. Without `history` the agent could only LIST
      // channels and never see a post — it had the menu and no food.
      const history = (chatID: string, limit: number) =>
        Effect.gen(function* () {
          // Discord caps a page at 100; ask for what the caller wants within that.
          const want = Math.min(Math.max(1, Math.trunc(limit)), 100)
          const response = yield* rest(`/channels/${chatID}/messages?limit=${want}`)
          if (response.status >= 400)
            return yield* Effect.fail(
              new ConnectError({
                reason:
                  response.status === 403
                    ? `Discord denied reading channel ${chatID} (the bot needs View Channel + Read Message History there).`
                    : `Discord history for ${chatID} failed: HTTP ${response.status}`,
              }),
            )
          const decoded = decodeMessages(response.body)
          if (decoded._tag === "None") return [] as HistoryEntry[]
          // Discord returns newest-first; the driver contract is oldest-first so a channel reads in order.
          return [...decoded.value].reverse().map(
            (message): HistoryEntry => ({
              messageID: message.id,
              senderID: message.author.id,
              senderName: authorName(message.author),
              outgoing: selfID !== undefined && message.author.id === selfID,
              ...(message.content === undefined || message.content === "" ? {} : { text: message.content }),
              at: message.timestamp === undefined ? 0 : Date.parse(message.timestamp),
            }),
          )
        })

      const listChats = () =>
        Effect.gen(function* () {
          const out: ChatSnapshot[] = []
          const guildsResponse = yield* rest("/users/@me/guilds")
          const guilds = decodeGuilds(guildsResponse.body)
          if (guilds._tag === "None") return out
          for (const guild of guilds.value.slice(0, 20)) {
            const channelsResponse = yield* rest(`/guilds/${guild.id}/channels`).pipe(Effect.orElseSucceed(() => undefined))
            const channels = channelsResponse === undefined ? undefined : decodeChannels(channelsResponse.body)
            if (channels !== undefined && channels._tag === "Some")
              for (const channel of channels.value) {
                if (!LISTABLE_TYPES.has(channel.type) || channel.name == null) continue // no voice/categories
                const kind = chatKindOf(channel.type, false)
                // A forum is where support posts LAND, so say so — binding it covers every post.
                const what = channel.type === CHANNEL_FORUM || channel.type === CHANNEL_MEDIA ? " · forum" : ""
                channelMeta.set(channel.id, {
                  title: `#${channel.name}`,
                  type: channel.type,
                  ...(channel.parent_id == null ? {} : { parentID: channel.parent_id }),
                })
                out.push({ chatID: channel.id, kind, title: `#${channel.name} (${guild.name}${what})` })
              }
            // Live threads (every open forum post is one). They route to their parent's binding,
            // but they're listed so an operator can bind or read a single conversation.
            const threadsResponse = yield* rest(`/guilds/${guild.id}/threads/active`).pipe(Effect.orElseSucceed(() => undefined))
            const threads = threadsResponse === undefined ? undefined : decodeActiveThreads(threadsResponse.body)
            if (threads === undefined || threads._tag === "None") continue
            for (const thread of threads.value.threads) {
              if (thread.name == null) continue
              const parentID = thread.parent_id ?? undefined
              const parent = parentID === undefined ? undefined : channelMeta.get(parentID)?.title
              channelMeta.set(thread.id, {
                title: thread.name,
                type: thread.type,
                ...(parentID === undefined ? {} : { parentID }),
              })
              out.push({
                chatID: thread.id,
                kind: "thread",
                title: `${thread.name} (${parent === undefined ? guild.name : `${parent} · ${guild.name}`})`,
                ...(parentID === undefined ? {} : { parentID }),
              })
            }
          }
          return out
        })

      const downloadFile = (ref: FileRef) =>
        Effect.tryPromise({
          // Attachment refs carry the CDN url as the id — a plain unauthenticated fetch.
          try: () =>
            fetchImpl(ref.id).then(async (response) => {
              if (!response.ok) throw new Error(`HTTP ${response.status}`)
              return new Uint8Array(await response.arrayBuffer())
            }),
          catch: (error) => new FileError({ reason: `Discord attachment download failed: ${String(error)}` }),
        })

      // Moderation (the account's bot needs the matching permissions; a 403 comes back legible).
      // delete/pin act on the channel; ban/kick/mute act on a GUILD MEMBER, so resolve the
      // channel's guild first (a DM channel has none — a legible refusal, not a crash).
      const moderate = (chatID: string, act: ModerationAct) =>
        Effect.gen(function* () {
          const call = (route: string, init: RequestInit) =>
            rest(route, init).pipe(
              Effect.mapError((error) => new ModerationError({ reason: error.reason })),
              Effect.flatMap((response) =>
                response.status >= 400
                  ? Effect.fail(
                      new ModerationError({
                        reason: `Discord refused (${response.status}${
                          typeof (response.body as { message?: unknown })?.message === "string"
                            ? `: ${(response.body as { message: string }).message}`
                            : ""
                        })`,
                      }),
                    )
                  : Effect.void,
              ),
            )
          const guildID = Effect.gen(function* () {
            const response = yield* rest(`/channels/${chatID}`).pipe(Effect.mapError((error) => new ModerationError({ reason: error.reason })))
            const gid = (response.body as { guild_id?: unknown })?.guild_id
            if (typeof gid !== "string")
              return yield* Effect.fail(new ModerationError({ reason: "That chat isn't in a server — ban/kick/mute need a server channel." }))
            return gid
          })
          switch (act.act) {
            case "delete":
              return yield* call(`/channels/${chatID}/messages/${act.messageID}`, { method: "DELETE" })
            case "pin":
              return yield* call(`/channels/${chatID}/pins/${act.messageID}`, { method: "PUT" })
            case "ban": {
              // Discord bans are permanent; a "ban for 7 days" would silently become forever.
              if (act.durationDays !== undefined)
                return yield* Effect.fail(
                  new ModerationError({
                    reason: "Discord has no temporary ban — ban permanently, or time the member out (mute) for a while instead.",
                  }),
                )
              // A spam wave needs the posts gone too, not just the account — Discord deletes the
              // member's messages from the last N seconds (max 7 days) on the ban itself.
              const purge = act.purgeSeconds === undefined ? undefined : Math.max(0, Math.min(Math.floor(act.purgeSeconds), 7 * 24 * 3600))
              return yield* call(`/guilds/${yield* guildID}/bans/${act.userID}`, {
                method: "PUT",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(purge === undefined ? {} : { delete_message_seconds: purge }),
              })
            }
            case "kick":
              return yield* call(`/guilds/${yield* guildID}/members/${act.userID}`, { method: "DELETE" })
            case "lock":
              // Discord locks THREADS (a resolved support post); a whole channel is closed with
              // permissions, which is a server-config act, not a moderation one.
              return yield* call(`/channels/${chatID}`, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ locked: true }),
              })
            case "approve":
              return yield* Effect.fail(
                new ModerationError({ reason: "Discord has no approval queue — messages are live until deleted." }),
              )
            case "mute": {
              // Discord "timeout": communication_disabled_until, capped at 28 days.
              const seconds = Math.max(1, Math.min(act.seconds ?? 600, 28 * 24 * 3600))
              const until = new Date(Date.now() + seconds * 1000).toISOString()
              return yield* call(`/guilds/${yield* guildID}/members/${act.userID}`, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ communication_disabled_until: until }),
              })
            }
          }
        })

      return {
        inbound: Stream.fromQueue(queue),
        send,
        listChats,
        history,
        downloadFile,
        moderate,
      } satisfies Connection
    }),
})

/** The production socket factory over the platform WebSocket. */
export const socketFactory: DiscordSocketFactory = async (url, handlers) => {
  const socket = new WebSocket(url)
  socket.addEventListener("message", (event) => {
    if (typeof event.data === "string") handlers.onMessage(event.data)
  })
  socket.addEventListener("close", (event) => handlers.onClose(`code ${event.code}`))
  socket.addEventListener("error", () => handlers.onClose("socket error"))
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve(), { once: true })
    socket.addEventListener("error", () => reject(new Error("websocket connect failed")), { once: true })
  })
  return {
    send: (data) => socket.send(data),
    close: () => socket.close(),
  }
}

/** The default production driver. */
export const driver: Driver = make((url, init) => fetch(url, init), socketFactory)
