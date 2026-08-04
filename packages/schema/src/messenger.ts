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

/** The SHAPE of a conversation — how it is addressed and nested, nothing more. ⚠️ It is NOT a
 *  privacy signal and must never be read as one: a `channel` can be an invite-only company server
 *  and a `group` can be a public community. Privacy is `Source` below (todo.md ruling 7). */
export const ChatKind = Schema.Literals(["dm", "group", "channel", "thread", "mailbox", "topic"]).annotate({
  identifier: "Messenger.ChatKind",
})
export type ChatKind = typeof ChatKind.Type

/**
 * How PUBLIC a chat is — the module's SOURCE LABEL (todo.md **ruling 7**: *chat privacy is a source
 * label, not a transport enum*). It answers exactly one question: **may what is read here be quoted
 * outside this conversation** — in a research report, a citation, anything that leaves the chat?
 *
 * - `public` — a broadcast source anyone can read. Citable.
 * - `private` — somebody's correspondence. Never citable, never research input.
 * - `unknown` — **no evidence either way, and this is the DEFAULT**, not a fallback nobody chose.
 *
 * ⚠️ **Why three and not a boolean.** The ruling rules out `broadcast: boolean` by name, because a
 * boolean cannot express "no evidence" — which is the MAJORITY case — so it forces every unlabelled
 * chat into one of two confident answers. It also rules out `guild_id !== undefined`: a company's
 * internal Discord server has it set and is private. "No evidence" has to be a state you can be in.
 */
const SourceAccess = Schema.Literals(["unknown", "public", "private"]).annotate({
  identifier: "Messenger.SourceAccess",
})
export type SourceAccess = typeof SourceAccess.Type

/**
 * The label as it is actually STORED — **two independent fields, because who said it is part of the
 * fact.** Collapsing them into one value is what turns a driver's guess into the user's word.
 *
 * - `proposed` — what the DRIVER's platform evidence suggests. Always present; `unknown` when the
 *   driver has nothing, which is most of the time.
 * - `declared` — what the USER said. Absent means **nobody has chosen yet**, which is not the same
 *   as choosing `unknown`.
 *
 * ⚠️ Lines 14-16 of this file already state the module's law — a trust declaration is chosen by the
 * user in the connect dialogue, **never inferred**. `Source.resolve` is that law made mechanical.
 */
export interface SourceLabel extends Schema.Schema.Type<typeof SourceLabel> {}
const SourceLabel = Schema.Struct({
  proposed: SourceAccess,
  declared: optional(SourceAccess),
}).annotate({ identifier: "Messenger.SourceLabel" })

/** What the label resolves to, and — the load-bearing half — **on whose authority**. */
export interface SourceDecision {
  readonly access: SourceAccess
  /** `user` = a declaration. `driver` = a proposal that only RESTRICTED. `default` = nobody chose. */
  readonly by: "user" | "driver" | "default"
}

/** A chat nobody has said anything about — the state a new chat is born in. */
const UNLABELLED: SourceLabel = { proposed: "unknown" }

/**
 * ⭐ **The whole of ruling 7 in six lines: a driver may PROPOSE, only the user DECIDES, and a
 * proposal can never GRANT.**
 *
 * The asymmetry is deliberate and it is the point. A declaration wins outright, in both directions —
 * that is what "user-overridable" means. With no declaration, a driver's `private` proposal still
 * takes effect, because restricting is free: the worst case is that the user has to say "actually
 * this one is public". But a driver's `public` proposal collapses to `unknown` and grants nothing,
 * because the opposite failure is a chat the platform *looked* public about being quoted into a
 * report the user never agreed to publish. Evidence may lock a door; it may not open one.
 *
 * So `access === "public"` implies `by === "user"`, always — pinned in
 * `core/test/messenger-source-access.test.ts` over every input, and negative-controlled.
 */
const resolveSource = (label: SourceLabel | undefined): SourceDecision => {
  if (label?.declared !== undefined) return { access: label.declared, by: "user" }
  if (label?.proposed === "private") return { access: "private", by: "driver" }
  return { access: "unknown", by: "default" }
}

/** May what is read here be quoted as a source outside this conversation? */
const citable = (label: SourceLabel | undefined): boolean => resolveSource(label).access === "public"

export const Source = {
  Access: SourceAccess,
  Label: SourceLabel,
  UNLABELLED,
  resolve: resolveSource,
  citable,
} as const

export const BindingStatus = Schema.Literals(["active", "paused"]).annotate({
  identifier: "Messenger.BindingStatus",
})
export type BindingStatus = typeof BindingStatus.Type

/** The gateway's per-account connection state machine. `airgapped` is its own honest state:
 *  offline/airgap mode force-disables every messenger (the OFF-C stance), and the UI says why.
 *  `challenge` = the provider demanded a CAPTCHA/verification (traffic rules §2.3): the account
 *  parks and the operator is notified; NovaClaw never auto-solves or evades bot-detection. */
export const AccountStatus = Schema.Union([
  Schema.Struct({ state: Schema.Literal("disabled") }),
  Schema.Struct({ state: Schema.Literal("airgapped") }),
  Schema.Struct({ state: Schema.Literal("connecting") }),
  Schema.Struct({ state: Schema.Literal("connected") }),
  Schema.Struct({ state: Schema.Literal("backoff"), until: Schema.Number, message: Schema.String }),
  Schema.Struct({ state: Schema.Literal("challenge"), message: Schema.String }),
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
    /** Optional because most chat platforms have no such thing. A QUEUE-based platform (Reddit)
     *  makes them the main job: `approve` clears a removal/report so the item goes back into the
     *  listings, and `lock` closes a thread to new replies. Absent = the driver can't. */
    approve: optional(Schema.Boolean),
    lock: optional(Schema.Boolean),
  }),
  format: Schema.Literals(["plain", "markdown", "html"]),
  maxChars: Schema.Number,
  maxBytes: optional(Schema.Number),
}).annotate({ identifier: "Messenger.Capabilities" })

/** How an account authenticates (messenger-plan §0.2): `login` = act as the USER's own account
 *  (phone → code → 2FA via the Integration attempt flow — the lay default so nobody registers a
 *  bot) · `key` = a bot/app token (opt-in power path) · `none` = anonymous/self-hosted. Either way
 *  the resolved secret lands in the credential store; the driver's `connect` never cares which. */
export const Auth = Schema.Literals(["login", "key", "none"]).annotate({ identifier: "Messenger.Auth" })
export type Auth = typeof Auth.Type

/** Driver self-description the Settings UI renders the "Add account" form from. `settings` reuses
 *  the Integration prompt vocabulary (text/select fields); the SECRET (bot token or the user's
 *  session credential) never rides here — it goes through the credential store. `login` drivers
 *  additionally carry `loginPrompts` — the inputs the login wizard collects BEFORE the provider
 *  round-trip (phone number, optional 2FA password); the mid-flow code has its own prompt in the
 *  returned attempt's instructions. */
export interface DriverMeta extends Schema.Schema.Type<typeof DriverMeta> {}
export const DriverMeta = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  icon: Schema.String,
  auth: Auth,
  settings: Schema.Array(Integration.Prompt),
  loginPrompts: optional(Schema.Array(Integration.Prompt)),
  /** For `login` drivers, how the mid-flow step is completed. "code" (the default when absent) = the
   *  provider sends a code the user types back (Telegram SMS, Outlook device-code). "browser" = an
   *  auth-code + loopback flow: NovaClaw opens the browser to the provider's consent page and catches
   *  the 127.0.0.1 redirect, so there is NOTHING to type (Gmail's friendly "Sign in with Google").
   *  The login wizard renders a waiting state instead of a code field for "browser". */
  loginStyle: optional(Schema.Literals(["code", "browser"])),
  /** How a normal person GETS the credential this driver wants, in plain words. Some messengers
   *  hand it over in two clicks; a Discord bot takes a trip through a developer portal with an
   *  intent switch that fails silently if you miss it. Nobody should have to find a blog post to
   *  set up a support desk, so the driver carries its own recipe and the Add-account dialog shows
   *  it right where the empty field is (teach, don't gatekeep). Authored by the driver in English
   *  like `settings`/`loginPrompts` messages. */
  setup: optional(
    Schema.Struct({
      /** Where the journey starts — offered as a link the user can open. */
      url: optional(Schema.String),
      urlLabel: optional(Schema.String),
      /** Numbered steps. Each one sentence or two; name the exact buttons the provider uses. */
      steps: Schema.Array(Schema.String),
    }),
  ),
  capabilities: Capabilities,
}).annotate({ identifier: "Messenger.DriverMeta" })

/** A pending `login`-auth attempt (messenger-plan §0.2): begin (phone → the provider sends a
 *  code) hands back this ticket; complete(attemptID, code) finishes and stores the session
 *  credential. Mirrors the Integration attempt vocabulary (status responses ARE
 *  `Integration.AttemptStatus`) but lives in the messenger namespace — messenger accounts are
 *  instance-global while integration attempts are location-scoped. */
export const LoginAttemptID = Schema.String.check(Schema.isStartsWith("mla_")).pipe(
  Schema.brand("Messenger.LoginAttemptID"),
  statics((schema) => ({ create: () => schema.make("mla_" + ascending()) })),
)
export type LoginAttemptID = typeof LoginAttemptID.Type

export class LoginAttempt extends Schema.Class<LoginAttempt>("Messenger.LoginAttempt")({
  attemptID: LoginAttemptID,
  /** Human instructions for the next step ("Telegram sent a code to your app — enter it here"). */
  instructions: Schema.String,
  /** A scannable image (a `data:image/png;base64,…` URL) when the step is scanned, not typed —
   *  WhatsApp's linked-device QR. ROTATES: re-read it from the status route while the step is open
   *  (see `LoginStatus.qrImage`); the one here is only the first frame. */
  qrImage: optional(Schema.String),
  time: Schema.Struct({ created: Schema.Number, expires: Schema.Number }),
}) {}

/** The live state of a login attempt. Mirrors `Integration.AttemptStatus` (same status vocabulary)
 *  but carries the step's CURRENT presentation too, because some providers rotate it while the user
 *  is still acting on it: WhatsApp mints a fresh linked-device QR every ~20s and a stale one simply
 *  will not scan. The wizard polls this route and re-renders, so what's on screen is always live. */
export class LoginStatus extends Schema.Class<LoginStatus>("Messenger.LoginStatus")({
  status: Schema.Literals(["pending", "complete", "failed", "expired"]),
  /** Failure detail — present only for `failed`. */
  message: optional(Schema.String),
  /** The step's current human instructions (a pending attempt whose driver reports progress). */
  instructions: optional(Schema.String),
  /** The step's current scannable image, refreshed on every rotation. */
  qrImage: optional(Schema.String),
  time: Schema.Struct({ created: Schema.Number, expires: Schema.Number }),
}) {}

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
  /** EVERY chat carries the source label (ruling 7) — REQUIRED, because an absent label is exactly
   *  the "no evidence" state and that state has its own value (`Source.UNLABELLED`). Making it
   *  optional would hand back the ambiguity the tri-state exists to remove. */
  access: SourceLabel,
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
