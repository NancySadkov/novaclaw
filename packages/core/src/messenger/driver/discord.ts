export * as DiscordDriver from "./discord"

import { Duration, Effect, Queue, Schema, Stream } from "effect"
import { Messenger } from "@novaclaw/schema/messenger"
import { MessengerFormat } from "../format"
import type { ChatSnapshot, Connection, ConnectContext, Driver, FileRef, InboundEvent, OutboundFile } from "../driver"
import { ConnectError, FileError, SendError } from "../driver"

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

const CAPS: Messenger.Capabilities = {
  listChats: "full", // guilds → text channels; DMs join via the seen-cache
  files: { up: true, down: true, maxBytes: 8_000_000 },
  edits: true,
  typing: true,
  threads: true,
  moderation: { delete: true, ban: true, kick: true, mute: true, pin: true },
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
})
const SentMessage = Schema.Struct({ id: Schema.String })

const decodeFrame = Schema.decodeUnknownOption(Frame)
const decodeHello = Schema.decodeUnknownOption(Hello)
const decodeReady = Schema.decodeUnknownOption(Ready)
const decodeMessageCreate = Schema.decodeUnknownOption(MessageCreate)
const decodeMe = Schema.decodeUnknownOption(Me)
const decodeGuilds = Schema.decodeUnknownOption(Schema.Array(Guild))
const decodeChannels = Schema.decodeUnknownOption(Schema.Array(Channel))
const decodeChannel = Schema.decodeUnknownOption(Channel)
const decodeSent = Schema.decodeUnknownOption(SentMessage)

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

const authorName = (author: typeof Author.Type): string => author.global_name ?? author.username ?? author.id

/** Normalize one MESSAGE_CREATE. Channel titles come from the caller's name cache (the gateway
 *  event carries none). */
export const toInbound = (
  message: typeof MessageCreate.Type,
  selfID: string | undefined,
  channelTitle: string | undefined,
): InboundEvent => {
  const dm = message.guild_id === undefined
  const chat: ChatSnapshot = {
    chatID: message.channel_id,
    kind: dm ? "dm" : "group",
    title: channelTitle ?? (dm ? authorName(message.author) : `#${message.channel_id}`),
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

      // Lazily learned channel titles (the gateway events carry ids only).
      const channelNames = new Map<string, string>()
      const channelTitle = (channelID: string, dm: boolean) =>
        Effect.gen(function* () {
          if (dm) return undefined
          const known = channelNames.get(channelID)
          if (known !== undefined) return known
          const response = yield* rest(`/channels/${channelID}`).pipe(Effect.orElseSucceed(() => undefined))
          const channel = response === undefined ? undefined : decodeChannel(response.body)
          const name = channel !== undefined && channel._tag === "Some" && channel.value.name != null ? `#${channel.value.name}` : undefined
          if (name !== undefined) channelNames.set(channelID, name)
          return name
        })

      const queue = yield* Queue.unbounded<InboundEvent>()
      const stored = readCursor(yield* ctx.cursor.get().pipe(Effect.orElseSucceed(() => undefined)))
      let session: Cursor | undefined = stored
      let seq = stored?.seq ?? 0
      let acked = true

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

      const persistCursor = Effect.suspend(() =>
        session === undefined ? Effect.void : ctx.cursor.set({ ...session, seq }).pipe(Effect.ignore),
      )

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
              // Invalid session: drop the resume state; the next attempt identifies fresh.
              session = undefined
              yield* ctx.cursor.set(undefined).pipe(Effect.ignore)
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
                  const title = yield* channelTitle(message.value.channel_id, message.value.guild_id === undefined)
                  yield* Queue.offer(queue, toInbound(message.value, selfID, title))
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

      const send = (chatID: string, message: { text?: string; file?: OutboundFile }) =>
        Effect.gen(function* () {
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
              JSON.stringify(message.text !== undefined && message.text.length > 0 ? { content: message.text.slice(0, 2000) } : {}),
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
          for (const chunk of chunks) {
            const response = yield* post({
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ content: chunk }),
            })
            const sent = decodeSent(response.body)
            if (sent._tag === "Some") lastID = sent.value.id
          }
          return { messageID: lastID }
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
            if (channels === undefined || channels._tag === "None") continue
            for (const channel of channels.value) {
              if (channel.type !== 0 || channel.name == null) continue // text channels only
              const title = `#${channel.name} (${guild.name})`
              channelNames.set(channel.id, `#${channel.name}`)
              out.push({ chatID: channel.id, kind: "group", title })
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

      return {
        inbound: Stream.fromQueue(queue),
        send,
        listChats,
        downloadFile,
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
