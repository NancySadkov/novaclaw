export * as TelegramUserMtcute from "./telegram-user-mtcute"

import type { Messenger } from "@novaclaw/schema/messenger"
import { InstallationVersion } from "../../installation/version"
import type { ChatSnapshot } from "../driver"
import type { UserClient, UserClientConfig, UserClientFactory, UserMessage } from "./telegram-user"
import { UserClientError } from "./telegram-user"

// The mtcute adapter behind the telegram-user driver's `UserClient` seam (messenger-plan §2.2:
// mtcute is the owner-accepted MTProto dependency — pure TS + wasm crypto, no native modules).
// This file is the ONLY place mtcute is named; it is loaded by DYNAMIC import strictly when a
// telegram-user account logs in or connects, so instance boot never pays for it (startup-speed
// owner signal) and non-Bun runtimes fail legibly instead of at import time.
//
// ⚠️ Runtime: we ship `@mtcute/bun` only (its Node twin hard-requires the native better-sqlite3).
// Every first-class server runtime (novaclaw serve, the CLI, the Spark) runs under Bun. The
// desktop app's LOCAL sidecar runs under Electron's Node — there this driver refuses with a
// pointer to a served instance (the P2P stance: the gateway lives on the instance; a desktop UI
// can drive a Bun-served NovaClaw with full messenger support).
//
// Storage is in-memory + our exported session string (the credential store is the ONE durable
// identity — logout = delete the credential). Peer access-hashes therefore live per-connection:
// dialogs() and inbound updates populate them, which covers every bound-chat flow; the self-chat
// is addressed as "me"/"self" which never needs a hash.

type MtcuteModule = typeof import("@mtcute/bun")
type MtcutePeer = import("@mtcute/bun").Peer
type MtcuteMessage = import("@mtcute/bun").Message

let loaded: Promise<MtcuteModule> | undefined

const load = (): Promise<MtcuteModule> => {
  if (typeof Bun === "undefined")
    return Promise.reject(
      new UserClientError({
        kind: "error",
        message:
          "Telegram user accounts need a Bun-run NovaClaw instance (`novaclaw serve`) — this instance is running under Node. Connect the app to a served instance instead.",
      }),
    )
  loaded ??= import("@mtcute/bun")
  return loaded
}

const errorText = (error: unknown): string => {
  if (error instanceof Error) {
    const rpc = error as { errorMessage?: unknown; text?: unknown }
    if (typeof rpc.errorMessage === "string") return rpc.errorMessage
    if (typeof rpc.text === "string") return rpc.text
    return error.message
  }
  return String(error)
}

/** Classify mtcute/RPC failures into the driver's failure vocabulary. String-matched on the
 *  canonical Telegram error names so we do not depend on mtcute's error-class hierarchy. */
export const classify = (error: unknown): UserClientError => {
  if (error instanceof UserClientError) return error
  const text = errorText(error)
  if (text.includes("SESSION_PASSWORD_NEEDED")) return new UserClientError({ kind: "password-needed" })
  if (/PHONE_CODE_INVALID|PHONE_CODE_EXPIRED|PHONE_CODE_EMPTY|CODE_INVALID/.test(text))
    return new UserClientError({
      kind: "bad-code",
      message: text.includes("EXPIRED") ? "That code expired — restart the login to get a fresh one." : "That code doesn't match — check it and try again.",
    })
  const flood = text.match(/FLOOD_WAIT_(\d+)/)
  if (flood !== null) return new UserClientError({ kind: "flood", seconds: Number(flood[1]) })
  if (/AUTH_KEY_UNREGISTERED|AUTH_KEY_DUPLICATED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|PHONE_NUMBER_BANNED|PHONE_NUMBER_FLOOD/.test(text))
    return new UserClientError({
      kind: "challenge",
      message: `Telegram rejected this account's session (${text}) — log in again from Settings → Messengers.`,
    })
  return new UserClientError({ kind: "error", message: text })
}

const peerKind = (peer: MtcutePeer): Messenger.ChatKind =>
  peer.type === "user" ? "dm" : peer.chatType === "channel" ? "channel" : "group"

/** Downloadable media → a FileRef (the `fileId` string round-trips into downloadAsBuffer).
 *  Documents and photos only in v1 — the shapes the "client sends a brief, agent reads it" use
 *  case actually needs; anything else (polls, stickers, locations) is not a file. */
const toAttachments = (message: MtcuteMessage): UserMessage["attachments"] => {
  const media = message.media
  if (media === null || media === undefined) return undefined
  if (media.type === "document") {
    return [
      {
        id: media.fileId,
        name: media.fileName ?? "document",
        mime: media.mimeType,
        ...(typeof media.fileSize === "number" ? { size: media.fileSize } : {}),
      },
    ]
  }
  if (media.type === "photo") {
    return [
      {
        id: media.fileId,
        name: `photo-${message.id}.jpg`,
        mime: "image/jpeg",
        ...(typeof media.fileSize === "number" ? { size: media.fileSize } : {}),
      },
    ]
  }
  return undefined
}

const toUserMessage = (message: MtcuteMessage): UserMessage => {
  const replyTo = message.replyToMessage?.id ?? null
  const attachments = toAttachments(message)
  return {
    chatID: String(message.chat.id),
    chatKind: peerKind(message.chat),
    chatTitle: message.chat.displayName,
    messageID: String(message.id),
    senderID: String(message.sender.id),
    senderName: message.sender.displayName,
    outgoing: message.isOutgoing,
    ...(message.text.length > 0 ? { text: message.text } : {}),
    ...(attachments === undefined ? {} : { attachments }),
    ...(replyTo === null ? {} : { replyTo: String(replyTo) }),
    at: message.date.getTime(),
  }
}

/** The production factory the driver registry injects. */
export const factory: UserClientFactory = async (config: UserClientConfig): Promise<UserClient> => {
  const mtcute = await load()
  const client = new mtcute.TelegramClient({
    apiId: config.apiId,
    apiHash: config.apiHash,
    storage: new mtcute.MemoryStorage(),
    // What Telegram shows in the account's "Devices" list. Without this mtcute reports ITS OWN
    // version as the app version (e.g. "0.31.0" — mistakable for an app version); pin it to the ONE
    // runtime source of truth (InstallationVersion ← the root package.json, via the generated
    // version.gen.ts) so the device reads "NovaClaw <our version>", never a dependency's.
    initConnectionOptions: {
      deviceModel: "NovaClaw",
      appVersion: InstallationVersion,
    },
  })
  try {
    if (config.session !== undefined) await client.importSession(config.session)
  } catch (error) {
    await client.destroy().catch(() => undefined)
    throw classify(error)
  }

  const wrap = async <A>(run: () => Promise<A>): Promise<A> => {
    try {
      return await run()
    } catch (error) {
      throw classify(error)
    }
  }

  let selfID: string | undefined
  // pull(): buffer + waiter over mtcute's push emitter — holds when empty (the driver's scoped
  // pump interrupt is what ends the wait; mirrors the bot driver's long-poll hold semantics).
  let buffer: UserMessage[] = []
  let waiter: ((batch: readonly UserMessage[]) => void) | undefined
  let listening = false
  client.onNewMessage.add((message) => {
    buffer.push(toUserMessage(message))
    if (waiter !== undefined) {
      const resolve = waiter
      waiter = undefined
      const batch = buffer
      buffer = []
      resolve(batch)
    }
  })

  return {
    me: () =>
      wrap(async () => {
        const user = await client.getMe()
        selfID = String(user.id)
        if (!listening) {
          listening = true
          client.startUpdatesLoop().catch(() => undefined)
        }
        return { id: selfID, name: user.displayName }
      }),
    sendCode: (phone) =>
      wrap(async () => {
        const sent = await client.sendCode({ phone })
        if (!("phoneCodeHash" in sent))
          // Already-authorized futures path — cannot happen on our fresh MemoryStorage login client.
          throw new UserClientError({ kind: "error", message: "This session is already logged in." })
        return { phoneCodeHash: sent.phoneCodeHash, via: sent.type }
      }),
    signIn: (input) =>
      wrap(async () => {
        await client.signIn({ phone: input.phone, phoneCodeHash: input.phoneCodeHash, phoneCode: input.code })
      }),
    checkPassword: (password) =>
      wrap(async () => {
        await client.checkPassword(password)
      }),
    exportSession: () => wrap(() => client.exportSession()),
    pull: () =>
      new Promise((resolve) => {
        if (buffer.length > 0) {
          const batch = buffer
          buffer = []
          resolve(batch)
          return
        }
        waiter = resolve
      }),
    dialogs: (limit) =>
      wrap(async () => {
        const out: ChatSnapshot[] = []
        for await (const dialog of client.iterDialogs({ limit })) {
          out.push({ chatID: String(dialog.peer.id), kind: peerKind(dialog.peer), title: dialog.peer.displayName })
          if (out.length >= limit) break
        }
        return out
      }),
    history: (chatID, limit) =>
      wrap(async () => {
        // Telegram serves history newest-first; the driver contract wants chronological.
        const peer = selfID !== undefined && chatID === selfID ? "self" : Number(chatID)
        const page = await client.getHistory(peer, { limit })
        return [...page].map(toUserMessage).reverse()
      }),
    sendText: (chatID, text) =>
      wrap(async () => {
        // The self-chat (Saved Messages) is addressed as "self" — never needs an access hash.
        const peer = selfID !== undefined && chatID === selfID ? "self" : Number(chatID)
        const sent = await client.sendText(peer, text)
        return { messageID: String(sent.id) }
      }),
    sendFile: (chatID, file, caption) =>
      wrap(async () => {
        const peer = selfID !== undefined && chatID === selfID ? "self" : Number(chatID)
        const sent = await client.sendMedia(peer, {
          type: "document",
          file: file.data,
          fileName: file.name,
          fileMime: file.mime,
          ...(caption !== undefined && caption.length > 0 ? { caption } : {}),
        })
        return { messageID: String(sent.id) }
      }),
    downloadFile: (fileID) => wrap(() => client.downloadAsBuffer(fileID)),
    close: () => client.destroy().catch(() => undefined),
  }
}
