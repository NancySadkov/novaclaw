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
}

export interface ChatSnapshot {
  readonly chatID: string
  readonly kind: Messenger.ChatKind
  readonly title: string
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
  | { readonly act: "ban"; readonly userID: string }
  | { readonly act: "kick"; readonly userID: string }
  | { readonly act: "mute"; readonly userID: string; readonly seconds?: number }
  | { readonly act: "pin"; readonly messageID: string }

export interface Connection {
  /** Normalized platform events. The stream failing (after the driver's own transport-level
   *  recovery) sends the gateway to backoff + reconnect — drivers surface, never spin silently. */
  readonly inbound: Stream.Stream<InboundEvent, ConnectError>
  readonly send: (chatID: string, message: OutboundMessage) => Effect.Effect<{ messageID: string }, SendError>
  /** Only for capability `listChats: "full"` (Discord, forums). "seen" platforms rely on the
   *  gateway's seen-chat cache instead (a Telegram bot cannot enumerate its chats). */
  readonly listChats?: () => Effect.Effect<readonly ChatSnapshot[], ConnectError>
  readonly downloadFile?: (ref: FileRef) => Effect.Effect<Uint8Array, FileError>
  readonly typing?: (chatID: string, on: boolean) => Effect.Effect<void>
  readonly moderate?: (chatID: string, act: ModerationAct) => Effect.Effect<void, ModerationError>
}

export interface ConnectContext {
  readonly account: Messenger.AccountInfo
  /** The resolved secret (bot token / API key) from the credential store. Drivers hold it in
   *  memory for the connection's lifetime only — never persist, never log, never echo. */
  readonly secret: string | undefined
  /** Durable resume state (Telegram update offset, IMAP UIDVALIDITY+UID, Discord seq) — load at
   *  connect, save as you acknowledge, so restarts never double-deliver or drop. */
  readonly cursor: {
    readonly get: () => Effect.Effect<unknown>
    readonly set: (value: unknown) => Effect.Effect<void>
  }
}

export interface Driver {
  readonly id: string
  readonly meta: Messenger.DriverMeta
  /** Effective capabilities for THIS account (settings may narrow the platform defaults). */
  readonly capabilities: (account: Messenger.AccountInfo) => Messenger.Capabilities
  /** Open the connection as a scoped resource; closing the scope must release sockets/pollers. */
  readonly connect: (ctx: ConnectContext) => Effect.Effect<Connection, ConnectError, Scope.Scope>
}
