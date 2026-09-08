export * as TelegramDriver from "./telegram"

import { Effect, Queue, Schema, Stream } from "effect"
import { Messenger } from "@novaclaw/schema/messenger"
import type {
  ChatSnapshot,
  Connection,
  ConnectContext,
  Driver,
  FileRef,
  InboundEvent,
  ModerationAct,
  OutboundFile,
} from "../driver"
import { ConnectError, FileError, ModerationError, SendError } from "../driver"

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
  threads: false,
  // Each of these five is a promise the layer above plans against, and each is kept by `moderate`
  // in the returned Connection. `approve`/`lock` are absent because this driver does not do them —
  // a flag may only ever say what the code does.
  moderation: { delete: true, ban: true, kick: true, mute: true, pin: true },
  format: "html", // we send HTML (escape-first is injection-safe); markdown downgrades to it.
  maxChars: 4096,
}

/** A muted member's ChatPermissions: every way of putting content in the chat, off. Telegram treats
 *  an omitted field as `false`, but naming them keeps the intent readable at the call site. */
const MUTED_PERMISSIONS = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
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

/** Every Bot API method answers the same envelope; the moderation methods return only `ok`. */
const AckResponse = Schema.Struct({ ok: Schema.Boolean, description: Schema.optional(Schema.String) })

const decodeUpdates = Schema.decodeUnknownOption(UpdatesResponse)
const decodeAck = Schema.decodeUnknownOption(AckResponse)
const decodeMessage = Schema.decodeUnknownOption(MessageResponse)
const decodeGetMe = Schema.decodeUnknownOption(GetMeResponse)
const decodeFile = Schema.decodeUnknownOption(FileResponse)

type TgMessageType = typeof TgMessage.Type

/** A caller-injected fetch — production passes `globalThis.fetch`; tests pass a fake Bot API. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

const chatKind = (type: string): Messenger.ChatKind =>
  type === "private" ? "dm" : type === "channel" ? "channel" : "group"

/** Telegram's PROPOSAL (ruling 7). A `private` chat is a DM, i.e. correspondence — the one thing the
 *  Bot API states outright. A broadcast `channel` or a supergroup may be world-readable or strictly
 *  invite-only and the update payload does not say which, so the honest proposal is `unknown`; a
 *  `public` guess here would quietly authorise quoting a closed channel into a research report. */
const proposeAccess = (type: string): Messenger.SourceAccess => (type === "private" ? "private" : "unknown")

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
    proposedAccess: proposeAccess(message.chat.type),
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
    ...((message.text ?? message.caption) ? { text: message.text ?? message.caption } : {}),
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
          try: (signal) =>
            fetchImpl(`${API_BASE}/bot${token}/${method}`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              signal,
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
            form.set(
              "document",
              new Blob([message.file.data as BlobPart], { type: message.file.mime }),
              message.file.name,
            )
            if (message.text !== undefined && message.text.length > 0) form.set("caption", message.text.slice(0, 1024))
            const raw = yield* Effect.tryPromise({
              try: (signal) =>
                fetchImpl(`${API_BASE}/bot${token}/sendDocument`, { method: "POST", body: form, signal }).then((r) =>
                  r.json(),
                ),
              catch: (error) =>
                new SendError({ reason: `Telegram sendDocument failed: ${String(error)}`, retryable: true }),
            })
            const decoded = decodeMessage(raw)
            if (decoded._tag === "Some" && decoded.value.ok === false)
              return yield* Effect.fail(
                new SendError({ reason: decoded.value.description ?? "sendDocument rejected", retryable: false }),
              )
            return {
              messageID:
                decoded._tag === "Some" && decoded.value.result ? String(decoded.value.result.message_id) : "0",
            }
          }
          if (message.text === undefined || message.text.length === 0) return { messageID: "0" }
          const raw = yield* call("sendMessage", {
            chat_id: Number(chatID),
            text: message.text,
            parse_mode: "HTML",
            ...(message.replyTo ? { reply_to_message_id: Number(message.replyTo) } : {}),
          }).pipe(Effect.mapError((error) => new SendError({ reason: error.reason, retryable: true })))
          const decoded = decodeMessage(raw)
          if (decoded._tag === "Some" && decoded.value.ok === false)
            return yield* Effect.fail(
              new SendError({ reason: decoded.value.description ?? "sendMessage rejected", retryable: false }),
            )
          return {
            messageID: decoded._tag === "Some" && decoded.value.result ? String(decoded.value.result.message_id) : "0",
          }
        })

      // The long-poll loop: getUpdates(offset) → emit → advance the durable offset. The stream is
      // scoped; closing it ends the loop. Failures propagate to the gateway's backoff.
      const queue = yield* Queue.unbounded<InboundEvent, ConnectError>()
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
              new ConnectError({
                reason: `Telegram getUpdates refused: ${decoded.value.description ?? "unknown error"}`,
              }),
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

      /**
       * 🔴 **The poll loop's death has to reach the STREAM, and `Queue.shutdown` does not carry it.**
       * `shutdown` interrupts the queue, so the gateway's consumer is INTERRUPTED rather than failed
       * — and an interrupt is not on the error channel, so the reconnect ladder's catch never sees
       * it and the whole connection fiber dies. The account is then pinned at `connected` with
       * nothing behind it: no backoff, no reconnect, no banner. The one case that gets here is the
       * `getUpdates refused` branch above (a token revoked mid-run, or another instance stealing the
       * long-poll), and it is exactly the case that must be visible.
       *
       * `Queue.fail` puts the reason on the stream, which is what `Connection.inbound` promises: the
       * stream failing sends the gateway to backoff + reconnect, where the `getMe` gate reports the
       * legible cause. `catchCause` still covers a DEFECT — not a reason anyone can act on, and not
       * something to dress up as one.
       */
      yield* Effect.forkScoped(
        pump.pipe(
          Effect.catch((error) => Queue.fail(queue, error)),
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
            try: (signal) =>
              fetchImpl(`${API_BASE}/file/bot${token}/${decoded.value.result!.file_path}`, { signal }).then(async (response) => {
                if (!response.ok) throw new Error(`HTTP ${response.status}`)
                return new Uint8Array(await response.arrayBuffer())
              }),
            catch: (error) => new FileError({ reason: `Telegram file download failed: ${String(error)}` }),
          })
        })

      // Moderation over the Bot API. The bot needs the matching admin right in the chat; Telegram's
      // refusal comes back legible rather than as a crash.
      //
      // 🔴 **A capability flag is a PROMISE, and this one had nothing behind it.** `CAPS.moderation`
      // declared all five acts while the returned `Connection` carried no `moderate` at all, so the
      // gateway answered the model *"this messenger has no moderation controls"* — a claim about
      // TELEGRAM invented from a gap in OUR driver, and one an agent moderating a supergroup can
      // never retry its way out of. The manifest is the only advance description the layer above
      // gets; it may only say what the code does. Every act below therefore either performs the
      // platform call or REFUSES with the reason, and no act silently does something adjacent.
      const moderate = (chatID: string, act: ModerationAct) =>
        Effect.gen(function* () {
          const chat_id = Number(chatID)
          const nowSeconds = Math.floor(Date.now() / 1000)
          const ack = (method: string, body: Record<string, unknown>) =>
            call(method, body).pipe(
              Effect.mapError((error) => new ModerationError({ reason: error.reason })),
              Effect.flatMap((raw) => {
                const decoded = decodeAck(raw)
                if (decoded._tag === "Some" && decoded.value.ok === false)
                  return Effect.fail(
                    new ModerationError({
                      reason:
                        `Telegram refused ${method}` +
                        (decoded.value.description === undefined ? "" : `: ${decoded.value.description}`),
                    }),
                  )
                return Effect.void
              }),
            )
          switch (act.act) {
            case "delete":
              return yield* ack("deleteMessage", { chat_id, message_id: Number(act.messageID) })
            case "pin":
              return yield* ack("pinChatMessage", { chat_id, message_id: Number(act.messageID) })
            case "ban": {
              // `purgeSeconds` asks for the member's posts from the last N seconds. Telegram's only
              // purge is `revoke_messages`, which deletes EVERYTHING that member ever wrote in the
              // chat — strictly more than the caller asked for. The contract's rule for a modifier a
              // platform cannot honour is to refuse, not to do the adjacent thing quietly.
              if (act.purgeSeconds !== undefined)
                return yield* Effect.fail(
                  new ModerationError({
                    reason:
                      "Telegram can only delete ALL of a member's messages in a chat, never just the recent ones — ban without the purge and delete the offending messages individually.",
                  }),
                )
              // A temporary ban is `until_date`. Telegram silently makes a ban PERMANENT when the
              // date is under 30 seconds or over 366 days away, so a duration outside that window
              // would turn "banned for two years" into "banned forever" with no error anywhere.
              const days = act.durationDays
              if (days !== undefined && (days < 1 || days > 366))
                return yield* Effect.fail(
                  new ModerationError({
                    reason: `Telegram's timed bans run from 1 to 366 days (asked for ${days}) — outside that range Telegram makes the ban permanent instead. Pick a duration in range, or ban permanently.`,
                  }),
                )
              return yield* ack("banChatMember", {
                chat_id,
                user_id: Number(act.userID),
                ...(days === undefined ? {} : { until_date: nowSeconds + days * 86_400 }),
              })
            }
            case "kick":
              // Telegram has no kick verb: a ban lifted immediately removes the member and lets them
              // rejoin, which is what "kick" means on every platform that has the word.
              yield* ack("banChatMember", { chat_id, user_id: Number(act.userID) })
              return yield* ack("unbanChatMember", { chat_id, user_id: Number(act.userID), only_if_banned: true })
            case "mute": {
              // `restrictChatMember` with every send permission off. The same 30s/366d rule as a ban
              // applies to `until_date`, and here the accident is worse (a 10-second mute becoming
              // permanent), so the floor is clamped up rather than refused.
              const seconds = Math.max(31, Math.min(act.seconds ?? 600, 366 * 86_400))
              return yield* ack("restrictChatMember", {
                chat_id,
                user_id: Number(act.userID),
                until_date: nowSeconds + seconds,
                permissions: MUTED_PERMISSIONS,
              })
            }
            case "approve":
              return yield* Effect.fail(
                new ModerationError({
                  reason: "Telegram has no approval queue — a message is live from the moment it is sent.",
                }),
              )
            case "lock":
              // Telegram CAN close a group (setChatPermissions), but that rewrites the group's
              // default permissions for every member — a group-settings change, not a per-chat
              // moderation act — so this driver does not offer it and `CAPS.moderation.lock` is
              // absent. The refusal names OUR gap, never a platform limit Telegram does not have.
              return yield* Effect.fail(
                new ModerationError({
                  reason:
                    "This driver doesn't lock Telegram chats: closing a group rewrites its default permissions for every member, which is a group setting rather than a moderation act. Change it in Telegram itself.",
                }),
              )
          }
        })

      return {
        inbound: Stream.fromQueue(queue),
        send,
        downloadFile,
        moderate,
      } satisfies Connection
    }),
})

/** The default production driver, bound to the real global fetch. */
export const driver: Driver = make((url, init) => fetch(url, init))
