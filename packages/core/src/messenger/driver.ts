export * as MessengerDriver from "./driver"

import type { Effect, Scope, Stream } from "effect"
import { Schema } from "effect"
import type { Messenger } from "@novaclaw/schema/messenger"

// The ONE driver contract every messenger platform implements (notes/messenger-plan.md §2).
// Drivers are raw-protocol, zero-dependency, individually deletable files under
// messenger/driver/ — the kernel never learns platform specifics beyond this interface. Pull
// platforms (Telegram long-poll, IMAP, forum REST) implement connect() as a poll loop; push
// platforms (Discord gateway WS, IRC TCP) as a socket consumer — the gateway cannot tell the
// difference and must not care. Everything beyond `inbound` + `send` is optional: the kernel
// degrades by capability (no files on IRC → a legible refusal, never a crash).

export class ConnectError extends Schema.TaggedErrorClass<ConnectError>()("MessengerDriver.ConnectError", {
  reason: Schema.String,
}) {}

// The provider demanded a CAPTCHA / verification / device-approval (traffic rules §2.3). A driver
// raises this instead of retrying blindly; the gateway parks the account as `challenge` and
// notifies the operator to resolve it out of band. NovaClaw NEVER auto-solves or evades — that is
// both a platform-safety rule and a hard product rule.
export class ChallengeError extends Schema.TaggedErrorClass<ChallengeError>()("MessengerDriver.ChallengeError", {
  message: Schema.String,
}) {}

export class SendError extends Schema.TaggedErrorClass<SendError>()("MessengerDriver.SendError", {
  reason: Schema.String,
  /** true = a transport hiccup worth retrying; false = permanent (bad chat id, payload too big). */
  retryable: Schema.Boolean,
}) {}

export class FileError extends Schema.TaggedErrorClass<FileError>()("MessengerDriver.FileError", {
  reason: Schema.String,
}) {}

export class ModerationError extends Schema.TaggedErrorClass<ModerationError>()("MessengerDriver.ModerationError", {
  reason: Schema.String,
}) {}

/** A login-attempt completion failure. `retryable: true` means the attempt is STILL PENDING and
 *  the user may simply re-enter the code (a mistyped Telegram code stays valid to retry against
 *  the same phoneCodeHash); false ends the attempt (wrong 2FA setup, expired code, provider veto). */
export class LoginCodeError extends Schema.TaggedErrorClass<LoginCodeError>()("MessengerDriver.LoginCodeError", {
  reason: Schema.String,
  retryable: Schema.Boolean,
}) {}

/** A platform file handle (attachment id / URL token) a driver can later download. */
export interface FileRef {
  readonly id: string
  readonly name?: string
  readonly mime?: string
  readonly size?: number
}

export interface Sender {
  readonly id: string
  readonly name: string
  /** The account's own outbound echoed back by the platform — the gateway drops these unconditionally. */
  readonly isSelf: boolean
  /** The ACCOUNT OWNER typing (a `login` account's human, from any of their devices) — the gateway
   *  treats them as a born-paired `operator`, no pairing ceremony (§0.1.5 turnkey). Bot accounts
   *  never set this. */
  readonly owner?: boolean
}

export interface ChatSnapshot {
  readonly chatID: string
  readonly kind: Messenger.ChatKind
  readonly title: string
  /** The account's SELF-chat (Telegram Saved Messages) — the shared operator console where the
   *  §0.1.5 address-prefix rule applies. Only `login` drivers ever set this. */
  readonly self?: boolean
  /** The chat this one lives INSIDE, for platforms that nest conversations: a Discord thread's
   *  channel, a forum post's forum, a Telegram topic's supergroup. A binding on the parent covers
   *  every child — the gateway falls back to it when the child chat isn't bound itself, so
   *  moderating a support forum takes ONE binding instead of one per post (and posts appear
   *  continuously, so per-post binding could never work). Replies still target the child chat id. */
  readonly parentID?: string
}

/** One past message, for the tool's `history` op — same normalization as inbound. */
export interface HistoryEntry {
  readonly messageID: string
  readonly senderID: string
  readonly senderName: string
  readonly outgoing: boolean
  readonly text?: string
  readonly at: number
}

export type InboundEvent =
  | {
      readonly kind: "message"
      readonly chat: ChatSnapshot
      readonly messageID: string
      readonly sender: Sender
      readonly text?: string
      readonly attachments?: readonly FileRef[]
      readonly replyTo?: string
      readonly at: number
    }
  | { readonly kind: "edited"; readonly chat: ChatSnapshot; readonly messageID: string; readonly text?: string; readonly at: number }
  | { readonly kind: "deleted"; readonly chat: ChatSnapshot; readonly messageID: string; readonly at: number }
  | { readonly kind: "member"; readonly chat: ChatSnapshot; readonly change: "joined" | "left"; readonly member: Sender; readonly at: number }

export interface OutboundFile {
  readonly name: string
  readonly mime: string
  readonly data: Uint8Array
}

export interface OutboundMessage {
  readonly text?: string
  readonly file?: OutboundFile
  readonly replyTo?: string
}

export type ModerationAct =
  | { readonly act: "delete"; readonly messageID: string }
  /** Two INDEPENDENT modifiers, because platforms split the concept: `purgeSeconds` also deletes
   *  the member's recent messages (Discord `delete_message_seconds` — the spam-wave action, or a
   *  banned spammer's posts stay up for a human to clear by hand), while `durationDays` makes the
   *  ban temporary (Reddit). A driver that cannot honour one REFUSES rather than silently doing
   *  something else: a "7-day ban" quietly applied forever is worse than the caller asked for. */
  | { readonly act: "ban"; readonly userID: string; readonly purgeSeconds?: number; readonly durationDays?: number }
  | { readonly act: "kick"; readonly userID: string }
  | { readonly act: "mute"; readonly userID: string; readonly seconds?: number }
  | { readonly act: "pin"; readonly messageID: string }
  /** Put a removed/reported item back in the listings — the other half of queue moderation, where
   *  the decision is keep-or-remove rather than delete-or-ignore (Reddit's modqueue). */
  | { readonly act: "approve"; readonly messageID: string }
  /** Close the CHAT the op names to new replies (a resolved support thread, a heated post). Targets
   *  the conversation, not a message — `moderate(chatID, …)` already carries the target. */
  | { readonly act: "lock" }

export interface Connection {
  /** Normalized platform events. The stream failing (after the driver's own transport-level
   *  recovery) sends the gateway to backoff + reconnect — drivers surface, never spin silently. */
  readonly inbound: Stream.Stream<InboundEvent, ConnectError>
  readonly send: (chatID: string, message: OutboundMessage) => Effect.Effect<{ messageID: string }, SendError>
  /** Only for capability `listChats: "full"` (Discord, forums). "seen" platforms rely on the
   *  gateway's seen-chat cache instead (a Telegram bot cannot enumerate its chats). */
  readonly listChats?: () => Effect.Effect<readonly ChatSnapshot[], ConnectError>
  /** Recent messages of one chat, newest last — the tool's `history` op (conversation fetching). */
  readonly history?: (chatID: string, limit: number) => Effect.Effect<readonly HistoryEntry[], ConnectError>
  readonly downloadFile?: (ref: FileRef) => Effect.Effect<Uint8Array, FileError>
  readonly typing?: (chatID: string, on: boolean) => Effect.Effect<void>
  readonly moderate?: (chatID: string, act: ModerationAct) => Effect.Effect<void, ModerationError>
}

export interface ConnectContext {
  readonly account: Messenger.AccountInfo
  /** The resolved secret from the credential store — a bot token for `key` auth, OR the user's
   *  session credential for `login` auth (acting AS the user, messenger-plan §0.2). The driver
   *  holds it in memory for the connection's lifetime only — never persist, never log, never echo;
   *  and `connect` does not care which kind it is (the acquisition flow differs, the use does not). */
  readonly secret: string | undefined
  /** Durable resume state (Telegram update offset, IMAP UIDVALIDITY+UID, Discord seq) — load at
   *  connect, save as you acknowledge, so restarts never double-deliver or drop. */
  readonly cursor: {
    readonly get: () => Effect.Effect<unknown>
    readonly set: (value: unknown) => Effect.Effect<void>
  }
}

/** The in-flight half of a `login` acquisition (messenger-plan §0.2): begin() has already made the
 *  provider send a code; complete(code) finishes and yields the durable session credential the
 *  gateway will pass back as `ConnectContext.secret` on every reconnect. The pending state is a
 *  scoped resource — the provider ties the code to the live connection that requested it, so the
 *  attempt's scope must stay open until complete/cancel/expiry. */
/** What the user must act on RIGHT NOW. Most drivers hand this back once at `begin` and it stands
 *  for the whole attempt; a driver whose step rotates reports it again through `LoginPending.progress`. */
export interface LoginProgress {
  readonly instructions: string
  /** A scannable image as a `data:image/png;base64,…` URL, when the step is scanned not typed. The
   *  driver renders it (the raw payload is unscannable text a human cannot act on). */
  readonly qrImage?: string
}

export interface LoginPending extends LoginProgress {
  /** The step's CURRENT presentation, for drivers whose step expires while the user is acting on it
   *  — WhatsApp mints a fresh linked-device QR every ~20s and a stale one silently will not scan.
   *  Absent = the `begin` instructions stand for the whole attempt (every typed-code driver). Must
   *  be cheap and side-effect-free: the wizard polls it on a timer. */
  readonly progress?: () => Effect.Effect<LoginProgress>
  readonly complete: (code: string) => Effect.Effect<{ session: string }, LoginCodeError | ChallengeError>
}

export interface LoginSupport {
  /** Starts a login attempt: `inputs` are the answers to `meta.loginPrompts` (phone, optional 2FA
   *  password — collected up front so the flow stays one code round-trip). */
  readonly begin: (ctx: {
    readonly account: Messenger.AccountInfo
    readonly inputs: Record<string, string>
  }) => Effect.Effect<LoginPending, ConnectError | ChallengeError, Scope.Scope>
}

export interface Driver {
  readonly id: string
  readonly meta: Messenger.DriverMeta
  /** Effective capabilities for THIS account (settings may narrow the platform defaults). */
  readonly capabilities: (account: Messenger.AccountInfo) => Messenger.Capabilities
  /** Open the connection as a scoped resource; closing the scope must release sockets/pollers.
   *  A `ChallengeError` parks the account for operator resolution instead of blind reconnection. */
  readonly connect: (ctx: ConnectContext) => Effect.Effect<Connection, ConnectError | ChallengeError, Scope.Scope>
  /** Required exactly when `meta.auth === "login"` — the user's-own-account acquisition flow. */
  readonly login?: LoginSupport
}
