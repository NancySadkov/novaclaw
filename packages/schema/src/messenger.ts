export * as Messenger from "./messenger"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { ascending } from "./identifier"
import { Integration } from "./integration"
import { Credential } from "./credential"
import { SessionID } from "./session-id"
import { optional, statics } from "./schema"

// The Messenger module's wire contracts (novaclaw-plan notes/messenger-plan.md): a remote chat on
// Telegram/Discord/IRC/email/… is a session's REMOTE TTY. A DRIVER is a platform adapter behind
// one contract; an ACCOUNT is one credentialed driver instance (bot token, IRC identity, mailbox);
// a BINDING links one session to one remote chat. The binding's TRUST tier is chosen by the user
// in the connect dialogue — never inferred — and drives input framing, reply relay, delivery
// coalescing, and the unattended-jail default.

export const AccountID = Schema.String.check(Schema.isStartsWith("msa_")).pipe(
  Schema.brand("Messenger.AccountID"),
  statics((schema) => ({ create: () => schema.make("msa_" + ascending()) })),
)
export type AccountID = typeof AccountID.Type

export const BindingID = Schema.String.check(Schema.isStartsWith("msb_")).pipe(
  Schema.brand("Messenger.BindingID"),
  statics((schema) => ({ create: () => schema.make("msb_" + ascending()) })),
)
export type BindingID = typeof BindingID.Type

/** operator = the instance owner/family: full control through this chat. client = a customer the
 *  agent works for: untrusted requests, framed as such. audience = the moderated public: untrusted
 *  observations — coalesced delivery, no auto-relay (the agent lurks and speaks only on purpose). */
export const Trust = Schema.Literals(["operator", "client", "audience"]).annotate({
  identifier: "Messenger.Trust",
})
export type Trust = typeof Trust.Type

/** Contact trust is about SENDERS (pairing), not bindings: operators may drive gateway commands;
 *  blocked senders are dropped before anything else sees them. */
export const ContactTrust = Schema.Literals(["operator", "client", "blocked"]).annotate({
  identifier: "Messenger.ContactTrust",
})
export type ContactTrust = typeof ContactTrust.Type

export const ChatKind = Schema.Literals(["dm", "group", "channel", "thread", "mailbox", "topic"]).annotate({
  identifier: "Messenger.ChatKind",
})
export type ChatKind = typeof ChatKind.Type

export const BindingStatus = Schema.Literals(["active", "paused"]).annotate({
  identifier: "Messenger.BindingStatus",
})
export type BindingStatus = typeof BindingStatus.Type

/** The gateway's per-account connection state machine. `airgapped` is its own honest state:
 *  offline/airgap mode force-disables every messenger (the OFF-C stance), and the UI says why. */
export const AccountStatus = Schema.Union([
  Schema.Struct({ state: Schema.Literal("disabled") }),
  Schema.Struct({ state: Schema.Literal("airgapped") }),
  Schema.Struct({ state: Schema.Literal("connecting") }),
  Schema.Struct({ state: Schema.Literal("connected") }),
  Schema.Struct({ state: Schema.Literal("backoff"), until: Schema.Number, message: Schema.String }),
  Schema.Struct({ state: Schema.Literal("error"), message: Schema.String }),
])
  .pipe(Schema.toTaggedUnion("state"))
  .annotate({ identifier: "Messenger.AccountStatus" })
export type AccountStatus = typeof AccountStatus.Type

/** What one platform can actually do — the kernel degrades by capability instead of assuming.
 *  `maxBytes` set means the platform budgets LINE BYTES, not characters (IRC). */
export interface Capabilities extends Schema.Schema.Type<typeof Capabilities> {}
export const Capabilities = Schema.Struct({
  listChats: Schema.Literals(["full", "seen", "none"]),
  files: Schema.Struct({
    up: Schema.Boolean,
    down: Schema.Boolean,
    maxBytes: optional(Schema.Number),
  }),
  edits: Schema.Boolean,
  typing: Schema.Boolean,
  threads: Schema.Boolean,
  moderation: Schema.Struct({
    delete: Schema.Boolean,
    ban: Schema.Boolean,
    kick: Schema.Boolean,
    mute: Schema.Boolean,
    pin: Schema.Boolean,
  }),
  format: Schema.Literals(["plain", "markdown", "html"]),
  maxChars: Schema.Number,
  maxBytes: optional(Schema.Number),
}).annotate({ identifier: "Messenger.Capabilities" })

/** Driver self-description the Settings UI renders the "Add account" form from. `settings` reuses
 *  the Integration prompt vocabulary (text/select fields); the SECRET (bot token, API key) never
 *  rides here — it goes through the Integration key/oauth connect flow into the credential store. */
export interface DriverMeta extends Schema.Schema.Type<typeof DriverMeta> {}
export const DriverMeta = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  icon: Schema.String,
  auth: Schema.Literals(["key", "oauth", "none"]),
  settings: Schema.Array(Integration.Prompt),
  capabilities: Capabilities,
}).annotate({ identifier: "Messenger.DriverMeta" })

export class AccountInfo extends Schema.Class<AccountInfo>("Messenger.AccountInfo")({
  id: AccountID,
  driverID: Schema.String,
  label: Schema.String,
  enabled: Schema.Boolean,
  credentialID: optional(Credential.ID),
  settings: Schema.Record(Schema.String, Schema.String),
}) {}

/** A remote conversation the account has SEEN (or listed). For "seen"-capability drivers
 *  (Telegram bots cannot enumerate their chats) this cache IS the pickable chat list. */
export class ChatInfo extends Schema.Class<ChatInfo>("Messenger.ChatInfo")({
  accountID: AccountID,
  chatID: Schema.String,
  kind: ChatKind,
  title: Schema.String,
  lastSeen: Schema.Number,
}) {}

export class BindingInfo extends Schema.Class<BindingInfo>("Messenger.BindingInfo")({
  id: BindingID,
  accountID: AccountID,
  chatID: Schema.String,
  sessionID: SessionID,
  trust: Trust,
  status: BindingStatus,
}) {}

const AccountStatusChanged = define({
  type: "messenger.account.status",
  schema: { accountID: AccountID, status: AccountStatus },
})
const ChatSeen = define({
  type: "messenger.chat.seen",
  schema: { accountID: AccountID, chatID: Schema.String },
})
const BindingUpdated = define({
  type: "messenger.binding.updated",
  schema: { bindingID: BindingID, sessionID: SessionID },
})
export const Event = {
  AccountStatusChanged,
  ChatSeen,
  BindingUpdated,
  Definitions: inventory(AccountStatusChanged, ChatSeen, BindingUpdated),
}
