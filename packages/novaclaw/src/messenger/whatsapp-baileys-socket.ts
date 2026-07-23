export * as WhatsAppBaileysSocket from "./whatsapp-baileys-socket"

import makeWASocket, {
  BufferJSON,
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  jidNormalizedUser,
  proto,
  type AuthenticationCreds,
  type SignalDataTypeMap,
  type WAMessage as BaileysMessage,
} from "@whiskeysockets/baileys"
import type { ChatSnapshot } from "@novaclaw/core/messenger/driver"
import type { WAClient, WAClientConfig, WAClientFactory, WAMessage } from "@novaclaw/core/messenger/driver/whatsapp-baileys"
import { WAClientError } from "@novaclaw/core/messenger/driver/whatsapp-baileys"

// The Baileys socket factory — the ONLY file that imports @whiskeysockets/baileys (the ToS-gray,
// out-of-kernel bridge; loaded via a gated DYNAMIC import in external-driver-source.ts, never at
// boot). It implements the `WAClient` seam that the core policy half (driver/whatsapp-baileys.ts)
// drives. All WhatsApp-specific realities are handled here so the policy half stays pure:
//   - in-memory, serializable auth ({creds,keys} via BufferJSON) → one session string, our credential
//     model (mutated in place by Baileys; serialize() snapshots the live state);
//   - pairing-code linking (requestPairingCode) — the friendly headless path (no QR to render);
//   - the post-link `restartRequired` (515) reconnect Baileys demands after the first pairing;
//   - push (messages.upsert) → pull (the seam's batch-await) buffering.

// A no-op ILogger (Baileys requires one; we don't want its noise on our stdout).
const silentLogger: any = {
  level: "silent",
  child: () => silentLogger,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
}

/** An in-memory auth store that (de)serializes to ONE string — our credential model. Baileys mutates
 *  `creds` in place and writes keys through `keys.set`, so `serialize()` snapshots the live state. */
const makeAuthState = (saved?: string) => {
  const parsed: { creds?: AuthenticationCreds; keys?: Record<string, Record<string, unknown>> } =
    saved && saved.length > 0 ? JSON.parse(saved, BufferJSON.reviver) : {}
  const creds: AuthenticationCreds = parsed.creds ?? initAuthCreds()
  const store: Record<string, Record<string, unknown>> = parsed.keys ?? {}
  const keys = {
    get: <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
      const result: { [id: string]: SignalDataTypeMap[T] } = {}
      for (const id of ids) {
        let value = store[type]?.[id]
        if (type === "app-state-sync-key" && value) value = proto.Message.AppStateSyncKeyData.fromObject(value)
        if (value !== undefined && value !== null) result[id] = value as SignalDataTypeMap[T]
      }
      return result
    },
    set: (data: { [T in keyof SignalDataTypeMap]?: { [id: string]: SignalDataTypeMap[T] | null } }) => {
      for (const type of Object.keys(data)) {
        const bucket = (store[type] = store[type] ?? {})
        const incoming = (data as Record<string, Record<string, unknown>>)[type]!
        for (const id of Object.keys(incoming)) {
          const value = incoming[id]
          if (value === null || value === undefined) delete bucket[id]
          else bucket[id] = value
        }
      }
    },
  }
  return {
    state: { creds, keys: keys as never },
    serialize: () => JSON.stringify({ creds, keys: store }, BufferJSON.replacer),
  }
}

const textOf = (message: BaileysMessage["message"]): string | undefined =>
  message?.conversation ??
  message?.extendedTextMessage?.text ??
  message?.imageMessage?.caption ??
  message?.videoMessage?.caption ??
  message?.documentMessage?.caption ??
  undefined

export const factory: WAClientFactory = async (config: WAClientConfig): Promise<WAClient> => {
  const { state, serialize } = makeAuthState(config.session)

  // The live socket (recreated on a transient/restart-required close, reusing the in-memory creds).
  let sock: ReturnType<typeof makeWASocket>
  let intentionalClose = false

  // open latch: resolves on the first stable `open`, rejects on a terminal close (logged out).
  let openSettled = false
  let onOpen!: () => void
  let onOpenFail!: (error: Error) => void
  const whenOpen = new Promise<void>((resolve, reject) => {
    onOpen = () => {
      if (!openSettled) {
        openSettled = true
        resolve()
      }
    }
    onOpenFail = (error) => {
      if (!openSettled) {
        openSettled = true
        reject(error)
      }
    }
  })

  // qr latch (QR-mode linking): resolves with the first QR string Baileys emits.
  let onQr: ((qr: string) => void) | undefined
  let firstQr: string | undefined
  const qrPromise = new Promise<string>((resolve) => {
    onQr = resolve
  })

  // connecting latch: pairing-code requests must wait until the ws is establishing.
  let markConnecting!: () => void
  const connecting = new Promise<void>((resolve) => {
    markConnecting = resolve
  })

  // push → pull buffer.
  const buffer: WAMessage[] = []
  let pullWake: (() => void) | undefined
  let pullFail: ((error: Error) => void) | undefined
  const seenChats = new Map<string, ChatSnapshot>()

  const selfId = () => (sock.user ? jidNormalizedUser(sock.user.id) : undefined)

  const normalize = (message: BaileysMessage): WAMessage | undefined => {
    const jid = message.key.remoteJid ?? undefined
    if (jid === undefined || jid === "status@broadcast") return undefined
    const fromMe = message.key.fromMe === true
    const text = textOf(message.message)
    const isGroup = jid.endsWith("@g.us")
    const self = selfId()
    if (!seenChats.has(jid))
      seenChats.set(jid, { chatID: jid, kind: isGroup ? "group" : "dm", title: message.pushName ?? jid, ...(jid === self ? { self: true } : {}) })
    return {
      chatID: jid,
      chatKind: isGroup ? "group" : "dm",
      chatTitle: message.pushName ?? jid,
      messageID: message.key.id ?? "",
      senderID: fromMe ? self ?? jid : message.key.participant ?? jid,
      senderName: message.pushName ?? message.key.participant ?? jid,
      outgoing: fromMe,
      ...(text !== undefined && text.length > 0 ? { text } : {}),
      at: (Number(message.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000,
    }
  }

  const version = await fetchLatestBaileysVersion()
    .then((info) => info.version)
    .catch(() => undefined)

  const createSocket = () => {
    const socket = makeWASocket({
      auth: state,
      browser: Browsers.ubuntu("Chrome"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      logger: silentLogger,
      ...(version ? { version } : {}),
    })
    socket.ev.on("creds.update", () => {
      /* creds mutate in place; serialize() reads the live object — nothing to persist here */
    })
    socket.ev.on("connection.update", (update) => {
      if (update.connection === "connecting") markConnecting()
      if (update.qr !== undefined && firstQr === undefined) {
        firstQr = update.qr
        onQr?.(update.qr)
      }
      if (update.connection === "open") onOpen()
      if (update.connection === "close") {
        if (intentionalClose) return
        const statusCode = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode
        if (statusCode === DisconnectReason.loggedOut) {
          const error = new WAClientError({ kind: "logged-out" })
          onOpenFail(error)
          pullFail?.(error)
        } else {
          // restartRequired (515, expected right after the first pairing) or a transient drop →
          // recreate the socket with the now-saved creds and keep waiting for a stable `open`.
          recreate()
        }
      }
    })
    socket.ev.on("messages.upsert", (event) => {
      if (event.type !== "notify") return // new arrivals only, not a history backfill
      for (const message of event.messages) {
        const normalized = normalize(message)
        if (normalized !== undefined) buffer.push(normalized)
      }
      if (buffer.length > 0) {
        pullWake?.()
        pullWake = undefined
      }
    })
    return socket
  }

  const recreate = () => {
    try {
      sock.end(undefined)
    } catch {
      /* already down */
    }
    sock = createSocket()
  }

  sock = createSocket()

  return {
    me: async () => {
      await whenOpen
      const user = sock.user
      if (user === undefined) throw new WAClientError({ kind: "error", message: "WhatsApp did not report the linked account." })
      return { id: jidNormalizedUser(user.id), name: user.name ?? user.id }
    },
    startLink: async (phone) => {
      if (phone !== undefined && phone.length > 0) {
        // Pairing-code mode: wait until the socket is establishing, then request the 8-char code.
        await Promise.race([connecting, new Promise<void>((resolve) => setTimeout(resolve, 4000))])
        const digits = phone.replace(/[^0-9]/g, "")
        const code = await sock.requestPairingCode(digits)
        return { pairingCode: code }
      }
      return { qr: await qrPromise }
    },
    waitForOpen: () => whenOpen,
    exportAuth: async () => serialize(),
    pull: async () => {
      for (;;) {
        if (buffer.length > 0) return buffer.splice(0, buffer.length)
        await new Promise<void>((resolve, reject) => {
          pullWake = resolve
          pullFail = reject
        })
      }
    },
    chats: async (limit) => {
      const self = selfId()
      const list = [...seenChats.values()]
      if (self !== undefined && !seenChats.has(self)) list.unshift({ chatID: self, kind: "dm", title: "Message Yourself", self: true })
      return list.slice(0, Math.max(1, limit))
    },
    history: async () => [], // v7 dropped the in-memory store; on-demand history is a later cut
    sendText: async (chatID, text) => {
      const result = await sock.sendMessage(chatID, { text })
      return { messageID: result?.key?.id ?? "0" }
    },
    sendFile: async (chatID, file, caption) => {
      const result = await sock.sendMessage(chatID, {
        document: Buffer.from(file.data),
        mimetype: file.mime,
        fileName: file.name,
        ...(caption !== undefined && caption.length > 0 ? { caption } : {}),
      })
      return { messageID: result?.key?.id ?? "0" }
    },
    downloadFile: async () => {
      throw new WAClientError({ kind: "error", message: "WhatsApp media download isn't wired yet (text-first cut)." })
    },
    close: async () => {
      intentionalClose = true
      try {
        await sock.end(undefined)
      } catch {
        /* already down */
      }
    },
  }
}
