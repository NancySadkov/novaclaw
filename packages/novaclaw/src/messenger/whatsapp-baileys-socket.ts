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
import QRCode from "qrcode"
import type { ChatSnapshot } from "@novaclaw/core/messenger/driver"
import type { WAClient, WAClientConfig, WAClientFactory, WALink, WAMessage } from "@novaclaw/core/messenger/driver/whatsapp-baileys"
import { WAClientError, WhatsAppBaileysDriver } from "@novaclaw/core/messenger/driver/whatsapp-baileys"

// The Baileys socket factory — the ONLY file that imports @whiskeysockets/baileys (the ToS-gray,
// out-of-kernel bridge; loaded via a gated DYNAMIC import in external-driver-source.ts, never at
// boot). It implements the `WAClient` seam that the core policy half (driver/whatsapp-baileys.ts)
// drives. All WhatsApp-specific realities are handled here so the policy half stays pure:
//   - in-memory, serializable auth ({creds,keys} via BufferJSON) → one session string, our credential
//     model (mutated in place by Baileys; serialize() snapshots the live state);
//   - QR linking: rendering each rotating QR to a scannable PNG and keeping a fresh one on screen
//     (see "the rotating QR" below) — plus pairing-code linking (requestPairingCode) as the
//     phone-number alternative;
//   - the post-link `restartRequired` (515) reconnect Baileys demands after the first pairing;
//   - push (messages.upsert) → pull (the seam's batch-await) buffering.
//
// ⚠️ THE ROTATING QR — the whole reason this is more than "show the first qr". WhatsApp hands the
// socket ONE `pair-device` stanza carrying a small BATCH of pairing refs, and Baileys pops one ref
// per QR: the first lives ~60s, each next ~20s (Socket/socket.js `genPairQR`). Consequences we must
// honour, because getting any of them wrong looks identical to the user — they scan and nothing
// happens:
//   1. NEVER raise `qrTimeout`. It is not "how long the user gets"; it is how long we sit on a ref
//      the SERVER already expired. A 120s timeout means ~100s of showing a dead code.
//   2. Publish EVERY rotation, not just the first (`currentLink()` is read by the login wizard on a
//      timer), and render each one — a raw ref payload is unscannable text.
//   3. When the batch runs out Baileys ends the socket (`QR refs attempts ended` → timedOut). That
//      is routine, not a failure: reconnect for a fresh batch so the wizard never dead-ends.

// Baileys' own logger is silenced (below), so these few lines are the ONLY window into the link
// lifecycle — and linking is the step most likely to need diagnosing from a user's report ("I
// scanned and nothing happened"). One line per QR rotation and per reconnect, no payloads.
const trace = (message: string) => console.log(`[whatsapp] ${message}`)

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

  // The LIVE link (see "the rotating QR" above). `link` always holds the newest rendered code;
  // `firstLink` is what startLink() awaits. Rendering is async, so a rotation lands a beat after the
  // event — the wizard picks it up on its next poll. A generation counter drops a slow render whose
  // QR has already been superseded, so `link` can never go backwards to an expired code.
  let link: WALink = {}
  let onFirstLink: ((value: WALink) => void) | undefined
  const firstLink = new Promise<WALink>((resolve) => {
    onFirstLink = resolve
  })
  let generation = 0
  const publishQr = (qr: string) => {
    const mine = ++generation
    const settle = (value: WALink) => {
      if (mine !== generation) return
      link = value
      trace(`qr #${mine}${value.qrImage === undefined ? " (render failed)" : ""}`)
      onFirstLink?.(value)
      onFirstLink = undefined
    }
    // Error-correction "L": the payload is long, and the fewer modules a fixed-width code has the
    // bigger each square renders — which is what a phone camera actually needs. A screen is a clean
    // scanning surface, so the redundancy higher levels buy is wasted here. `margin: 4` is the QR
    // spec's quiet zone in modules — do not shrink it to win pixels; scanners rely on it to find the
    // symbol at all, and a code that fails to acquire looks exactly like a code that expired.
    void QRCode.toDataURL(qr, { margin: 4, width: 320, errorCorrectionLevel: "L" })
      .then((qrImage) => settle({ qr, qrImage }))
      .catch(() => settle({ qr })) // render failed → publish the payload anyway, honestly unscannable
  }

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

  // Every inbound jid is folded onto the phone JID — see `foldSelfAddress` for why that is
  // load-bearing (the LID-addressed self-chat is what the §0.1.5 console runs on).
  const selfIds = () => {
    const user = sock.user
    if (user === undefined) return undefined
    const lid = user.lid !== undefined && user.lid.length > 0 ? jidNormalizedUser(user.lid) : undefined
    return { id: jidNormalizedUser(user.id), ...(lid !== undefined ? { lid } : {}) }
  }
  const selfId = () => selfIds()?.id

  const canonical = (jid: string) => {
    const self = selfIds()
    return self === undefined ? jid : WhatsAppBaileysDriver.foldSelfAddress(jid, self)
  }

  const normalize = (message: BaileysMessage): WAMessage | undefined => {
    const raw = message.key.remoteJid ?? undefined
    if (raw === undefined || raw === "status@broadcast") return undefined
    const jid = canonical(jidNormalizedUser(raw))
    const fromMe = message.key.fromMe === true
    const text = textOf(message.message)
    const isGroup = jid.endsWith("@g.us")
    const self = selfId()
    const title = jid === self ? "Message Yourself" : (message.pushName ?? jid)
    if (!seenChats.has(jid))
      seenChats.set(jid, { chatID: jid, kind: isGroup ? "group" : "dm", title, ...(jid === self ? { self: true } : {}) })
    return {
      chatID: jid,
      chatKind: isGroup ? "group" : "dm",
      chatTitle: title,
      messageID: message.key.id ?? "",
      senderID: fromMe ? (self ?? jid) : canonical(jidNormalizedUser(message.key.participant ?? raw)),
      senderName: message.pushName ?? message.key.participant ?? jid,
      outgoing: fromMe,
      ...(text !== undefined && text.length > 0 ? { text } : {}),
      at: (Number(message.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000,
    }
  }

  const version = await fetchLatestBaileysVersion()
    .then((info) => info.version)
    .catch(() => undefined)

  // ⚠️ Socket GENERATIONS. Ending a socket makes it emit its own `close`, and a dying socket keeps
  // emitting for a while after — so a handler that blindly acts on `sock` will, one tick later, end
  // the healthy REPLACEMENT it just spawned. (Observed live: the QR froze a few seconds in, because
  // the dead socket's trailing close killed its successor and the survivors fought over `sock`.)
  // Every socket claims a sequence number at birth and ignores everything once superseded.
  let sequence = 0

  const createSocket = () => {
    const mine = ++sequence
    const current = () => mine === sequence
    const socket = makeWASocket({
      auth: state,
      browser: Browsers.ubuntu("Chrome"),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      // NO qrTimeout override — Baileys' 60s-then-20s cadence tracks WhatsApp's own ref expiry.
      // Raising it does not give the user longer, it just shows a code the server already retired.
      logger: silentLogger,
      ...(version ? { version } : {}),
    })
    socket.ev.on("creds.update", () => {
      /* creds mutate in place; serialize() reads the live object — nothing to persist here */
    })
    socket.ev.on("connection.update", (update) => {
      if (!current()) return // a superseded socket's trailing events are noise
      if (update.connection === "connecting") markConnecting()
      if (update.qr !== undefined) publishQr(update.qr) // EVERY rotation, not just the first
      if (update.connection === "open") {
        const self = selfIds()
        trace(`linked as ${self?.id ?? "?"}${self?.lid !== undefined ? ` (lid ${self.lid})` : " (no lid)"}`)
        onOpen()
      }
      if (update.connection === "close") {
        if (intentionalClose) return
        const statusCode = (update.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output?.statusCode
        if (statusCode === DisconnectReason.loggedOut) {
          const error = new WAClientError({ kind: "logged-out" })
          onOpenFail(error)
          pullFail?.(error)
        } else {
          // restartRequired (515, expected right after the first pairing) → reconnect at once.
          // timedOut is the routine end of a QR ref batch mid-scan — near-immediate, because the
          // user is watching a dead code until the next one lands. Anything else waits a beat so a
          // persistent fault can't spin us.
          trace(`close (${statusCode ?? "?"}) → reconnecting`)
          recreate(
            statusCode === DisconnectReason.restartRequired ? 0 : statusCode === DisconnectReason.timedOut ? 250 : 1500,
          )
        }
      }
    })
    socket.ev.on("messages.upsert", (event) => {
      if (!current()) return
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

  const recreate = (delayMs: number) => {
    sequence++ // retire the outgoing socket FIRST: everything it emits from here on is ignored
    try {
      sock.end(undefined)
    } catch {
      /* already down */
    }
    const spawn = () => {
      if (intentionalClose) return
      sock = createSocket()
      trace("reconnected")
    }
    if (delayMs <= 0) spawn()
    else setTimeout(spawn, delayMs).unref?.()
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
        link = { pairingCode: code } // fixed for the attempt — unlike a QR, it does not rotate
        return link
      }
      return firstLink
    },
    currentLink: () => link,
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
