import { describe, expect } from "bun:test"
import { Duration, Effect, Layer, Stream } from "effect"
import { Messenger } from "@novaclaw/schema/messenger"
import { EmailDriver } from "@novaclaw/core/messenger/driver/email"
import type {
  DeviceCodeStart,
  EmailClient,
  OutboundEmail,
  PollResult,
  RawEmail,
  TokenSet,
} from "@novaclaw/core/messenger/driver/email"
import { EmailOAuth } from "@novaclaw/core/messenger/driver/email-oauth"
import { EmailImapSmtp } from "@novaclaw/core/messenger/driver/email-imap-smtp"
import type { ConnectContext } from "@novaclaw/core/messenger/driver"
import { testEffect } from "./lib/effect"

// P9 gate (notes/messenger-plan.md §8): the email driver's LOGIC — OAuth device-code login flow,
// IMAP-poll → thread-mapped inbound, durable UID cursor (+ UIDVALIDITY reset), and SMTP reply
// building — all against fake transport + OAuth seams. The raw IMAP/SMTP wire + the Microsoft HTTP
// calls are the live-gated factories (email-imap-smtp.ts / email-oauth.ts).

const it = testEffect(Layer.empty)

// ── pure helpers ────────────────────────────────────────────────────────────────────────────────

describe("EmailDriver pure helpers", () => {
  it.effect("normalizeSubject strips chained reply/forward prefixes", () =>
    Effect.sync(() => {
      expect(EmailDriver.normalizeSubject("Re: Fwd: Logo brief")).toBe("Logo brief")
      expect(EmailDriver.normalizeSubject("RE: RE: hi")).toBe("hi")
      expect(EmailDriver.normalizeSubject("Aw: Re[2]: Rechnung")).toBe("Rechnung")
      expect(EmailDriver.normalizeSubject("   ")).toBe("(no subject)")
    }),
  )

  it.effect("threadRoot binds a conversation: References root > In-Reply-To > own id", () =>
    Effect.sync(() => {
      expect(EmailDriver.threadRoot({ messageID: "m3", inReplyTo: "m2", references: ["m1", "m2"] })).toBe("m1")
      expect(EmailDriver.threadRoot({ messageID: "m2", inReplyTo: "m1", references: [] })).toBe("m1")
      expect(EmailDriver.threadRoot({ messageID: "m1" })).toBe("m1") // a new thread roots at itself
    }),
  )

  it.effect("buildReply threads the SMTP reply (Re: once, In-Reply-To + References chain)", () =>
    Effect.sync(() => {
      const email: RawEmail = {
        uid: 5,
        messageID: "m2",
        fromAddress: "client@acme.com",
        fromName: "Acme Client",
        subject: "Re: Logo brief",
        inReplyTo: "m1",
        references: ["m1"],
        at: 1000,
        text: "any progress?",
      }
      const reply = EmailDriver.buildReply(EmailDriver.threadStateFrom(email), "Draft attached.")
      expect(reply.to).toBe("client@acme.com")
      expect(reply.subject).toBe("Re: Logo brief") // not "Re: Re: ..."
      expect(reply.inReplyTo).toBe("m2")
      expect(reply.references).toEqual(["m1", "m2"])
      expect(reply.text).toBe("Draft attached.")
    }),
  )

  it.effect("toInbound maps a thread to a chat; the mailbox owner is a born operator", () =>
    Effect.sync(() => {
      const inbound = EmailDriver.toInbound(
        {
          uid: 1,
          messageID: "m1",
          fromAddress: "client@acme.com",
          fromName: "Acme",
          subject: "Logo brief",
          references: [],
          at: 2000,
          text: "need a logo",
        },
        "me@outlook.com",
      )
      expect(inbound.kind).toBe("message")
      if (inbound.kind !== "message") throw new Error("expected message")
      expect(inbound.chat).toEqual({ chatID: "m1", kind: "thread", title: "Logo brief" })
      expect(inbound.sender).toEqual({ id: "client@acme.com", name: "Acme", isSelf: false })
      // The owner writing from another client is a born-paired operator.
      const own = EmailDriver.toInbound(
        { uid: 2, messageID: "m2", fromAddress: "ME@Outlook.com", subject: "note", at: 3000, text: "hi" },
        "me@outlook.com",
      )
      if (own.kind !== "message") throw new Error("expected message")
      expect(own.sender.isSelf).toBe(true)
      expect(own.sender.owner).toBe(true)
    }),
  )
})

// ── OAuth response parsing (the pure half of the live-gated Microsoft client) ────────────────────

describe("EmailOAuth response parsing", () => {
  it.effect("device-code + token success + the RFC 8628 poll states + refresh rotation", () =>
    Effect.sync(() => {
      const start = EmailOAuth.parseDeviceCode({
        device_code: "dc",
        user_code: "WXYZ-1234",
        verification_uri: "https://microsoft.com/devicelogin",
        interval: 5,
        expires_in: 900,
      })
      expect(start.userCode).toBe("WXYZ-1234")
      expect(start.deviceCode).toBe("dc")

      const ok = EmailOAuth.parseTokenResponse({ access_token: "at", refresh_token: "rt", expires_in: 3600 }, 1000)
      expect(ok).toEqual({ kind: "token", token: { accessToken: "at", refreshToken: "rt", expiresAt: 1000 + 3600_000 } })

      expect(EmailOAuth.parseTokenResponse({ error: "authorization_pending" }, 0).kind).toBe("pending")
      expect(EmailOAuth.parseTokenResponse({ error: "slow_down" }, 0).kind).toBe("slow-down")
      expect(EmailOAuth.parseTokenResponse({ error: "authorization_declined" }, 0)).toMatchObject({ kind: "error", retryable: false })
      expect(EmailOAuth.parseTokenResponse({ error: "expired_token" }, 0)).toMatchObject({ kind: "error", retryable: false })

      // Refresh keeps the old refresh token when Microsoft doesn't rotate it; throws on an error body.
      const refreshed = EmailOAuth.parseRefreshResponse({ access_token: "at2", expires_in: 3600 }, "rt", 2000)
      expect(refreshed).toEqual({ accessToken: "at2", refreshToken: "rt", expiresAt: 2000 + 3600_000 })
      expect(() => EmailOAuth.parseRefreshResponse({ error: "invalid_grant", error_description: "revoked" }, "rt", 0)).toThrow("revoked")
    }),
  )
})

// ── raw IMAP/SMTP pure helpers (the testable half of the live-gated wire client) ──────────────────

describe("EmailImapSmtp pure helpers", () => {
  it.effect("xoauth2 + saslPlain encode the SASL initial responses (token vs app-password auth)", () =>
    Effect.sync(() => {
      const xo = EmailImapSmtp.xoauth2("me@outlook.com", "TOKEN")
      expect(Buffer.from(xo, "base64").toString("utf8")).toBe("user=me@outlook.com\x01auth=Bearer TOKEN\x01\x01")
      const plain = EmailImapSmtp.saslPlain("me@gmail.com", "app-pass")
      expect(Buffer.from(plain, "base64").toString("utf8")).toBe("\x00me@gmail.com\x00app-pass")
    }),
  )

  it.effect("decodeEncodedWords decodes RFC 2047 subjects/names (B + Q, folded, plain passthrough)", () =>
    Effect.sync(() => {
      // base64 UTF-8 (Cyrillic), Q-encoding (`_`=space, =XX), adjacent folded words, and a plain value.
      expect(EmailImapSmtp.decodeEncodedWords("=?UTF-8?B?0J/RgNC40LLQtdGC?=")).toBe("Привет")
      expect(EmailImapSmtp.decodeEncodedWords("=?UTF-8?Q?caf=C3=A9_au_lait?=")).toBe("café au lait")
      expect(EmailImapSmtp.decodeEncodedWords("=?UTF-8?B?4oKs?= 38,00")).toBe("€ 38,00")
      expect(EmailImapSmtp.decodeEncodedWords("Plain Subject")).toBe("Plain Subject")
    }),
  )

  it.effect("decodeEncodedWords round-trips CJK / Arabic / emoji cleanly (core-market non-Latin)", () =>
    Effect.sync(() => {
      // Build real base64 encoded-words from UTF-8 (no hand-encoding), then prove the decode restores
      // the exact original — the encoding paths our China/Russia/Arabic user base depends on.
      const b = (text: string) => `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`
      for (const text of ["你好，世界", "مرحبا بالعالم", "Здравствуй, мир", "予約の確認 🧩"]) {
        expect(EmailImapSmtp.decodeEncodedWords(b(text))).toBe(text)
      }
      // Q-encoded Chinese also decodes as UTF-8 (not per-byte latin1).
      const qp = `=?UTF-8?Q?${Buffer.from("你好", "utf8").toString("hex").replace(/(..)/g, "=$1").toUpperCase()}?=`
      expect(EmailImapSmtp.decodeEncodedWords(qp)).toBe("你好")
    }),
  )

  it.effect("parseHeaders unfolds continuations; messageIds + parseFrom extract the threading fields", () =>
    Effect.sync(() => {
      const headers = EmailImapSmtp.parseHeaders(
        ["From: Acme Client <client@acme.com>", "Subject: Re: Logo", "References: <a@x>", "  <b@x>", "Message-ID: <c@x>"].join("\r\n"),
      )
      expect(EmailImapSmtp.parseFrom(headers.get("from"))).toEqual({ address: "client@acme.com", name: "Acme Client" })
      expect(EmailImapSmtp.messageIds(headers.get("references"))).toEqual(["a@x", "b@x"]) // folded line joined
      expect(EmailImapSmtp.messageIds(headers.get("message-id"))).toEqual(["c@x"])
      expect(EmailImapSmtp.parseFrom("bare@x.com")).toEqual({ address: "bare@x.com" })
    }),
  )

  it.effect("assembleEmail builds a RawEmail; a missing Message-ID gets a UID-stable synthetic id", () =>
    Effect.sync(() => {
      const email = EmailImapSmtp.assembleEmail({
        uid: 7,
        headerBlock: "From: A <a@x>\r\nSubject: Hi\r\nIn-Reply-To: <p@x>\r\nReferences: <root@x> <p@x>\r\nMessage-ID: <m@x>",
        text: "body line\r\n",
        fallbackAt: 500,
      })
      expect(email).toMatchObject({ uid: 7, messageID: "m@x", fromAddress: "a@x", inReplyTo: "p@x", references: ["root@x", "p@x"], text: "body line" })
      const noId = EmailImapSmtp.assembleEmail({ uid: 9, headerBlock: "From: a@x\r\nSubject: x", text: "", fallbackAt: 0 })
      expect(noId.messageID).toBe("imap-uid-9@novaclaw.local")
    }),
  )

  it.effect("extractPlainText pulls the text/plain part from real MIME multipart bodies", () => {
    // The exact shape a real Gmail→Outlook message fetched as BODY[TEXT] (proven in the live gate).
    const multipart = [
      "--BOUND",
      'Content-Type: text/plain; charset="UTF-8"',
      "",
      "Hey, Nova! This is a test.",
      "",
      "--BOUND",
      'Content-Type: text/html; charset="UTF-8"',
      "",
      "<div>Hey, <b>Nova</b>!</div>",
      "--BOUND--",
    ].join("\r\n")
    return Effect.sync(() => {
      expect(EmailImapSmtp.extractPlainText(multipart)).toBe("Hey, Nova! This is a test.")
      // quoted-printable decode
      const qp = ["--B", "Content-Type: text/plain", "Content-Transfer-Encoding: quoted-printable", "", "caf=C3=A9 =", "au lait", "--B--"].join("\r\n")
      expect(EmailImapSmtp.extractPlainText(qp)).toBe("café au lait")
      // base64 decode
      const b64 = ["--B", "Content-Type: text/plain", "Content-Transfer-Encoding: base64", "", Buffer.from("hello world").toString("base64"), "--B--"].join("\r\n")
      expect(EmailImapSmtp.extractPlainText(b64)).toBe("hello world")
      // html-only falls back to stripped text
      const htmlOnly = ["--B", "Content-Type: text/html", "", "<p>Bold <b>text</b></p>", "--B--"].join("\r\n")
      expect(EmailImapSmtp.extractPlainText(htmlOnly)).toBe("Bold text")
      // a plain (non-MIME) body passes through untouched
      expect(EmailImapSmtp.extractPlainText("just a plain reply\n")).toBe("just a plain reply")
    })
  })

  it.effect("buildMime writes threaded headers; dotStuff escapes a leading-dot line + terminates", () =>
    Effect.sync(() => {
      const mime = EmailImapSmtp.buildMime(
        { to: "c@x", subject: "Re: Logo", text: "hi", inReplyTo: "m@x", references: ["root@x", "m@x"] },
        "me@outlook.com",
        "new@novaclaw",
      )
      expect(mime).toContain("To: c@x")
      expect(mime).toContain("In-Reply-To: <m@x>")
      expect(mime).toContain("References: <root@x> <m@x>")
      expect(mime).toContain("Message-ID: <new@novaclaw>")
      const stuffed = EmailImapSmtp.dotStuff("normal\n.hidden\nend")
      expect(stuffed).toContain("\r\n..hidden\r\n") // the leading dot is doubled
      expect(stuffed.endsWith("\r\n.\r\n")).toBe(true) // DATA terminator
    }),
  )
})

// ── the driver against fake seams ────────────────────────────────────────────────────────────────

const CLIENT_ID = "11111111-2222-3333-4444-555555555555"

const account = new Messenger.AccountInfo({
  id: Messenger.AccountID.make("msa_email"),
  driverID: "email",
  label: "My mailbox",
  enabled: true,
  settings: { email: "me@outlook.com", clientId: CLIENT_ID },
})

/** A fake OAuth device-code client: the first poll is pending, the next yields tokens. */
const makeFakeOAuth = () => {
  const state = { polls: 0, refreshed: 0, started: 0, lastRefreshToken: "" }
  const start: DeviceCodeStart = {
    userCode: "ABCD-EFGH",
    verificationUri: "https://microsoft.com/devicelogin",
    deviceCode: "dev_1",
    interval: 5,
    expiresIn: 900,
  }
  const token: TokenSet = { accessToken: "access_1", refreshToken: "refresh_1", expiresAt: 9_999_999_999_999 }
  const client = {
    startDeviceCode: async () => {
      state.started += 1
      return start
    },
    pollToken: async (deviceCode: string): Promise<PollResult> => {
      state.polls += 1
      if (deviceCode !== "dev_1") return { kind: "error", message: "unknown device code", retryable: false }
      return state.polls < 2 ? { kind: "pending" } : { kind: "token", token }
    },
    refresh: async (refreshToken: string): Promise<TokenSet> => {
      state.refreshed += 1
      state.lastRefreshToken = refreshToken
      return { accessToken: `access_${state.refreshed + 1}`, refreshToken, expiresAt: 9_999_999_999_999 }
    },
  }
  return { factory: () => client, state }
}

/** A fake mail transport: a queue of inbound emails served by fetchSince, and recorded sends. */
const makeFakeMail = () => {
  const state = {
    inbox: [] as RawEmail[],
    uidValidity: 100,
    sent: [] as OutboundEmail[],
    auth: undefined as string | undefined,
    closed: false,
  }
  const client: EmailClient = {
    fetchSince: async (sinceUid: number) => ({
      uidValidity: state.uidValidity,
      messages: state.inbox.filter((email) => email.uid > sinceUid),
    }),
    fetchRecent: async (limit: number) => ({ messages: state.inbox.slice(-limit) }),
    send: async (email) => {
      state.sent.push(email)
      return { messageID: `sent-${state.sent.length}` }
    },
    startUid: 0,
    uidValidity: state.uidValidity,
    close: async () => {
      state.closed = true
    },
  }
  const factory = async (config: { auth: { accessToken?: string; password?: string } }) => {
    state.auth = config.auth.accessToken ?? (config.auth.password ? `pw:${config.auth.password}` : undefined)
    return client
  }
  return { factory, state }
}

const ctxFor = (secret: string | undefined, cursorBox: { value: unknown }): ConnectContext => ({
  account,
  secret,
  cursor: {
    get: () => Effect.sync(() => cursorBox.value),
    set: (value) => Effect.sync(() => void (cursorBox.value = value)),
  },
})

const email = (over: Partial<RawEmail> & Pick<RawEmail, "uid" | "messageID">): RawEmail => ({
  fromAddress: "client@acme.com",
  fromName: "Acme Client",
  subject: "Logo brief",
  at: 1000,
  text: "hello",
  ...over,
})

const drainFor = <A>(effect: Effect.Effect<A>, predicate: (value: A) => boolean, label: string) =>
  Effect.gen(function* () {
    for (let round = 0; round < 200; round++) {
      const value = yield* effect
      if (predicate(value)) return value
      yield* Effect.sleep(Duration.millis(10))
    }
    return yield* Effect.die(`timeout waiting for ${label}`)
  })

describe("EmailDriver login (OAuth device-code)", () => {
  it.live("begin returns browser instructions; complete polls until authorized, storing the refresh token", () =>
    Effect.gen(function* () {
      const oauth = makeFakeOAuth()
      const mail = makeFakeMail()
      const driver = EmailDriver.make(mail.factory, oauth.factory, { pollIntervalMs: 5 })
      const pending = yield* driver.login!.begin({ account, inputs: {} }).pipe(Effect.scoped)
      expect(pending.instructions).toContain("ABCD-EFGH")
      expect(pending.instructions).toContain("microsoft.com/devicelogin")
      expect(oauth.state.started).toBe(1)

      // First complete: the user hasn't approved yet → retryable "still waiting".
      const first = yield* pending.complete("").pipe(Effect.flip)
      expect(first._tag).toBe("MessengerDriver.LoginCodeError")
      if (first._tag === "MessengerDriver.LoginCodeError") expect(first.retryable).toBe(true)

      // Second complete: approved → a stored credential carrying the refresh token (never the access token).
      const done = yield* pending.complete("")
      const stored = JSON.parse(done.session) as { refreshToken: string; email: string }
      expect(stored.refreshToken).toBe("refresh_1")
      expect(stored.email).toBe("me@outlook.com")
      expect(done.session).not.toContain("access_1")
    }),
  )
})

describe("EmailDriver connect (IMAP poll → thread mapping → SMTP reply)", () => {
  const signedIn = JSON.stringify({ refreshToken: "refresh_1", email: "me@outlook.com" })

  it.live("refreshes the token, polls threads into events, advances the UID cursor, and replies to the right thread", () =>
    Effect.gen(function* () {
      const oauth = makeFakeOAuth()
      const mail = makeFakeMail()
      mail.state.inbox = [
        email({ uid: 10, messageID: "m1", subject: "Logo brief", references: [], text: "need a logo" }),
        email({ uid: 11, messageID: "m2", subject: "Re: Bug report", fromAddress: "bob@acme.com", references: ["r0"], text: "still broken" }),
      ]
      const cursorBox = { value: undefined as unknown }
      const driver = EmailDriver.make(mail.factory, oauth.factory, { pollIntervalMs: 5 })

      yield* Effect.scoped(
        Effect.gen(function* () {
          const conn = yield* driver.connect(ctxFor(signedIn, cursorBox))
          // The refresh happened and the XOAUTH2 access token reached the transport.
          expect(oauth.state.refreshed).toBe(1)
          expect(mail.state.auth).toBe("access_2")

          const collected: string[] = []
          yield* Effect.forkScoped(
            conn.inbound.pipe(
              Stream.runForEach((event) =>
                Effect.sync(() => {
                  if (event.kind === "message") collected.push(`${event.chat.chatID}|${event.text}`)
                }),
              ),
            ),
          )
          yield* drainFor(Effect.sync(() => collected), (c) => c.length >= 2, "two threads delivered")
          // Thread mapping: message 2's chat is its References root "r0", not its own id.
          expect(collected).toContain("m1|need a logo")
          expect(collected).toContain("r0|still broken")

          // The durable cursor advanced to the newest UID.
          yield* drainFor(Effect.sync(() => cursorBox.value), (v) => (v as { uid?: number })?.uid === 11, "cursor at uid 11")
          expect(cursorBox.value).toEqual({ uid: 11, uidValidity: 100 })

          // Reply to the bug thread → a threaded SMTP reply to Bob, In-Reply-To m2.
          const outcome = yield* conn.send("r0", { text: "on it" })
          expect(outcome.messageID).toBe("sent-1")
          expect(mail.state.sent).toHaveLength(1)
          expect(mail.state.sent[0]).toMatchObject({
            to: "bob@acme.com",
            subject: "Re: Bug report",
            inReplyTo: "m2",
            text: "on it",
          })
        }),
      )
    }),
  )

  it.live("refuses to reply to a thread it has never received (email is reply-only — cold-start safe)", () =>
    Effect.gen(function* () {
      const oauth = makeFakeOAuth()
      const mail = makeFakeMail()
      const driver = EmailDriver.make(mail.factory, oauth.factory, { pollIntervalMs: 5 })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const conn = yield* driver.connect(ctxFor(signedIn, { value: undefined }))
          const refusal = yield* conn.send("unknown-thread", { text: "hi" }).pipe(Effect.flip)
          expect(refusal._tag).toBe("MessengerDriver.SendError")
          if (refusal._tag === "MessengerDriver.SendError") {
            expect(refusal.retryable).toBe(false)
            expect(refusal.reason).toContain("reply-only")
          }
        }),
      )
    }),
  )

  it.live("a UIDVALIDITY change resets the cursor so no mail is dropped (edge #10)", () =>
    Effect.gen(function* () {
      const oauth = makeFakeOAuth()
      const mail = makeFakeMail()
      mail.state.inbox = [email({ uid: 3, messageID: "m1", references: [], text: "first" })]
      // Start already positioned past uid 3 under a DIFFERENT validity — the mailbox was rebuilt.
      const cursorBox = { value: { uid: 3, uidValidity: 99 } as unknown }
      const driver = EmailDriver.make(mail.factory, oauth.factory, { pollIntervalMs: 5 })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const conn = yield* driver.connect(ctxFor(signedIn, cursorBox))
          const collected: string[] = []
          yield* Effect.forkScoped(
            conn.inbound.pipe(
              Stream.runForEach((event) =>
                Effect.sync(() => {
                  if (event.kind === "message" && event.text) collected.push(event.text)
                }),
              ),
            ),
          )
          // Under the new validity (100 ≠ 99) the old uid-3 position is void → the message re-delivers.
          yield* drainFor(Effect.sync(() => collected), (c) => c.includes("first"), "re-delivered under new validity")
          yield* drainFor(
            Effect.sync(() => cursorBox.value),
            (v) => (v as { uidValidity?: number })?.uidValidity === 100,
            "cursor adopts new validity",
          )
        }),
      )
    }),
  )

  it.live("a revoked/failed refresh PARKS the account as a challenge (never spins)", () =>
    Effect.gen(function* () {
      const mail = makeFakeMail()
      const oauthFactory = () => ({
        startDeviceCode: async () => ({ userCode: "x", verificationUri: "u", deviceCode: "d", interval: 5, expiresIn: 900 }),
        pollToken: async (): Promise<PollResult> => ({ kind: "pending" }),
        refresh: async () => {
          throw new Error("AADSTS700082: refresh token expired")
        },
      })
      const driver = EmailDriver.make(mail.factory, oauthFactory, { pollIntervalMs: 5 })
      const failure = yield* driver.connect(ctxFor(signedIn, { value: undefined })).pipe(Effect.scoped, Effect.flip)
      expect(failure._tag).toBe("MessengerDriver.ChallengeError")
      if (failure._tag === "MessengerDriver.ChallengeError") expect(failure.message).toContain("sign in again")
    }),
  )

  it.live("an app-password credential uses Basic Auth (no OAuth) — Gmail/generic path", () =>
    Effect.gen(function* () {
      const oauth = makeFakeOAuth()
      const mail = makeFakeMail()
      // A Gmail-style account: no clientId, the secret is the app password itself (not OAuth JSON).
      const gmail = new Messenger.AccountInfo({
        id: Messenger.AccountID.make("msa_gmail"),
        driverID: "email",
        label: "Gmail",
        enabled: true,
        settings: { email: "me@gmail.com", imapHost: "imap.gmail.com", smtpHost: "smtp.gmail.com" },
      })
      const driver = EmailDriver.make(mail.factory, oauth.factory, { pollIntervalMs: 5 })
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* driver.connect({
            account: gmail,
            secret: "abcd efgh ijkl mnop", // the app password
            cursor: { get: () => Effect.succeed(undefined), set: () => Effect.void },
          })
          // The password reached the transport as Basic Auth; OAuth was NOT invoked.
          expect(mail.state.auth).toBe("pw:abcd efgh ijkl mnop")
          expect(oauth.state.refreshed).toBe(0)
        }),
      )
    }),
  )

  it.live("history + listChats read recent inbox mail (the agent's 'summarize my emails' path)", () =>
    Effect.gen(function* () {
      const oauth = makeFakeOAuth()
      const mail = makeFakeMail()
      mail.state.inbox = [
        email({ uid: 1, messageID: "a", subject: "Invoice #42", fromAddress: "billing@acme.com", fromName: "Acme Billing", text: "Please pay." }),
        email({ uid: 2, messageID: "b", subject: "Re: Logo", fromAddress: "client@studio.com", fromName: "Studio", references: ["root"], text: "Looks great!" }),
      ]
      const driver = EmailDriver.make(mail.factory, oauth.factory, { pollIntervalMs: 5 })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const conn = yield* driver.connect(ctxFor(signedIn, { value: undefined }))
          if (conn.history === undefined || conn.listChats === undefined) throw new Error("email driver must expose read ops")

          const hist = yield* conn.history("inbox", 10)
          expect(hist.map((h) => h.senderName)).toEqual(["Acme Billing", "Studio"])
          expect(hist[0]?.text).toContain("Subject: Invoice #42")
          expect(hist[0]?.text).toContain("Please pay.")

          const chats = yield* conn.listChats()
          expect(chats.map((c) => c.title)).toEqual(["Invoice #42 — Acme Billing", "Logo — Studio"])
          expect(chats[1]?.chatID).toBe("root") // threaded reply → References root

          // Reading also remembers the thread, so a reply now addresses the right person.
          const reply = yield* conn.send("root", { text: "thanks!" })
          expect(reply.messageID).toBe("sent-1")
          expect(mail.state.sent[0]).toMatchObject({ to: "client@studio.com", subject: "Re: Logo" })
        }),
      )
    }),
  )
})
