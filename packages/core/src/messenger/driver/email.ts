export * as EmailDriver from "./email"

import { Effect, Queue, Stream } from "effect"
import type { Messenger } from "@novaclaw/schema/messenger"
import { MessengerFormat } from "../format"
import type {
  ChatSnapshot,
  Connection,
  ConnectContext,
  Driver,
  InboundEvent,
  LoginPending,
  LoginSupport,
} from "../driver"
import { ChallengeError, ConnectError, LoginCodeError, SendError } from "../driver"

// The EMAIL driver (messenger-plan §2.1, §0.2) — the strongest "agent covers while I'm AFK" fit:
// the agent logs into the user's OWN mailbox (IMAP poll + SMTP send) and answers client threads as
// them. An email CONVERSATION is a chat: chatID = the thread root (Message-ID / References chain),
// so a back-and-forth maps onto one bound session. Two seams keep ALL policy here and fake-tested:
//   - `EmailClient` — the IMAP+SMTP transport (raw-protocol factory in email-imap-smtp.ts);
//   - `OAuthClient` — the device-code login + token refresh (Microsoft factory in email-oauth.ts).
// Microsoft KILLED Basic Auth for personal Outlook/365 (full enforcement 2026-04-30), so `login`
// here is an OAuth2 device-code flow yielding a refresh token; `connect` refreshes it to an access
// token and authenticates IMAP/SMTP with XOAUTH2. The transport seam also accepts a plain password
// (for providers/local servers that still allow it), but the shipped auth is OAuth.
//
// The connection pump + read ops are provider-agnostic and shared via `makeConnect`; the sibling
// Gmail driver (email-gmail.ts) reuses them, differing only in host defaults and the auth flow
// (Google's auth-code + loopback "Sign in with Google" instead of the Microsoft device-code).

export const CAPS: Messenger.Capabilities = {
  listChats: "full", // we can list recent inbox threads on demand (fetchRecent), so an agent can read
  files: { up: false, down: false }, // MIME attachments are P9 residue (text threads first)
  edits: false,
  typing: false,
  threads: true,
  moderation: { delete: false, ban: false, kick: false, mute: false, pin: false },
  format: "plain",
  maxChars: 25_000, // a generous single-email body; longer replies chunk into several emails
}

// ── the mail transport seam (raw IMAP+SMTP behind email-imap-smtp.ts) ───────────────────────────

/** One inbound message, already normalized by the transport (IMAP ENVELOPE + text body → this). */
export interface RawEmail {
  /** The IMAP UID — monotonic within a UIDVALIDITY; the durable cursor (edge #10). */
  readonly uid: number
  /** The RFC 5322 Message-ID (angle brackets stripped). Synthesized if the mail lacked one. */
  readonly messageID: string
  readonly fromAddress: string
  readonly fromName?: string
  readonly subject: string
  /** In-Reply-To (one id) — the immediate parent. */
  readonly inReplyTo?: string
  /** References chain, oldest first — References[0] is the thread ROOT. */
  readonly references?: readonly string[]
  /** When the mail was sent (epoch ms). */
  readonly at: number
  readonly text: string
}

export interface OutboundEmail {
  readonly to: string
  readonly subject: string
  readonly text: string
  readonly inReplyTo?: string
  readonly references?: readonly string[]
}

export interface EmailClient {
  /** Fetch messages with UID strictly greater than `sinceUid` (0 = all). Returns the mailbox's
   *  current UIDVALIDITY so a validity CHANGE (mailbox rebuilt) resets the cursor, never drops mail. */
  readonly fetchSince: (sinceUid: number) => Promise<{ readonly uidValidity: number; readonly messages: readonly RawEmail[] }>
  /** The last `limit` inbox messages, newest last — the READ path an agent uses to summarize recent
   *  mail without waiting for new arrivals (drives the `history`/`listChats` ops). */
  readonly fetchRecent: (limit: number) => Promise<{ readonly messages: readonly RawEmail[] }>
  readonly send: (email: OutboundEmail) => Promise<{ readonly messageID: string }>
  /** The highest existing UID at connect — a FRESH inbound cursor starts here, so first connect
   *  delivers only NEW mail, never the whole back-catalogue (`UID FETCH 1:*` on a 14k inbox hangs). */
  readonly startUid: number
  readonly uidValidity: number
  readonly close: () => Promise<void>
}

export interface EmailAuth {
  readonly user: string
  /** XOAUTH2 access token — the shipped path (Outlook/Gmail). */
  readonly accessToken?: string
  /** A plain password — only for providers/local test servers that still allow Basic Auth. */
  readonly password?: string
}

export interface EmailTransportConfig {
  readonly imapHost: string
  readonly imapPort: number
  readonly smtpHost: string
  readonly smtpPort: number
  readonly auth: EmailAuth
  /** TLS on the wire (IMAP implicit TLS + SMTP STARTTLS). Default true — production ALWAYS uses it;
   *  only the in-process loopback wire test runs plaintext (`false`). */
  readonly secure?: boolean
}

export type EmailClientFactory = (config: EmailTransportConfig) => Promise<EmailClient>

// ── the OAuth device-code seam (Microsoft flow behind email-oauth.ts) ───────────────────────────

export interface DeviceCodeStart {
  readonly userCode: string
  readonly verificationUri: string
  readonly deviceCode: string
  readonly interval: number
  readonly expiresIn: number
}

export interface TokenSet {
  readonly accessToken: string
  readonly refreshToken: string
  /** epoch ms the access token expires. */
  readonly expiresAt: number
}

export type PollResult =
  | { readonly kind: "token"; readonly token: TokenSet }
  | { readonly kind: "pending" }
  | { readonly kind: "slow-down" }
  | { readonly kind: "error"; readonly message: string; readonly retryable: boolean }

export interface OAuthClient {
  readonly startDeviceCode: () => Promise<DeviceCodeStart>
  readonly pollToken: (deviceCode: string) => Promise<PollResult>
  readonly refresh: (refreshToken: string) => Promise<TokenSet>
}

export interface OAuthConfig {
  readonly clientId: string
  readonly tenant: string
  readonly scopes: readonly string[]
  readonly email: string
}

export type OAuthFactory = (config: OAuthConfig) => OAuthClient

// ── pure helpers (thread mapping / reply building — unit-tested away from any socket) ────────────

/** Strip a chain of reply/forward prefixes (Re:, Fwd:, Aw:, Sv:, …) so a thread's title is stable
 *  and readable. Case-insensitive; handles the `Re[2]:` numbered form and repeated prefixes. */
export const normalizeSubject = (subject: string): string => {
  let out = subject.trim()
  const prefix = /^(re|fwd|fw|aw|sv|antw|wg)(\[\d+\])?\s*:\s*/i
  while (prefix.test(out)) out = out.replace(prefix, "").trim()
  return out.length === 0 ? "(no subject)" : out
}

/** The thread id an email belongs to — the conversation's stable chat handle. The References ROOT
 *  wins (the whole chain shares it); else the immediate parent (In-Reply-To); else this is a NEW
 *  thread rooted at its own Message-ID. This is what binds a back-and-forth to one session. */
export const threadRoot = (email: Pick<RawEmail, "messageID" | "inReplyTo" | "references">): string => {
  const root = email.references?.find((ref) => ref.trim().length > 0)
  if (root !== undefined) return root.trim()
  if (email.inReplyTo !== undefined && email.inReplyTo.trim().length > 0) return email.inReplyTo.trim()
  return email.messageID
}

/** Per-thread reply state the driver remembers from inbound so `send(threadID, text)` can build a
 *  proper reply (recipient, subject, In-Reply-To/References) — the transport's send() gets only a
 *  chatID + text, exactly like IRC's reply-to-nick. Rebuilt in memory as mail arrives. */
export interface ThreadState {
  readonly to: string
  readonly subject: string
  readonly lastMessageID: string
  readonly references: readonly string[]
}

export const threadStateFrom = (email: RawEmail): ThreadState => ({
  to: email.fromAddress,
  subject: email.subject,
  lastMessageID: email.messageID,
  // Extend the chain: prior references + the parent we're replying to.
  references: [...(email.references ?? []), email.messageID].filter((ref) => ref.trim().length > 0),
})

/** Build the SMTP reply from remembered thread state — subject prefixed `Re:` (once), threading
 *  headers set so the recipient's client keeps it in the same conversation. */
export const buildReply = (state: ThreadState, text: string): OutboundEmail => {
  const base = normalizeSubject(state.subject)
  return {
    to: state.to,
    subject: `Re: ${base}`,
    text,
    inReplyTo: state.lastMessageID,
    references: state.references,
  }
}

/** Map a normalized inbound email onto the kernel event: the chat IS the thread. */
export const toInbound = (email: RawEmail, selfAddress: string): InboundEvent => {
  const root = threadRoot(email)
  const chat: ChatSnapshot = { chatID: root, kind: "thread", title: normalizeSubject(email.subject) }
  const isSelf = email.fromAddress.trim().toLowerCase() === selfAddress.trim().toLowerCase()
  return {
    kind: "message",
    chat,
    messageID: email.messageID,
    sender: {
      id: email.fromAddress,
      name: email.fromName?.trim() || email.fromAddress,
      isSelf,
      // The mailbox owner writing from another client is the operator (§0.1.5 turnkey), same as the
      // other `login` drivers — but only their OWN address, never a third party.
      ...(isSelf ? { owner: true } : {}),
    },
    text: email.text,
    ...(email.inReplyTo === undefined ? {} : { replyTo: email.inReplyTo }),
    at: email.at,
  }
}

// ── account config ──────────────────────────────────────────────────────────────────────────────

export interface EmailAccountConfig {
  readonly email: string
  readonly imapHost: string
  readonly imapPort: number
  readonly smtpHost: string
  readonly smtpPort: number
  /** Present only for the OAuth (login) auth path; a Basic-Auth (app-password) account omits it. */
  readonly clientId: string | undefined
  /** Google "Desktop app" clients pair the id with a (non-confidential) secret; Outlook's device-code
   *  flow needs none, so it stays undefined there. */
  readonly clientSecret: string | undefined
  readonly tenant: string
}

/** Provider host/port defaults an account's settings override. Outlook/365 is the generic `email`
 *  driver's target; the Gmail driver passes Gmail's defaults into the same parser. */
export interface EmailDefaults {
  readonly imapHost: string
  readonly imapPort: number
  readonly smtpHost: string
  readonly smtpPort: number
  readonly tenant: string
}

// Outlook/365 defaults (the shipped target of the generic `email` driver).
const OUTLOOK_DEFAULTS: EmailDefaults = {
  imapHost: "outlook.office365.com",
  imapPort: 993,
  smtpHost: "smtp.office365.com",
  smtpPort: 587,
  tenant: "consumers",
}

const OUTLOOK_SCOPES = [
  "https://outlook.office.com/IMAP.AccessAsUser.All",
  "https://outlook.office.com/SMTP.Send",
  "offline_access",
] as const

/** Parse an account's settings into transport config, filling host/port/tenant from `defaults`.
 *  Shared by the Outlook (`email`) and Gmail drivers — only the defaults differ. `clientId` is
 *  required ONLY for the OAuth path; a Basic-Auth (app-password) account leaves it empty. */
export const parseEmailConfig = (
  account: Messenger.AccountInfo,
  defaults: EmailDefaults,
): Effect.Effect<EmailAccountConfig, ConnectError> =>
  Effect.gen(function* () {
    const email = (account.settings["email"] ?? "").trim()
    const clientId = (account.settings["clientId"] ?? "").trim()
    const clientSecret = (account.settings["clientSecret"] ?? "").trim()
    if (email.length === 0)
      return yield* Effect.fail(new ConnectError({ reason: "This email account needs the mailbox address — fill it in Settings → Messengers." }))
    const port = (key: string, fallback: number) => {
      const value = Number((account.settings[key] ?? "").trim())
      return Number.isInteger(value) && value > 0 && value <= 65535 ? value : fallback
    }
    return {
      email,
      clientId: clientId.length > 0 ? clientId : undefined,
      clientSecret: clientSecret.length > 0 ? clientSecret : undefined,
      imapHost: (account.settings["imapHost"] ?? "").trim() || defaults.imapHost,
      imapPort: port("imapPort", defaults.imapPort),
      smtpHost: (account.settings["smtpHost"] ?? "").trim() || defaults.smtpHost,
      smtpPort: port("smtpPort", defaults.smtpPort),
      tenant: (account.settings["tenant"] ?? "").trim() || defaults.tenant,
    }
  })

/** The credential we store after login — the durable OAuth refresh token + what connect() needs to
 *  refresh it. NEVER the access token (short-lived) or a password. Serialized as the `session`. */
export interface StoredCredential {
  readonly refreshToken: string
  readonly email: string
}

export const parseStored = (secret: string): StoredCredential | undefined => {
  try {
    const value = JSON.parse(secret) as { refreshToken?: unknown; email?: unknown }
    if (typeof value.refreshToken === "string" && typeof value.email === "string")
      return { refreshToken: value.refreshToken, email: value.email }
  } catch {
    /* not our JSON shape */
  }
  return undefined
}

/** Turn a stored secret into `EmailAuth`: our OAuth JSON → refresh to an XOAUTH2 access token via
 *  `makeRefresh` (Microsoft or Google); anything else → a plain app password (Basic Auth). A
 *  non-transient refresh failure is a CHALLENGE (revoked consent / password change) so the account
 *  parks for the operator instead of spinning. Shared by both email-family drivers. */
export const resolveEmailAuth = (
  config: EmailAccountConfig,
  secret: string,
  makeRefresh: (config: EmailAccountConfig) => ((refreshToken: string) => Promise<TokenSet>) | undefined,
  providerLabel: string,
): Effect.Effect<EmailAuth, ConnectError | ChallengeError> =>
  Effect.gen(function* () {
    const stored = parseStored(secret)
    if (stored === undefined) return { user: config.email, password: secret }
    const refresh = makeRefresh(config)
    if (refresh === undefined)
      return yield* Effect.fail(
        new ConnectError({ reason: "This OAuth mailbox is missing its client ID — re-add it in Settings → Messengers." }),
      )
    const token = yield* Effect.tryPromise({
      try: () => refresh(stored.refreshToken),
      catch: (error) =>
        new ChallengeError({
          message: `${providerLabel} rejected the saved sign-in for ${config.email} (${String(error)}) — sign in again in Settings → Messengers.`,
        }),
    })
    return { user: config.email, accessToken: token.accessToken } satisfies EmailAuth
  })

// ── the shared connection (IMAP poll pump + SMTP send + read ops) ────────────────────────────────

const POLL_INTERVAL_MS = 15_000

/** Build the driver's `connect` for any email-family provider. Everything here is provider-agnostic
 *  — the IMAP UID cursor pump (durable resume, UIDVALIDITY reset), per-thread reply state, chunked
 *  SMTP send, and the read ops (history/listChats). The two provider-varying inputs are injected:
 *  `resolveConfig` (which host defaults) and `resolveAuth` (which OAuth refresh, or an app password). */
export const makeConnect =
  (
    mailFactory: EmailClientFactory,
    pollIntervalMs: number,
    resolveConfig: (account: Messenger.AccountInfo) => Effect.Effect<EmailAccountConfig, ConnectError>,
    resolveAuth: (config: EmailAccountConfig, secret: string) => Effect.Effect<EmailAuth, ConnectError | ChallengeError>,
  ) =>
  (ctx: ConnectContext) =>
    Effect.gen(function* () {
      const config = yield* resolveConfig(ctx.account)
      if (ctx.secret === undefined || ctx.secret.length === 0)
        return yield* Effect.fail(
          new ConnectError({ reason: "This mailbox isn't signed in yet — sign in (or paste an app password) in Settings → Messengers." }),
        )

      // Two auth kinds behind one driver (§0.2): the stored credential is EITHER our OAuth JSON
      // (refresh → XOAUTH2) OR a plain app password (Basic Auth). `resolveAuth` picks per provider;
      // the transport then chooses XOAUTH2 or SASL PLAIN from which field is set.
      const auth = yield* resolveAuth(config, ctx.secret)

      const client = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () =>
            mailFactory({
              imapHost: config.imapHost,
              imapPort: config.imapPort,
              smtpHost: config.smtpHost,
              smtpPort: config.smtpPort,
              auth,
            }),
          catch: (error) => new ConnectError({ reason: `Could not reach the mail server for ${config.email}: ${String(error)}` }),
        }),
        (open) => Effect.promise(() => open.close().catch(() => undefined)),
      )

      // Reply state per thread, rebuilt from inbound so send() can address the right person.
      const threads = new Map<string, ThreadState>()
      const queue = yield* Queue.unbounded<InboundEvent>()

      // Durable cursor: {uidValidity, uid}. A UIDVALIDITY change means the mailbox was rebuilt — the
      // old UIDs are meaningless, so reset to 0 and re-fetch (never silently drop) (edge #10).
      const readCursor = Effect.gen(function* () {
        const raw = yield* ctx.cursor.get().pipe(Effect.orElseSucceed(() => undefined))
        if (raw !== null && typeof raw === "object" && "uid" in raw && "uidValidity" in raw) {
          const value = raw as { uid: unknown; uidValidity: unknown }
          if (typeof value.uid === "number" && typeof value.uidValidity === "number") return value as { uid: number; uidValidity: number }
        }
        // No stored cursor → start at the current mailbox head, so the pump delivers only mail that
        // arrives AFTER this first connect (never the entire history). Persist it immediately.
        const fresh = { uid: client.startUid, uidValidity: client.uidValidity }
        yield* ctx.cursor.set(fresh).pipe(Effect.ignore)
        return fresh
      })

      const pump = Effect.gen(function* () {
        let cursor = yield* readCursor
        while (true) {
          const batch = yield* Effect.tryPromise({
            try: () => client.fetchSince(cursor.uidValidity === 0 ? 0 : cursor.uid),
            catch: (error) => new ConnectError({ reason: `Mail fetch failed for ${config.email}: ${String(error)}` }),
          })
          // A validity change invalidates our stored UID — restart from 0 against the new validity.
          if (batch.uidValidity !== cursor.uidValidity && cursor.uidValidity !== 0) {
            cursor = { uid: 0, uidValidity: batch.uidValidity }
          }
          for (const email of batch.messages) {
            if (email.uid <= cursor.uid && cursor.uidValidity === batch.uidValidity) continue
            const event = toInbound(email, config.email)
            // Remember the reply target BEFORE offering (send may fire as soon as the turn drains).
            if (event.kind === "message" && event.sender.isSelf !== true)
              threads.set(event.chat.chatID, threadStateFrom(email))
            yield* Queue.offer(queue, event)
            cursor = { uid: Math.max(cursor.uid, email.uid), uidValidity: batch.uidValidity }
            // Ack durably only AFTER admit-to-queue succeeds (at-least-once; the gateway dedups by
            // messageID). Persist per message so a crash never rewinds past delivered mail.
            yield* ctx.cursor.set(cursor).pipe(Effect.ignore)
          }
          yield* Effect.sleep(`${pollIntervalMs} millis`)
        }
      })
      yield* Effect.forkScoped(pump.pipe(Effect.catchCause(() => Queue.shutdown(queue))))

      let sentSeq = 0
      const send = (chatID: string, message: { text?: string }) =>
        Effect.gen(function* () {
          const text = message.text ?? ""
          if (text.length === 0) return { messageID: "0" }
          const state = threads.get(chatID)
          if (state === undefined)
            return yield* Effect.fail(
              new SendError({
                reason:
                  "No email thread to reply to here yet — email is reply-only (the driver answers a thread it has received). Wait for the client to write first.",
                retryable: false,
              }),
            )
          // Long replies chunk into several emails (each a proper threaded reply).
          const chunks = MessengerFormat.chunk(MessengerFormat.downgrade(text, "plain"), { maxChars: CAPS.maxChars })
          let last = { messageID: "0" }
          for (const chunk of chunks) {
            last = yield* Effect.tryPromise({
              try: () => client.send(buildReply(state, chunk)),
              catch: (error) => new SendError({ reason: `Could not send the email: ${String(error)}`, retryable: true }),
            })
          }
          sentSeq += 1
          return { messageID: last.messageID || `email-out-${sentSeq}` }
        })

      // The READ ops (the integration use case: an agent summarizing recent mail). `history` returns
      // the last `limit` inbox emails as chronological entries; `listChats` presents recent threads
      // so the agent can see what's in the inbox. Both remember reply state so a subsequent reply
      // addresses the right person (email is otherwise reply-only).
      const recent = (limit: number) =>
        Effect.tryPromise({
          try: () => client.fetchRecent(Math.max(1, Math.min(limit, 50))),
          catch: (error) => new ConnectError({ reason: `Could not read recent mail for ${config.email}: ${String(error)}` }),
        }).pipe(
          Effect.tap((batch) =>
            Effect.sync(() => {
              for (const mail of batch.messages) {
                const event = toInbound(mail, config.email)
                if (event.kind === "message" && event.sender.isSelf !== true) threads.set(event.chat.chatID, threadStateFrom(mail))
              }
            }),
          ),
        )

      const history = (_chatID: string, limit: number) =>
        recent(limit).pipe(
          Effect.map((batch) =>
            batch.messages.map((mail) => {
              const isSelf = mail.fromAddress.trim().toLowerCase() === config.email.trim().toLowerCase()
              return {
                messageID: mail.messageID,
                senderID: mail.fromAddress,
                senderName: mail.fromName?.trim() || mail.fromAddress,
                outgoing: isSelf,
                text: `${mail.subject ? `Subject: ${mail.subject}\n` : ""}${mail.text}`,
                at: mail.at,
              }
            }),
          ),
        )

      const listChats = () =>
        recent(20).pipe(
          Effect.map((batch) =>
            batch.messages.map((mail) => ({
              chatID: threadRoot(mail),
              kind: "thread" as const,
              title: normalizeSubject(mail.subject) + ` — ${mail.fromName?.trim() || mail.fromAddress}`,
            })),
          ),
        )

      return { inbound: Stream.fromQueue(queue), send, history, listChats } satisfies Connection
    })

// ── the driver (Outlook/365 + generic IMAP; OAuth device-code or app-password) ───────────────────

export const make = (
  mailFactory: EmailClientFactory,
  oauthFactory: OAuthFactory,
  options?: { readonly pollIntervalMs?: number },
): Driver => {
  const pollIntervalMs = options?.pollIntervalMs ?? POLL_INTERVAL_MS
  const oauthFor = (config: EmailAccountConfig, clientId: string): OAuthClient =>
    oauthFactory({ clientId, tenant: config.tenant, scopes: OUTLOOK_SCOPES, email: config.email })

  const login: LoginSupport = {
    begin: ({ account }) =>
      Effect.gen(function* () {
        const config = yield* parseEmailConfig(account, OUTLOOK_DEFAULTS)
        if (config.clientId === undefined)
          return yield* Effect.fail(
            new ConnectError({
              reason:
                "OAuth sign-in needs a client ID (an Azure app registration). Add it in Settings, or use an app-password account instead (paste the password as the secret — no OAuth).",
            }),
          )
        const oauth = oauthFor(config, config.clientId)
        const start = yield* Effect.tryPromise({
          try: () => oauth.startDeviceCode(),
          catch: (error) => new ConnectError({ reason: `Could not start Microsoft sign-in: ${String(error)}` }),
        })
        // Device-code: the user authorizes in a browser; `complete()` polls the token endpoint and
        // reports "still waiting" (retryable) until they finish. No code is typed back into NovaClaw.
        const complete: LoginPending["complete"] = () =>
          Effect.gen(function* () {
            const result = yield* Effect.tryPromise({
              try: () => oauth.pollToken(start.deviceCode),
              catch: (error) => new LoginCodeError({ reason: `Sign-in check failed: ${String(error)}`, retryable: true }),
            })
            if (result.kind === "pending" || result.kind === "slow-down")
              return yield* Effect.fail(
                new LoginCodeError({
                  reason: "Still waiting for you to approve the sign-in in your browser — finish that, then click Done again.",
                  retryable: true,
                }),
              )
            if (result.kind === "error")
              return yield* Effect.fail(
                result.retryable
                  ? new LoginCodeError({ reason: result.message, retryable: true })
                  : new ChallengeError({ message: result.message }),
              )
            const stored: StoredCredential = { refreshToken: result.token.refreshToken, email: config.email }
            return { session: JSON.stringify(stored) }
          })
        return {
          instructions: `Open ${start.verificationUri} in a browser and enter the code ${start.userCode} to sign ${config.email} in, then click Done.`,
          complete,
        } satisfies LoginPending
      }),
  }

  const connect = makeConnect(
    mailFactory,
    pollIntervalMs,
    (account) => parseEmailConfig(account, OUTLOOK_DEFAULTS),
    (config, secret) =>
      resolveEmailAuth(config, secret, (c) => (c.clientId === undefined ? undefined : oauthFor(c, c.clientId).refresh), "Microsoft"),
  )

  return {
    id: "email",
    meta: {
      id: "email",
      name: "Email (your mailbox)",
      icon: "speech-bubble",
      auth: "login",
      settings: [
        { type: "text", key: "email", message: "Your mailbox address", placeholder: "you@outlook.com" },
        {
          type: "text",
          key: "clientId",
          message: "OAuth client ID (Azure app registration — Microsoft requires OAuth for Outlook/365)",
          placeholder: "00000000-0000-0000-0000-000000000000",
        },
        { type: "text", key: "imapHost", message: "IMAP host (default: Outlook)", placeholder: OUTLOOK_DEFAULTS.imapHost },
        { type: "text", key: "imapPort", message: "IMAP port", placeholder: String(OUTLOOK_DEFAULTS.imapPort) },
        { type: "text", key: "smtpHost", message: "SMTP host (default: Outlook)", placeholder: OUTLOOK_DEFAULTS.smtpHost },
        { type: "text", key: "smtpPort", message: "SMTP port", placeholder: String(OUTLOOK_DEFAULTS.smtpPort) },
      ],
      // No upfront prompts: the device-code flow needs nothing typed — begin() returns a URL + code
      // to visit, and complete() polls until the browser consent lands.
      loginPrompts: [],
      capabilities: CAPS,
    },
    capabilities: () => CAPS,
    login,
    connect,
  }
}
