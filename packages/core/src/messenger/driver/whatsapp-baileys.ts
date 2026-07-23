export * as WhatsAppBaileysDriver from "./whatsapp-baileys"

import { Deferred, Effect, Queue, Stream } from "effect"
import type { Messenger } from "@novaclaw/schema/messenger"
import { MessengerFormat } from "../format"
import type {
  ChatSnapshot,
  Connection,
  ConnectContext,
  Driver,
  FileRef,
  InboundEvent,
  LoginPending,
  LoginSupport,
  OutboundFile,
} from "../driver"
import { ChallengeError, ConnectError, FileError, LoginCodeError, SendError } from "../driver"

// The WhatsApp driver (messenger-plan §2.1; owner decision 2026-07-23: the Baileys linked-device
// bridge, shipped OUT OF KERNEL as a plugin). This is the fake-testable POLICY half — the telegram-
// user split: the heavy, ToS-gray Baileys library (@whiskeysockets/baileys) lives ONLY behind the
// `WAClient` seam below (the plugin's socket factory dynamic-imports it; core never does), so this
// file carries zero Baileys import and unit-tests against a fake. All policy — the QR/pairing login,
// self-echo, chunked send, normalization — lives here.
//
// ⚠️ Login is OUT-OF-BAND: unlike a typed SMS code, WhatsApp linking finishes when the socket
// reaches `open` (the user scanned the QR in WhatsApp → Linked Devices, or entered the pairing
// code). So this driver uses `loginStyle: "browser"` (the waiting/auto-poll wizard step, shared with
// Gmail): begin() forks a fiber that awaits `open` → exports the auth, complete() polls that Deferred
// (retryable "still linking" until it lands). The QR/pairing string rides the `instructions` field.
//
// ⚠️ Traffic rules (§2.3): every outbound message is paced by the gateway's global governor and
// cold-starts are permission-gated there — the prerequisite for a user-account driver existing.

const CAPS: Messenger.Capabilities = {
  listChats: "full", // a linked device sees the account's chats (accumulated from the socket store)
  files: { up: true, down: true, maxBytes: 16_000_000 }, // WhatsApp's common media cap
  edits: false,
  typing: true,
  threads: false,
  moderation: { delete: false, ban: false, kick: false, mute: false, pin: false }, // §2.1: no moderation
  format: "plain", // a human typing emits no markup, and plain can't inject entities
  maxChars: 4096, // long messages chunk (human-paced), even though WhatsApp permits more
}

/** How a `WAClient` operation fails — the socket factory classifies Baileys errors into these; the
 *  driver maps them onto the contract's error vocabulary. */
export type WAClientFailure =
  | { readonly kind: "logged-out" } // the linked device was removed / banned → a challenge (re-link)
  | { readonly kind: "challenge"; readonly message: string }
  | { readonly kind: "error"; readonly message: string }

export class WAClientError extends Error {
  constructor(readonly failure: WAClientFailure) {
    super(failure.kind === "logged-out" ? "WhatsApp session logged out" : failure.message)
    this.name = "WAClientError"
  }
}

/** A platform message, already normalized by the socket factory (a Baileys WAMessage → this). */
export interface WAMessage {
  readonly chatID: string
  readonly chatKind: Messenger.ChatKind
  readonly chatTitle: string
  readonly messageID: string
  readonly senderID: string
  readonly senderName: string
  /** Sent BY the account itself (fromMe — the agent's relay, or the human on their phone). */
  readonly outgoing: boolean
  readonly text?: string
  readonly attachments?: readonly FileRef[]
  readonly replyTo?: string
  readonly at: number
}

/** How linking started: a QR to scan, OR a pairing code to type (phone-number mode).
 *
 *  ⚠️ The QR ROTATES. WhatsApp hands the socket a small batch of pairing refs and expires each after
 *  ~20s (~60s for the first); a QR shown past its ref is silently unscannable — the phone just sits
 *  there. So the link is a LIVE value, not a one-shot: the factory re-renders on every rotation and
 *  the driver republishes it through `LoginPending.progress`. `qr` is the raw payload (protocol
 *  detail, kept for tests/logs); `qrImage` is what a human can act on. */
export interface WALink {
  readonly qr?: string
  /** The QR rendered as a `data:image/png;base64,…` URL — the scannable artifact. */
  readonly qrImage?: string
  readonly pairingCode?: string
}

/** The narrow client surface the driver needs — Baileys behind a fakeable seam. All methods reject
 *  with `WAClientError`. */
export interface WAClient {
  /** The linked account itself (jid + display name). Available only after `open`. */
  readonly me: () => Promise<{ readonly id: string; readonly name: string }>
  /** Begin linking a credential-less socket: returns a QR to scan, or (if `phone` is given) a
   *  pairing code to enter in WhatsApp → Linked Devices → Link with phone number. */
  readonly startLink: (phone?: string) => Promise<WALink>
  /** The link as it stands NOW — the newest QR after any rotation, or the unchanged pairing code.
   *  Synchronous and side-effect-free: the login wizard polls it on a timer. */
  readonly currentLink: () => WALink
  /** Resolve when the socket reaches `open` (linking finished); reject (`logged-out`) on a terminal
   *  close. The login flow awaits this instead of a typed code. */
  readonly waitForOpen: () => Promise<void>
  /** The durable auth state ({creds,keys}) serialized — stored as the session credential. */
  readonly exportAuth: () => Promise<string>
  /** Long-poll new messages; resolves only when ≥1 arrived (an exhausted source holds until the
   *  caller's scope interrupts). */
  readonly pull: () => Promise<readonly WAMessage[]>
  readonly chats: (limit: number) => Promise<readonly ChatSnapshot[]>
  readonly history: (chatID: string, limit: number) => Promise<readonly WAMessage[]>
  readonly sendText: (chatID: string, text: string) => Promise<{ readonly messageID: string }>
  readonly sendFile: (chatID: string, file: OutboundFile, caption?: string) => Promise<{ readonly messageID: string }>
  readonly downloadFile: (fileID: string) => Promise<Uint8Array>
  readonly close: () => Promise<void>
}

export interface WAClientConfig {
  /** The exported auth state — absent during login acquisition. */
  readonly session?: string
}

export type WAClientFactory = (config: WAClientConfig) => Promise<WAClient>

const failureText = (failure: WAClientFailure): string =>
  failure.kind === "logged-out"
    ? "WhatsApp unlinked this device — re-link it in Settings → Messengers."
    : failure.message

/** Maps a rejected client promise onto the driver error vocabulary: a logged-out/challenge parks the
 *  account (never retried), everything else is a legible ConnectError. */
const mapClientError = (error: unknown): ConnectError | ChallengeError => {
  if (error instanceof WAClientError && (error.failure.kind === "logged-out" || error.failure.kind === "challenge"))
    return new ChallengeError({ message: failureText(error.failure) })
  return new ConnectError({ reason: error instanceof WAClientError ? failureText(error.failure) : String(error) })
}

const tryClient = <A>(run: () => Promise<A>): Effect.Effect<A, ConnectError | ChallengeError> =>
  Effect.tryPromise({ try: run, catch: mapClientError })

/** Remembers the last N messages WE sent (per chat), so our own outgoing traffic echoed back by the
 *  platform (fromMe) is recognized as our relay, not new input. Bounded FIFO. */
const sentTracker = (capacity: number) => {
  const order: string[] = []
  const set = new Set<string>()
  const key = (chatID: string, messageID: string) => `${chatID}:${messageID}`
  return {
    add: (chatID: string, messageID: string) => {
      const item = key(chatID, messageID)
      if (set.has(item)) return
      set.add(item)
      order.push(item)
      if (order.length > capacity) {
        const evicted = order.shift()
        if (evicted !== undefined) set.delete(evicted)
      }
    },
    has: (chatID: string, messageID: string) => set.has(key(chatID, messageID)),
  }
}

/** ONE account, TWO addresses. WhatsApp identifies users both by phone JID (`…@s.whatsapp.net`) and
 *  by **LID** (`…@lid`, the privacy-preserving id), and which one an inbound message carries depends
 *  on the surface — the operator's own "Message Yourself" messages arrive under the LID. Folding
 *  them is load-bearing, not tidiness: unfolded, the self-chat looks like a chat with a stranger who
 *  happens to share our identity, so the §0.1.5 console (whose whole test is `chatID === me.id`)
 *  never fires, the message reads as "the human using their own account elsewhere" and is dropped as
 *  an echo, and the account grows two chat rows for one conversation. The phone JID stays canonical.
 *  (Found live 2026-07-23: the first real console message landed as `…@lid` and vanished silently.) */
export const foldSelfAddress = (jid: string, self: { readonly id: string; readonly lid?: string }): string =>
  self.lid !== undefined && self.lid.length > 0 && jid === self.lid ? self.id : jid

/** The self-echo policy for a linked WhatsApp account (the human and the agent share one identity):
 *  - incoming (not fromMe) → never self.
 *  - fromMe that WE sent → self (drop: our own relay echoing back).
 *  - fromMe in the SELF-chat ("Message Yourself") we did NOT send → the OPERATOR typing on their
 *    phone (the remote-control console) → REAL input, not an echo.
 *  - fromMe elsewhere we did not send → the human using their own account → not our turn (self, drop). */
export const isSelfMessage = (
  message: Pick<WAMessage, "outgoing" | "chatID" | "messageID">,
  selfID: string,
  wasSentByUs: boolean,
): boolean => {
  if (!message.outgoing) return false
  if (wasSentByUs) return true
  return message.chatID !== selfID
}

/** Human instructions for the link step, from whichever mode the factory started.
 *
 *  ⚠️ The wrong scanner is the more obvious one. WhatsApp puts a QR button right on the chats
 *  screen, and it is NOT for linking a device — it scans a contact's personal QR code. Pointing it
 *  at our code does nothing useful, and nothing explains why. (The owner hit exactly this on the
 *  first real link, 2026-07-23.) A single run-on line naming the right menu was not enough, because
 *  the reader has already found a QR scanner by the time they read it — so the steps are numbered,
 *  the menu is named per platform, and the wrong button is called out by name.
 *
 *  When we rendered the QR the image IS the instruction; the text only says how to reach the right
 *  scanner, and warns that the code refreshes so a re-render never reads as a fault. Without a
 *  rendered image we fall back to the raw payload — useless to scan, but honest for a developer. */
const SCAN_STEPS =
  "On your phone, open WhatsApp and go to:\n" +
  "1. Settings (iPhone) — or the ⋮ menu (Android)\n" +
  "2. Linked devices\n" +
  "3. Link a device\n" +
  "4. Point it at the code below.\n\n" +
  "⚠️ Not the QR button on the main chats screen — that one adds a contact and will never link " +
  "NovaClaw. It has to be Linked devices → Link a device."

export const linkInstructions = (link: WALink): string =>
  link.pairingCode !== undefined
    ? "On your phone, open WhatsApp → Settings (iPhone) or the ⋮ menu (Android) → Linked devices → " +
      `Link a device → Link with phone number instead, then enter this code: ${link.pairingCode}`
    : link.qrImage !== undefined
      ? `${SCAN_STEPS}\n\nThe code refreshes every few seconds — just scan whichever one is on screen.`
      : link.qr !== undefined
        ? `${SCAN_STEPS}\n\n${link.qr}`
        : "On your phone, open WhatsApp → Linked devices → Link a device to finish."

/** The link as a login step the wizard can render. */
const linkProgress = (link: WALink) => ({
  instructions: linkInstructions(link),
  ...(link.qrImage !== undefined ? { qrImage: link.qrImage } : {}),
})

export const make = (factory: WAClientFactory): Driver => {
  const acquire = (config: WAClientConfig) =>
    Effect.acquireRelease(tryClient(() => factory(config)), (client) => Effect.promise(() => client.close().catch(() => undefined)))

  const login: LoginSupport = {
    begin: ({ account, inputs }) =>
      Effect.gen(function* () {
        void account // no per-account settings needed to link (Baileys uses no API credentials)
        const phone = (inputs["phone"] ?? "").trim()
        const client = yield* acquire({})
        const link = yield* tryClient(() => client.startLink(phone.length > 0 ? phone : undefined))

        // A fiber awaits the socket opening (the user scanned/paired) → exports the auth → parks it
        // in a Deferred. complete() reads it: still linking → retryable; open → the session; failed →
        // terminal. Same shape as the Gmail browser flow (the wizard renders a waiting/auto-poll step).
        const result = yield* Deferred.make<string, LoginCodeError | ChallengeError>()
        yield* Effect.forkScoped(
          tryClient(() => client.waitForOpen())
            .pipe(
              Effect.flatMap(() =>
                Effect.tryPromise({
                  try: () => client.exportAuth(),
                  catch: (error) => new LoginCodeError({ reason: `Could not save the WhatsApp session: ${String(error)}`, retryable: false }),
                }),
              ),
              Effect.mapError((error) =>
                error._tag === "MessengerDriver.ConnectError"
                  ? new LoginCodeError({ reason: error.reason, retryable: false })
                  : (error as ChallengeError | LoginCodeError),
              ),
              Effect.matchCauseEffect({
                onFailure: (cause) => Deferred.failCause(result, cause),
                onSuccess: (session) => Deferred.succeed(result, session),
              }),
            ),
        )

        const complete: LoginPending["complete"] = () =>
          Effect.gen(function* () {
            if (!(yield* Deferred.isDone(result)))
              return yield* Effect.fail(
                new LoginCodeError({ reason: "Still waiting for you to link this device in WhatsApp…", retryable: true }),
              )
            return { session: yield* Deferred.await(result) }
          })

        // The QR expires every ~20s, so the wizard re-reads the live link on a timer; the socket
        // factory keeps it fresh (and re-links when WhatsApp's ref batch runs out). Without this the
        // user stares at the first frame and every scan silently fails.
        return {
          ...linkProgress(link),
          progress: () => Effect.sync(() => linkProgress(client.currentLink())),
          complete,
        } satisfies LoginPending
      }),
  }

  return {
    id: "whatsapp",
    meta: {
      id: "whatsapp",
      name: "WhatsApp",
      icon: "speech-bubble",
      auth: "login",
      loginStyle: "browser", // out-of-band QR/pairing link — nothing to type; the wizard waits + polls
      settings: [],
      loginPrompts: [
        {
          type: "text",
          key: "phone",
          message: "Your phone number (international format) — only for pairing-code linking; leave blank to scan a QR",
          placeholder: "+491701234567",
        },
      ],
      capabilities: CAPS,
    },
    capabilities: () => CAPS,
    login,
    connect: (ctx: ConnectContext) =>
      Effect.gen(function* () {
        const session = ctx.secret
        if (session === undefined || session.length === 0)
          return yield* Effect.fail(
            new ConnectError({ reason: "This WhatsApp account isn't linked yet — finish linking in Settings → Messengers." }),
          )
        const client = yield* acquire({ session })
        // A logged-out session must PARK (challenge), not backoff-spin: me() is the first call to hit it.
        const me = yield* tryClient(() => client.me())
        const sent = sentTracker(512)

        const queue = yield* Queue.unbounded<InboundEvent>()
        const pump = Effect.gen(function* () {
          while (true) {
            const batch = yield* tryClient(() => client.pull())
            for (const message of batch) {
              const sentByUs = sent.has(message.chatID, message.messageID)
              yield* Queue.offer(queue, {
                kind: "message",
                chat: {
                  chatID: message.chatID,
                  kind: message.chatKind,
                  title: message.chatTitle,
                  // "Message Yourself" — the shared operator console (§0.1.5 address-prefix rule).
                  ...(message.chatID === me.id ? { self: true } : {}),
                },
                messageID: message.messageID,
                sender: {
                  id: message.senderID,
                  name: message.senderName,
                  isSelf: isSelfMessage(message, me.id, sentByUs),
                  // fromMe we did NOT send = the account's human typing = the born-paired operator.
                  ...(message.outgoing && !sentByUs ? { owner: true } : {}),
                },
                ...(message.text !== undefined && message.text.length > 0 ? { text: message.text } : {}),
                ...(message.attachments !== undefined && message.attachments.length > 0 ? { attachments: message.attachments } : {}),
                ...(message.replyTo !== undefined ? { replyTo: message.replyTo } : {}),
                at: message.at,
              })
            }
          }
        })
        yield* Effect.forkScoped(pump.pipe(Effect.catchCause(() => Queue.shutdown(queue))))

        const mapSendError = (error: unknown) =>
          new SendError({
            reason: error instanceof WAClientError ? failureText(error.failure) : String(error),
            retryable: !(error instanceof WAClientError && error.failure.kind === "logged-out"),
          })

        const send = (chatID: string, message: { text?: string; file?: OutboundFile }) =>
          Effect.gen(function* () {
            if (message.file !== undefined) {
              // A file rides with the text as its caption (WhatsApp semantics); no chunking.
              const result = yield* Effect.tryPromise({ try: () => client.sendFile(chatID, message.file!, message.text), catch: mapSendError })
              sent.add(chatID, result.messageID)
              return { messageID: result.messageID }
            }
            if (message.text === undefined || message.text.length === 0) return { messageID: "0" }
            const chunks = MessengerFormat.chunk(MessengerFormat.downgrade(message.text, "plain"), { maxChars: CAPS.maxChars })
            let lastID = "0"
            for (const chunk of chunks) {
              const result = yield* Effect.tryPromise({ try: () => client.sendText(chatID, chunk), catch: mapSendError })
              sent.add(chatID, result.messageID)
              lastID = result.messageID
            }
            return { messageID: lastID }
          })

        const demoteChallenge = <A>(effect: Effect.Effect<A, ConnectError | ChallengeError>) =>
          effect.pipe(Effect.mapError((error) => (error._tag === "MessengerDriver.ChallengeError" ? new ConnectError({ reason: error.message }) : error)))

        return {
          inbound: Stream.fromQueue(queue),
          send,
          downloadFile: (ref) =>
            Effect.tryPromise({
              try: () => client.downloadFile(ref.id),
              catch: (error) => new FileError({ reason: error instanceof WAClientError ? failureText(error.failure) : String(error) }),
            }),
          listChats: () =>
            demoteChallenge(
              tryClient(() => client.chats(100).then((chats) => chats.map((chat) => (chat.chatID === me.id ? { ...chat, self: true, title: "Message Yourself" } : chat)))),
            ),
          history: (chatID, limit) =>
            demoteChallenge(
              tryClient(() =>
                client.history(chatID, limit).then((messages) =>
                  messages.map((message) => ({
                    messageID: message.messageID,
                    senderID: message.senderID,
                    senderName: message.senderName,
                    outgoing: message.outgoing,
                    ...(message.text !== undefined && message.text.length > 0 ? { text: message.text } : {}),
                    at: message.at,
                  })),
                ),
              ),
            ),
        } satisfies Connection
      }),
  }
}
