export * as TelegramDriver from "./telegram"

import { Effect, Queue, Schema, Stream } from "effect"
import { Messenger } from "@novaclaw/schema/messenger"
import { MessengerFormat } from "../format"
import type { ChatSnapshot, Connection, ConnectContext, Driver, FileRef, InboundEvent, OutboundFile } from "../driver"
import { ConnectError, FileError, SendError } from "../driver"

// The Telegram BOT-API driver (messenger-plan §2.1): raw HTTPS/JSON, zero dependencies — the
// fakeable Telegram protocol that proves the whole gateway pipeline + the `key` auth path.
// (The production user-account path is MTProto behind a client library — a separate driver gated
// by the §2.2 owner decision; the gateway pipeline it rides is identical.)
//
// getUpdates long-poll: NAT-friendly (the instance dials out; no inbound webhook). The offset
// cursor is durable (ConnectContext.cursor) so a restart resumes without double-delivering —
// Telegram drops acknowledged updates once we ask for offset = last_update_id + 1.

const API_BASE = "https://api.telegram.org"
const LONG_POLL_SECONDS = 25
const CAPS: Messenger.Capabilities = {
  listChats: "seen", // bots cannot enumerate their chats; the gateway's seen-cache is the list.
  files: { up: true, down: true, maxBytes: 20_000_000 },
  edits: true,
  typing: true,
  threads: false,
  moderation: { delete: true, ban: true, kick: true, mute: true, pin: true },
  format: "html", // we send HTML (escape-first is injection-safe); markdown downgrades to it.
  maxChars: 4096,
}

/** The subset of the Bot API we decode. Telegram sends much more; unknown fields are ignored. */
const TgChat = Schema.Struct({
  id: Schema.Number,
  type: Schema.String, // "private" | "group" | "supergroup" | "channel"
  title: Schema.optional(Schema.String),
  username: Schema.optional(Schema.String),
  first_name: Schema.optional(Schema.String),
})
const TgUser = Schema.Struct({
  id: Schema.Number,
  is_bot: Schema.optional(Schema.Boolean),
  first_name: Schema.optional(Schema.String),
  username: Schema.optional(Schema.String),
})
const TgDocument = Schema.Struct({
  file_id: Schema.String,
  file_name: Schema.optional(Schema.String),
  mime_type: Schema.optional(Schema.String),
  file_size: Schema.optional(Schema.Number),
})
const TgPhotoSize = Schema.Struct({
  file_id: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
  file_size: Schema.optional(Schema.Number),
})
const TgMessage = Schema.Struct({
  message_id: Schema.Number,
  from: Schema.optional(TgUser),
  chat: TgChat,
  date: Schema.Number,
  text: Schema.optional(Schema.String),
  caption: Schema.optional(Schema.String),
  document: Schema.optional(TgDocument),
  photo: Schema.optional(Schema.Array(TgPhotoSize)),
  reply_to_message: Schema.optional(Schema.Struct({ message_id: Schema.Number })),
})
const TgFile = Schema.Struct({
  file_id: Schema.String,
  file_path: Schema.optional(Schema.String),
})
const TgUpdate = Schema.Struct({
  update_id: Schema.Number,
  message: Schema.optional(TgMessage),
})
const TgResponse = <A, I>(result: Schema.Codec<A, I>) =>
  Schema.Struct({ ok: Schema.Boolean, result: Schema.optional(result), description: Schema.optional(Schema.String) })
const UpdatesResponse = TgResponse(Schema.Array(TgUpdate))
const MessageResponse = TgResponse(TgMessage)
const GetMeResponse = TgResponse(TgUser)
const FileResponse = TgResponse(TgFile)

const decodeUpdates = Schema.decodeUnknownOption(UpdatesResponse)
const decodeMessage = Schema.decodeUnknownOption(MessageResponse)
const decodeGetMe = Schema.decodeUnknownOption(GetMeResponse)
const decodeFile = Schema.decodeUnknownOption(FileResponse)

type TgMessageType = typeof TgMessage.Type

/** A caller-injected fetch — production passes `globalThis.fetch`; tests pass a fake Bot API. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

const chatKind = (type: string): Messenger.ChatKind =>
  type === "private" ? "dm" : type === "channel" ? "channel" : "group"

const chatTitle = (chat: typeof TgChat.Type): string =>
  chat.title ?? chat.username ?? chat.first_name ?? String(chat.id)

const senderName = (from: typeof TgUser.Type | undefined): string =>
  from?.username ?? from?.first_name ?? (from ? String(from.id) : "unknown")

/** Map one Telegram message to the normalized inbound event. `isSelf` needs our own bot id. */
export const toInbound = (message: TgMessageType, selfID: number | undefined): InboundEvent => {
  const chat: ChatSnapshot = {
    chatID: String(message.chat.id),
    kind: chatKind(message.chat.type),
    title: chatTitle(message.chat),
  }
  // A photo update carries every size — the LAST entry is the biggest (Bot API contract).
  const photo = message.photo?.at(-1)
  const attachments: FileRef[] | undefined = message.document
    ? [
        {
          id: message.document.file_id,
          ...(message.document.file_name === undefined ? {} : { name: message.document.file_name }),
          ...(message.document.mime_type === undefined ? {} : { mime: message.document.mime_type }),
          ...(message.document.file_size === undefined ? {} : { size: message.document.file_size }),
        },
      ]
    : photo
      ? [
          {
            id: photo.file_id,
            name: `photo-${message.message_id}.jpg`,
            mime: "image/jpeg",
            ...(photo.file_size === undefined ? {} : { size: photo.file_size }),
          },
        ]
      : undefined
  return {
    kind: "message",
    chat,
    messageID: String(message.message_id),
    sender: {
      id: message.from ? String(message.from.id) : "unknown",
      name: senderName(message.from),
      isSelf: selfID !== undefined && message.from?.id === selfID,
    },
    ...(message.text ?? message.caption ? { text: message.text ?? message.caption } : {}),
    ...(attachments ? { attachments } : {}),
    ...(message.reply_to_message ? { replyTo: String(message.reply_to_message.message_id) } : {}),
    at: message.date * 1000,
  }
}

export const make = (fetchImpl: FetchLike): Driver => ({
  id: "telegram",
  meta: {
    id: "telegram",
    name: "Telegram (bot)",
    icon: "speech-bubble",
    auth: "key",
    settings: [],
    // The same teaching duty as Discord, but Telegram makes it short — the one trap worth naming
    // is group privacy mode, which hides ordinary messages from bots and looks like deafness.
    setup: {
      url: "https://t.me/BotFather",
      urlLabel: "Open BotFather in Telegram",
      steps: [
        "Send /newbot to BotFather and answer its two questions (a display name, then a username ending in bot).",
        "It replies with a token that looks like 123456:ABC… — paste that below.",
        "If the bot should work in a GROUP, send /setprivacy to BotFather, pick your bot and choose Disable — otherwise Telegram hides ordinary group messages from it and it will seem to ignore everyone.",
        "Message your new bot once from your own Telegram so NovaClaw can see the chat (bots cannot list conversations they have never received a message in).",
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

      const call = (method: string, body?: unknown) =>
        Effect.tryPromise({
          try: () =>
            fetchImpl(`${API_BASE}/bot${token}/${method}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }).then((response) => response.json()),
          catch: (error) => new ConnectError({ reason: `Telegram ${method} failed: ${String(error)}` }),
        })

      // Identify ourselves so echo-suppression works (getMe → our bot user id). getMe doubles as
      // the TOKEN GATE: Telegram answers ok:false (401) for a bad/revoked token — failing here is
      // honest and legible, where the old tolerate-everything path left the account "connected"
      // while silently polling 401s forever (found by the P2 settings walkthrough with a fake
      // token). A TRANSPORT miss (network blip) stays tolerated — the poll loop owns retries.
      const me = decodeGetMe(yield* call("getMe").pipe(Effect.orElseSucceed(() => undefined)))
      if (me._tag === "Some" && me.value.ok === false)
        return yield* Effect.fail(
          new ConnectError({
            reason:
              `Telegram rejected this bot token` +
              (me.value.description ? ` (${me.value.description})` : "") +
              ` — check it in Settings → Messengers.`,
          }),
        )
      const selfID = me._tag === "Some" && me.value.result ? me.value.result.id : undefined

      const send = (chatID: string, message: { text?: string; file?: OutboundFile; replyTo?: string }) =>
        Effect.gen(function* () {
          if (message.file !== undefined) {
            // sendDocument is multipart (the file bytes ride the form); text rides as the caption.
            const form = new FormData()
            form.set("chat_id", chatID)
            form.set("document", new Blob([message.file.data as BlobPart], { type: message.file.mime }), message.file.name)
            if (message.text !== undefined && message.text.length > 0) form.set("caption", message.text.slice(0, 1024))
            const raw = yield* Effect.tryPromise({
              try: () => fetchImpl(`${API_BASE}/bot${token}/sendDocument`, { method: "POST", body: form }).then((r) => r.json()),
              catch: (error) => new SendError({ reason: `Telegram sendDocument failed: ${String(error)}`, retryable: true }),
            })
            const decoded = decodeMessage(raw)
            if (decoded._tag === "Some" && decoded.value.ok === false)
              return yield* Effect.fail(
                new SendError({ reason: decoded.value.description ?? "sendDocument rejected", retryable: false }),
              )
            return {
              messageID: decoded._tag === "Some" && decoded.value.result ? String(decoded.value.result.message_id) : "0",
            }
          }
          if (message.text === undefined || message.text.length === 0) return { messageID: "0" }
          const chunks = MessengerFormat.chunk(MessengerFormat.downgrade(message.text, "html"), { maxChars: CAPS.maxChars })
          let lastID = "0"
          for (const [index, chunk] of chunks.entries()) {
            const raw = yield* call("sendMessage", {
              chat_id: Number(chatID),
              text: chunk,
              parse_mode: "HTML",
              ...(index === 0 && message.replyTo ? { reply_to_message_id: Number(message.replyTo) } : {}),
            }).pipe(Effect.mapError((error) => new SendError({ reason: error.reason, retryable: true })))
            const decoded = decodeMessage(raw)
            if (decoded._tag === "Some" && decoded.value.ok === false)
              return yield* Effect.fail(
                new SendError({ reason: decoded.value.description ?? "sendMessage rejected", retryable: false }),
              )
            if (decoded._tag === "Some" && decoded.value.result) lastID = String(decoded.value.result.message_id)
          }
          return { messageID: lastID }
        })

      // The long-poll loop: getUpdates(offset) → emit → advance the durable offset. The stream is
      // scoped; closing it ends the loop. Failures propagate to the gateway's backoff.
      const queue = yield* Queue.unbounded<InboundEvent>()
      const stored = yield* ctx.cursor.get().pipe(Effect.orElseSucceed(() => undefined))
      let offset = typeof stored === "number" ? stored : 0

      const pump = Effect.gen(function* () {
        while (true) {
          const raw = yield* call("getUpdates", { offset, timeout: LONG_POLL_SECONDS, allowed_updates: ["message"] })
          const decoded = decodeUpdates(raw)
          if (decoded._tag === "None") {
            yield* Effect.sleep("1 second")
            continue
          }
          if (decoded.value.ok === false) {
            // The API REFUSED (revoked token mid-run, or another instance stole the long-poll —
            // edge #16): end the connection instead of spinning silently; the gateway's backoff +
            // reconnect owns recovery, and the reconnect's getMe gate surfaces the legible reason.
            return yield* Effect.fail(
              new ConnectError({ reason: `Telegram getUpdates refused: ${decoded.value.description ?? "unknown error"}` }),
            )
          }
          const batch = decoded.value.result ?? []
          for (const update of batch) {
            offset = update.update_id + 1
            if (update.message) yield* Queue.offer(queue, toInbound(update.message, selfID))
          }
          if (batch.length > 0) {
            // Ack by persisting the advanced offset only after the batch is enqueued (at-least-once).
            yield* ctx.cursor.set(offset).pipe(Effect.ignore)
          } else {
            // A well-behaved server held the connection for `timeout` seconds; a misbehaving proxy
            // may return empty instantly — this small pause caps any such spin without adding real
            // latency to genuine long-polls.
            yield* Effect.sleep("500 millis")
          }
        }
      })

      yield* Effect.forkScoped(
        pump.pipe(
          Effect.catchCause(() => Queue.shutdown(queue)),
        ),
      )

      // getFile → file_path → the file endpoint (a separate URL space from method calls).
      const downloadFile = (ref: FileRef) =>
        Effect.gen(function* () {
          const raw = yield* call("getFile", { file_id: ref.id }).pipe(
            Effect.mapError((error) => new FileError({ reason: error.reason })),
          )
          const decoded = decodeFile(raw)
          if (decoded._tag === "None" || decoded.value.ok === false || decoded.value.result?.file_path === undefined)
            return yield* Effect.fail(
              new FileError({
                reason:
                  decoded._tag === "Some" && decoded.value.description
                    ? `Telegram refused the download: ${decoded.value.description}`
                    : "Telegram did not return a download path for that file (bots can only fetch files up to 20 MB).",
              }),
            )
          return yield* Effect.tryPromise({
            try: () =>
              fetchImpl(`${API_BASE}/file/bot${token}/${decoded.value.result!.file_path}`).then(async (response) => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`)
                return new Uint8Array(await response.arrayBuffer())
              }),
            catch: (error) => new FileError({ reason: `Telegram file download failed: ${String(error)}` }),
          })
        })

      return {
        inbound: Stream.fromQueue(queue),
        send,
        downloadFile,
      } satisfies Connection
    }),
})

/** The default production driver, bound to the real global fetch. */
export const driver: Driver = make((url, init) => fetch(url, init))
