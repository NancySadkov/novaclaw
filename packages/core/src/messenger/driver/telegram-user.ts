export * as TelegramUserDriver from "./telegram-user"

import { Effect, Queue, Stream } from "effect"
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

// The Telegram USER-ACCOUNT driver (messenger-plan §0.2 + §2.2 owner decision): the agent logs
// into the user's OWN Telegram account (MTProto) and acts as them while they're AFK — the lay
// default, no bot registration. The MTProto client library (mtcute, the accepted dependency) is
// behind the `UserClient` seam below: production injects the mtcute adapter
// (telegram-user-mtcute.ts, dynamic import — zero boot cost); tests inject a fake. All policy —
// login steps, 2FA, self-echo, Saved-Messages remote control, chunking — lives HERE, fake-tested.
//
// ⚠️ Traffic rules (§2.3) are the prerequisite for this driver existing at all: every outbound
// message is paced by the gateway's global governor, cold-starts are permission-gated there, and
// a provider challenge (login veto, revoked session) parks the account for the operator. The
// driver itself never retries against a challenge.

const CAPS: Messenger.Capabilities = {
  listChats: "full", // a user sees all their chats (unlike a bot)
  files: { up: true, down: true, maxBytes: 2_000_000_000 },
  edits: true,
  typing: true,
  threads: false,
  moderation: { delete: true, ban: true, kick: true, mute: true, pin: true },
  // We send PLAIN text: a human typing doesn't emit markup, and plain can't inject entities.
  format: "plain",
  maxChars: 4096,
}

/** How a `UserClient` operation fails — the adapter classifies provider errors into these; the
 *  driver maps them onto the contract's error vocabulary. */
export type UserClientFailure =
  | { readonly kind: "password-needed" }
  | { readonly kind: "bad-code"; readonly message: string }
  | { readonly kind: "challenge"; readonly message: string }
  | { readonly kind: "flood"; readonly seconds: number }
  | { readonly kind: "error"; readonly message: string }

export class UserClientError extends Error {
  constructor(readonly failure: UserClientFailure) {
    super(
      failure.kind === "password-needed"
        ? "two-step verification password needed"
        : failure.kind === "flood"
          ? `flood wait ${failure.seconds}s`
          : failure.message,
    )
    this.name = "UserClientError"
  }
}

/** A platform message, already normalized by the adapter (mtcute's Message → this). */
export interface UserMessage {
  readonly chatID: string
  readonly chatKind: Messenger.ChatKind
  readonly chatTitle: string
  readonly messageID: string
  readonly senderID: string
  readonly senderName: string
  /** Sent BY the account itself (from any device — the agent, or the human on their phone). */
  readonly outgoing: boolean
  readonly text?: string
  /** Downloadable media on the message (document/photo), already normalized to FileRefs. */
  readonly attachments?: readonly FileRef[]
  readonly replyTo?: string
  readonly at: number
}

/** The narrow client surface the driver needs — mtcute behind a fakeable seam. All methods
 *  reject with `UserClientError`. */
export interface UserClient {
  /** The logged-in account itself (id + display name). */
  readonly me: () => Promise<{ readonly id: string; readonly name: string }>
  readonly sendCode: (phone: string) => Promise<{ readonly phoneCodeHash: string; readonly via: string }>
  readonly signIn: (input: {
    readonly phone: string
    readonly phoneCodeHash: string
    readonly code: string
  }) => Promise<void>
  readonly checkPassword: (password: string) => Promise<void>
  readonly exportSession: () => Promise<string>
  /** Start receiving updates, then long-poll batches of new messages. Resolves only when ≥1
   *  message arrived — an exhausted source HOLDS (the caller's scope interrupt ends the wait). */
  readonly pull: () => Promise<readonly UserMessage[]>
  readonly dialogs: (limit: number) => Promise<readonly ChatSnapshot[]>
  /** Recent messages of one chat, newest LAST (chronological), up to `limit`. */
  readonly history: (chatID: string, limit: number) => Promise<readonly UserMessage[]>
  readonly sendText: (chatID: string, text: string) => Promise<{ readonly messageID: string }>
  /** Upload + send one file (a document), with an optional caption. */
  readonly sendFile: (
    chatID: string,
    file: OutboundFile,
    caption?: string,
  ) => Promise<{ readonly messageID: string }>
  /** Download a file by the platform file id a FileRef carries. */
  readonly downloadFile: (fileID: string) => Promise<Uint8Array>
  readonly close: () => Promise<void>
}

export interface UserClientConfig {
  readonly apiId: number
  readonly apiHash: string
  /** The exported session string — absent during login acquisition. */
  readonly session?: string
}

export type UserClientFactory = (config: UserClientConfig) => Promise<UserClient>

const codeChannel = (via: string): string =>
  via === "app"
    ? "to your other Telegram apps"
    : via === "sms" || via === "sms_word" || via === "sms_phrase"
      ? "by SMS"
      : via === "call"
        ? "by phone call"
        : `via ${via}`

const failureText = (failure: UserClientFailure): string =>
  failure.kind === "flood"
    ? `Telegram asks to wait ${failure.seconds} seconds before trying again.`
    : failure.kind === "password-needed"
      ? "This account has two-step verification — restart the login and fill in the password field."
      : failure.message

/** Maps a rejected client promise onto the driver error vocabulary: challenges park the account
 *  (never retried), everything else is a legible ConnectError. */
const mapClientError = (error: unknown): ConnectError | ChallengeError => {
  if (error instanceof UserClientError && error.failure.kind === "challenge")
    return new ChallengeError({ message: error.failure.message })
  return new ConnectError({ reason: error instanceof UserClientError ? failureText(error.failure) : String(error) })
}

const tryClient = <A>(run: () => Promise<A>): Effect.Effect<A, ConnectError | ChallengeError> =>
  Effect.tryPromise({ try: run, catch: mapClientError })

const parseAccountConfig = (account: Messenger.AccountInfo): Effect.Effect<{ apiId: number; apiHash: string }, ConnectError> => {
  const apiId = Number(account.settings["apiId"] ?? "")
  const apiHash = (account.settings["apiHash"] ?? "").trim()
  if (!Number.isInteger(apiId) || apiId <= 0 || apiHash.length === 0)
    return Effect.fail(
      new ConnectError({
        reason:
          "This account is missing its Telegram API ID / hash — get them at my.telegram.org (API development tools) and fill both fields in Settings → Messengers.",
      }),
    )
  return Effect.succeed({ apiId, apiHash })
}

/** Remembers the last N messages WE sent (per chat), so our own outgoing traffic echoed back by
 *  the platform is recognized. Bounded FIFO — a long-lived connection must not grow forever. */
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

/** The self-echo policy for a USER account (unlike a bot, the human and the agent share one
 *  identity — from Telegram's side both are "the account"):
 *  - incoming (not outgoing) → never self.
 *  - outgoing we sent ourselves → self (drop: our own relay echoing back).
 *  - outgoing in the SELF-chat (Saved Messages) that we did NOT send → the OPERATOR typing on
 *    their phone — this is the phone-remote-control channel, so it is REAL input, not an echo.
 *  - outgoing anywhere else we did not send → the human using their own account (or another
 *    device); acting as them there is not our turn — treat as self (drop). */
export const isSelfMessage = (
  message: Pick<UserMessage, "outgoing" | "chatID" | "messageID">,
  selfID: string,
  wasSentByUs: boolean,
): boolean => {
  if (!message.outgoing) return false
  if (wasSentByUs) return true
  return message.chatID !== selfID
}

export const make = (factory: UserClientFactory): Driver => {
  const acquire = (config: UserClientConfig) =>
    Effect.acquireRelease(tryClient(() => factory(config)), (client) =>
      Effect.promise(() => client.close().catch(() => undefined)),
    )

  const login: LoginSupport = {
    begin: ({ account, inputs }) =>
      Effect.gen(function* () {
        const config = yield* parseAccountConfig(account)
        const phone = (inputs["phone"] ?? "").trim()
        if (phone.length === 0)
          return yield* Effect.fail(new ConnectError({ reason: "A phone number is required (international format, e.g. +49…)." }))
        const password = (inputs["password"] ?? "").trim()
        const client = yield* acquire(config)
        const sent = yield* tryClient(() => client.sendCode(phone))
        const complete: LoginPending["complete"] = (code) =>
          Effect.gen(function* () {
            const trimmed = code.trim()
            if (trimmed.length === 0)
              return yield* Effect.fail(new LoginCodeError({ reason: "Enter the code Telegram sent you.", retryable: true }))
            yield* Effect.tryPromise({
              try: () => client.signIn({ phone, phoneCodeHash: sent.phoneCodeHash, code: trimmed }),
              catch: (error) => error,
            }).pipe(
              Effect.catch((error) => {
                if (error instanceof UserClientError) {
                  if (error.failure.kind === "password-needed") {
                    // 2FA: the password was collected up front (loginPrompts) so this stays one round-trip.
                    if (password.length > 0)
                      return Effect.tryPromise({ try: () => client.checkPassword(password), catch: (inner) => inner }).pipe(
                        Effect.catch((inner) =>
                          Effect.fail(
                            inner instanceof UserClientError && inner.failure.kind === "challenge"
                              ? new ChallengeError({ message: inner.failure.message })
                              : new LoginCodeError({
                                  reason:
                                    inner instanceof UserClientError && inner.failure.kind === "error"
                                      ? `Two-step verification failed: ${inner.failure.message}`
                                      : inner instanceof UserClientError
                                        ? failureText(inner.failure)
                                        : String(inner),
                                  retryable: false,
                                }),
                          ),
                        ),
                      )
                    return Effect.fail(new LoginCodeError({ reason: failureText(error.failure), retryable: false }))
                  }
                  if (error.failure.kind === "bad-code")
                    return Effect.fail(new LoginCodeError({ reason: error.failure.message, retryable: true }))
                  if (error.failure.kind === "challenge")
                    return Effect.fail(new ChallengeError({ message: error.failure.message }))
                  return Effect.fail(new LoginCodeError({ reason: failureText(error.failure), retryable: false }))
                }
                return Effect.fail(new LoginCodeError({ reason: String(error), retryable: false }))
              }),
            )
            const session = yield* Effect.tryPromise({
              try: () => client.exportSession(),
              catch: (error) => new LoginCodeError({ reason: String(error), retryable: false }),
            })
            return { session }
          })
        return {
          instructions: `Telegram sent a login code ${codeChannel(sent.via)} — enter it to finish signing in.`,
          complete,
        } satisfies LoginPending
      }),
  }

  return {
    id: "telegram-user",
    meta: {
      id: "telegram-user",
      name: "Telegram (your account)",
      icon: "speech-bubble",
      auth: "login",
      settings: [
        {
          type: "text",
          key: "apiId",
          message: "Telegram API ID — a number from my.telegram.org → API development tools (one-time setup)",
          placeholder: "1234567",
        },
        {
          type: "text",
          key: "apiHash",
          message: "Telegram API hash — from the same my.telegram.org page",
          placeholder: "32-character hash",
        },
      ],
      loginPrompts: [
        {
          type: "text",
          key: "phone",
          message: "Your phone number, international format",
          placeholder: "+491701234567",
        },
        {
          type: "text",
          key: "password",
          message: "Two-step verification password — only if your account has one",
          placeholder: "leave empty if none",
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
            new ConnectError({ reason: "This account isn't logged in yet — finish the Telegram login in Settings → Messengers." }),
          )
        const config = yield* parseAccountConfig(ctx.account)
        const client = yield* acquire({ ...config, session })
        // A dead/revoked session must PARK (challenge), not backoff-spin: the adapter classifies
        // AUTH_KEY_UNREGISTERED / SESSION_REVOKED as challenges and me() is the first call to hit it.
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
                  // Saved Messages — the shared operator console (§0.1.5 address-prefix rule).
                  ...(message.chatID === me.id ? { self: true } : {}),
                },
                messageID: message.messageID,
                sender: {
                  id: message.senderID,
                  name: message.senderName,
                  isSelf: isSelfMessage(message, me.id, sentByUs),
                  // Outgoing we did NOT send = the account's human typing (any device) — the
                  // born-paired operator; no pairing ceremony on a login account.
                  ...(message.outgoing && !sentByUs ? { owner: true } : {}),
                },
                ...(message.text !== undefined && message.text.length > 0 ? { text: message.text } : {}),
                ...(message.attachments !== undefined && message.attachments.length > 0
                  ? { attachments: message.attachments }
                  : {}),
                ...(message.replyTo !== undefined ? { replyTo: message.replyTo } : {}),
                at: message.at,
              })
            }
          }
        })
        yield* Effect.forkScoped(pump.pipe(Effect.catchCause(() => Queue.shutdown(queue))))

        const mapSendError = (error: unknown) => {
          if (error instanceof UserClientError)
            return new SendError({ reason: failureText(error.failure), retryable: error.failure.kind === "flood" })
          return new SendError({ reason: String(error), retryable: true })
        }

        const send = (chatID: string, message: { text?: string; file?: OutboundFile; replyTo?: string }) =>
          Effect.gen(function* () {
            let lastID = "0"
            if (message.file !== undefined) {
              // A file message: the text rides as the caption (Telegram semantics); no chunking —
              // captions are short by construction (the tool caps them).
              const result = yield* Effect.tryPromise({
                try: () => client.sendFile(chatID, message.file!, message.text),
                catch: mapSendError,
              })
              sent.add(chatID, result.messageID)
              return { messageID: result.messageID }
            }
            if (message.text === undefined || message.text.length === 0) return { messageID: "0" }
            const chunks = MessengerFormat.chunk(MessengerFormat.downgrade(message.text, "plain"), {
              maxChars: CAPS.maxChars,
            })
            for (const chunk of chunks) {
              const result = yield* Effect.tryPromise({
                try: () => client.sendText(chatID, chunk),
                catch: mapSendError,
              })
              sent.add(chatID, result.messageID)
              lastID = result.messageID
            }
            return { messageID: lastID }
          })

        const demoteChallenge = <A>(effect: Effect.Effect<A, ConnectError | ChallengeError>) =>
          effect.pipe(
            Effect.mapError((error) =>
              error._tag === "MessengerDriver.ChallengeError" ? new ConnectError({ reason: error.message }) : error,
            ),
          )

        return {
          inbound: Stream.fromQueue(queue),
          send,
          downloadFile: (ref) =>
            Effect.tryPromise({
              try: () => client.downloadFile(ref.id),
              catch: (error) =>
                new FileError({
                  reason: error instanceof UserClientError ? failureText(error.failure) : String(error),
                }),
            }),
          listChats: () =>
            demoteChallenge(
              tryClient(() =>
                client.dialogs(100).then((chats) =>
                  chats.map((chat) => (chat.chatID === me.id ? { ...chat, self: true, title: "Saved Messages" } : chat)),
                ),
              ),
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
