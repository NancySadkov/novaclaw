export * as EmailImapSmtp from "./email-imap-smtp"

import type { EmailClient, EmailClientFactory, EmailTransportConfig, OutboundEmail, RawEmail } from "./email"

// The REAL raw-protocol IMAP+SMTP transport (messenger-plan §1.5, P9) — zero dependencies, just
// Bun's TCP/TLS. Kept in its own file like telegram-user-mtcute.ts; ⚠️ LIVE-GATED: the wire I/O is
// verified against a real server in the Outlook gate (needs the client_id + browser consent), not
// by unit tests. To shrink that unverified surface, the FIDDLY bits — SASL XOAUTH2 encoding, RFC
// 5322 header parsing, IMAP literal/FETCH extraction, the reply MIME — are PURE functions exported
// and unit-tested here; only the socket dance rides on the live gate.
//
// Auth is XOAUTH2 (the shipped path — Microsoft killed Basic Auth). IMAP uses implicit TLS (993);
// SMTP uses STARTTLS (587) via Bun's `socket.upgradeTLS`.

// ── pure helpers (unit-tested) ────────────────────────────────────────────────────────────────

/** The SASL XOAUTH2 initial client response (base64), per Google/Microsoft's XOAUTH2 spec:
 *  `user=<addr>^Aauth=Bearer <token>^A^A` where ^A is 0x01. Used for both IMAP and SMTP AUTH. */
export const xoauth2 = (user: string, accessToken: string): string =>
  Buffer.from(`user=${user}\x01auth=Bearer ${accessToken}\x01\x01`, "utf8").toString("base64")

/** The SASL PLAIN initial response (base64) — `\0user\0password` — for Basic-Auth providers
 *  (Gmail/Fastmail/Zoho app passwords, local test servers). The transport picks XOAUTH2 when an
 *  access token is present, PLAIN when a password is. */
export const saslPlain = (user: string, password: string): string =>
  Buffer.from(`\x00${user}\x00${password}`, "utf8").toString("base64")

/** The IMAP AUTHENTICATE argument for this account's auth kind (XOAUTH2 token vs PLAIN password). */
const imapAuth = (auth: { user: string; accessToken?: string; password?: string }): string =>
  auth.accessToken !== undefined && auth.accessToken.length > 0
    ? `AUTHENTICATE XOAUTH2 ${xoauth2(auth.user, auth.accessToken)}`
    : `AUTHENTICATE PLAIN ${saslPlain(auth.user, auth.password ?? "")}`

/** Unfold RFC 5322 headers (a continuation line starts with SP/TAB) and index them lower-cased.
 *  Only the header BLOCK is passed (everything before the blank line). Repeated headers keep the
 *  first (fine for the fields we read). */
export const parseHeaders = (headerBlock: string): Map<string, string> => {
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, " ")
  const out = new Map<string, string>()
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(":")
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    if (!out.has(key)) out.set(key, line.slice(colon + 1).trim())
  }
  return out
}

/** Every `<...>` message-id token in a header value (Message-ID has one; References has many). */
export const messageIds = (value: string | undefined): string[] => {
  if (value === undefined) return []
  return Array.from(value.matchAll(/<([^>]+)>/g), (m) => m[1]!.trim()).filter((id) => id.length > 0)
}

/** Split a `From:` value into address + optional display name. Handles `Name <a@b>` and bare `a@b`. */
export const parseFrom = (value: string | undefined): { address: string; name?: string } => {
  if (value === undefined) return { address: "" }
  const angle = value.match(/^(.*)<([^>]+)>\s*$/)
  if (angle) {
    const name = decodeEncodedWords(angle[1]!.trim().replace(/^"(.*)"$/, "$1").trim())
    return { address: angle[2]!.trim(), ...(name.length > 0 ? { name } : {}) }
  }
  return { address: value.trim() }
}

/** Decode RFC 2047 encoded-words in a header value — `=?charset?B?base64?=` / `=?charset?Q?qp?=` —
 *  so non-ASCII subjects and display names read as text, not `=?UTF-8?B?…?=`. Adjacent encoded-words
 *  separated by whitespace fold together (RFC 2047 §6.2). charset best-effort: UTF-8 + latin1. */
export const decodeEncodedWords = (value: string): string => {
  if (!value.includes("=?")) return value
  const folded = value.replace(/\?=\s+=\?/g, "?==?") // drop whitespace between adjacent words
  return folded.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (whole, charset: string, enc: string, text: string) => {
    try {
      const bytes =
        enc.toUpperCase() === "B"
          ? Buffer.from(text, "base64")
          : Buffer.from(
              text.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16))),
              "latin1",
            )
      return bytes.toString(/8859-1|latin1/i.test(charset) ? "latin1" : "utf8")
    } catch {
      return whole
    }
  })
}

/** Best-effort RFC 5322 date → epoch ms (falls back to `fallback` on an unparseable date). */
export const parseDate = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? fallback : ms
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Decode a MIME part body per its Content-Transfer-Encoding (base64 / quoted-printable / plain). */
const decodeCTE = (body: string, cte: string | undefined): string => {
  if (cte === "base64") {
    try {
      return Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf8")
    } catch {
      return body
    }
  }
  if (cte === "quoted-printable") {
    // Decode soft line breaks + `=XX` escapes to BYTES (latin1), then read as UTF-8 (an `=C3=A9`
    // pair is one UTF-8 char, not two latin1 chars).
    const bytes = body.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_m, h: string) => String.fromCharCode(parseInt(h, 16)))
    return Buffer.from(bytes, "latin1").toString("utf8")
  }
  return body
}

/** Best-effort strip of an HTML body to readable text (the fallback when there is no text/plain part). */
const stripHtml = (html: string): string =>
  html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>(?=)/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")

/**
 * Extract the human-readable plain text from a fetched BODY[TEXT] — real mail is usually MIME
 * multipart/alternative (text + HTML), so the raw body is boundary markers + both parts. Pull the
 * text/plain part (decoding base64 / quoted-printable), fall back to a stripped text/html part, else
 * return the body as-is (a non-MIME plain mail). One level of nesting (multipart/mixed wrapping
 * multipart/alternative) is followed; deeper structures are best-effort. Pure — unit-tested.
 */
export const extractPlainText = (raw: string): string => {
  const body = raw.replace(/\r\n/g, "\n")
  const boundary = body.match(/^--([^\s-][^\s]*?)-*\s*$/m)?.[1]
  if (boundary === undefined || !/content-type:/i.test(body)) return body.trim()
  const parts = body.split(new RegExp(`\\n?--${escapeRe(boundary)}(?:--)?[ \\t]*(?:\\n|$)`))
  let plain: string | undefined
  let html: string | undefined
  for (const part of parts) {
    const split = part.match(/^([\s\S]*?)\n\n([\s\S]*)$/)
    if (!split) continue
    const headers = split[1]!
    const content = split[2]!
    const ct = headers.match(/content-type:\s*([^;\n]+)/i)?.[1]?.toLowerCase().trim()
    const cte = headers.match(/content-transfer-encoding:\s*([^\n]+)/i)?.[1]?.toLowerCase().trim()
    if (ct?.startsWith("multipart/")) {
      const nested = extractPlainText(part)
      if (nested.length > 0 && plain === undefined) plain = nested
    } else if (ct === "text/plain") {
      if (plain === undefined) plain = decodeCTE(content, cte)
    } else if (ct === "text/html") {
      if (html === undefined) html = stripHtml(decodeCTE(content, cte))
    }
  }
  return (plain ?? html ?? body).trim()
}

/** Assemble a RawEmail from a fetched UID + its header block + text body. Pure — the whole
 *  message→event shape is testable without a socket. */
export const assembleEmail = (input: { uid: number; headerBlock: string; text: string; fallbackAt: number }): RawEmail => {
  const headers = parseHeaders(input.headerBlock)
  const from = parseFrom(headers.get("from"))
  const ownIds = messageIds(headers.get("message-id"))
  const references = messageIds(headers.get("references"))
  const inReplyTo = messageIds(headers.get("in-reply-to"))[0]
  return {
    uid: input.uid,
    // A mail with no Message-ID gets a synthetic, UID-stable one so threading + dedup still work.
    messageID: ownIds[0] ?? `imap-uid-${input.uid}@novaclaw.local`,
    fromAddress: from.address,
    ...(from.name === undefined ? {} : { fromName: from.name }),
    subject: decodeEncodedWords((headers.get("subject") ?? "").trim()),
    ...(inReplyTo === undefined ? {} : { inReplyTo }),
    references,
    at: parseDate(headers.get("date"), input.fallbackAt),
    // Real mail is MIME multipart — surface just the readable plain text to the agent.
    text: extractPlainText(input.text).replace(/\r\n/g, "\n").trim(),
  }
}

/** Serialize an outbound reply to an RFC 5322 message (CRLF lines; the leading dot is stuffed by the
 *  SMTP writer, not here). A fresh Message-ID is minted so our sends thread + can be referenced. */
export const buildMime = (email: OutboundEmail, from: string, messageID: string): string => {
  const headers = [
    `From: ${from}`,
    `To: ${email.to}`,
    `Subject: ${email.subject}`,
    `Message-ID: <${messageID}>`,
    ...(email.inReplyTo ? [`In-Reply-To: <${email.inReplyTo}>`] : []),
    ...(email.references && email.references.length > 0
      ? [`References: ${email.references.map((ref) => `<${ref}>`).join(" ")}`]
      : []),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
  ]
  return `${headers.join("\r\n")}\r\n\r\n${email.text.replace(/\n/g, "\r\n")}`
}

/** SMTP dot-stuffing + terminator for the DATA payload (a line that is just "." must be escaped). */
export const dotStuff = (message: string): string =>
  `${message.replace(/\r\n/g, "\n").replace(/^\./gm, "..").replace(/\n/g, "\r\n")}\r\n.\r\n`

// ── the live transport (Bun TCP/TLS) ──────────────────────────────────────────────────────────

// A minimal byte reader over a Bun socket: accumulate incoming bytes, hand out either the next
// CRLF-terminated line or an exact N-byte slice (IMAP literals). `read`/`readN` park a single
// waiter that the socket's data/close callbacks settle — never a busy-spin, never a hang.
interface ByteStream {
  readonly line: () => Promise<string>
  readonly readExact: (n: number) => Promise<Buffer>
  readonly write: (data: string) => void
  readonly upgradeTLS: (host: string) => Promise<void>
  readonly close: () => void
}

const connectStream = async (host: string, port: number, tls: boolean): Promise<ByteStream> => {
  let buffer = Buffer.alloc(0)
  let failed: Error | undefined
  let wake: (() => void) | undefined
  // After a STARTTLS upgrade the raw socket keeps emitting ENCRYPTED bytes to the same handlers, so
  // we must ignore anything not from the TLS socket or the ciphertext corrupts the plaintext stream.
  // Only relevant POST-upgrade (two sockets coexist); before that there is one socket and we accept
  // all data — guarding earlier would race the connect and drop the greeting.
  let tlsSocket: unknown
  // Resolves when the upgraded TLS socket finishes its handshake (its `open` fires) — writing before
  // that drops the plaintext, so upgradeTLS awaits it.
  let tlsReady: (() => void) | undefined
  const settle = () => {
    const w = wake
    wake = undefined
    w?.()
  }
  const handlers = {
    open: (s: unknown) => {
      if (s === tlsSocket && tlsReady !== undefined) {
        const resolve = tlsReady
        tlsReady = undefined
        resolve()
      }
    },
    data: (s: unknown, data: Buffer) => {
      if (tlsSocket !== undefined && s !== tlsSocket) return // leftover ciphertext from the raw socket
      buffer = Buffer.concat([buffer, data])
      settle()
    },
    close: (s: unknown) => {
      if (tlsSocket !== undefined && s !== tlsSocket) return
      failed ??= new Error("connection closed")
      settle()
    },
    error: (_s: unknown, error: Error) => {
      failed ??= error instanceof Error ? error : new Error(String(error))
      settle()
    },
  }
  let socket = await Bun.connect({ hostname: host, port, ...(tls ? { tls: true } : {}), socket: handlers as never })
  const waitMore = () =>
    new Promise<void>((resolve, reject) => {
      if (failed !== undefined) return reject(failed)
      wake = resolve
    })
  const line = async (): Promise<string> => {
    while (true) {
      const nl = buffer.indexOf(0x0a)
      if (nl !== -1) {
        const out = buffer.subarray(0, nl + 1).toString("utf8")
        buffer = buffer.subarray(nl + 1)
        return out.replace(/\r?\n$/, "")
      }
      if (failed !== undefined && buffer.length === 0) throw failed
      await waitMore()
    }
  }
  const readExact = async (n: number): Promise<Buffer> => {
    while (buffer.length < n) {
      if (failed !== undefined) throw failed
      await waitMore()
    }
    const out = buffer.subarray(0, n)
    buffer = buffer.subarray(n)
    return Buffer.from(out)
  }
  return {
    line,
    readExact,
    write: (data) => void (socket as { write: (d: string) => void }).write(data),
    upgradeTLS: async (tlsHost) => {
      // Bun's socket.upgradeTLS needs a `tls` option (SNI serverName) and returns a [raw, tls]
      // tuple. Switch reads+writes to the TLS socket, mark it active (so leftover raw ciphertext is
      // ignored), and DROP any bytes buffered before the handshake (they're the TLS handshake).
      const upgrade = (socket as unknown as { upgradeTLS?: (o: unknown) => [unknown, typeof socket] }).upgradeTLS
      if (typeof upgrade !== "function") throw new Error("STARTTLS not supported by this runtime (no socket.upgradeTLS)")
      const ready = new Promise<void>((resolve) => (tlsReady = resolve))
      const result = upgrade.call(socket, { tls: { serverName: tlsHost }, socket: handlers })
      if (Array.isArray(result) && result[1]) socket = result[1] as typeof socket
      tlsSocket = socket
      buffer = Buffer.alloc(0)
      // Wait for the handshake (the TLS socket's `open`) before returning, so the caller's next
      // write is encrypted rather than dropped. A bounded wait — a wedged handshake must not hang.
      await Promise.race([ready, new Promise<void>((resolve) => setTimeout(resolve, 15_000))])
    },
    close: () => void (socket as { end: () => void }).end(),
  }
}

// ── IMAP ──────────────────────────────────────────────────────────────────────────────────────

const HEADER_FIELDS = "MESSAGE-ID IN-REPLY-TO REFERENCES FROM SUBJECT DATE"

const imapConnect = async (config: EmailTransportConfig): Promise<{ stream: ByteStream; uidValidity: number; exists: number; uidNext: number }> => {
  const stream = await connectStream(config.imapHost, config.imapPort, config.secure !== false)
  await stream.line() // greeting (* OK ...)
  let tag = 0
  const command = async (text: string, opts?: { collectUntagged?: (line: string) => void; literals?: boolean }): Promise<string[]> => {
    const id = `a${++tag}`
    stream.write(`${id} ${text}\r\n`)
    const lines: string[] = []
    while (true) {
      const raw = await stream.line()
      // An IMAP literal `{n}` at end of an untagged line: the next n bytes are data, not lines.
      const lit = /\{(\d+)\}$/.exec(raw)
      if (lit && opts?.literals) {
        const data = await stream.readExact(Number(lit[1]))
        lines.push(raw + data.toString("utf8"))
        continue
      }
      if (raw.startsWith(`${id} `)) {
        if (!/^\S+\s+OK/i.test(raw)) throw new Error(`IMAP ${text.split(" ")[0]} failed: ${raw}`)
        return lines
      }
      opts?.collectUntagged?.(raw)
      lines.push(raw)
    }
  }
  await command(imapAuth(config.auth))
  let uidValidity = 0
  let exists = 0
  let uidNext = 0
  await command("SELECT INBOX", {
    collectUntagged: (raw) => {
      const validity = /UIDVALIDITY (\d+)/i.exec(raw)
      if (validity) uidValidity = Number(validity[1])
      const count = /^\* (\d+) EXISTS/i.exec(raw)
      if (count) exists = Number(count[1])
      const next = /UIDNEXT (\d+)/i.exec(raw)
      if (next) uidNext = Number(next[1])
    },
  })
  return { stream, uidValidity, exists, uidNext }
}

// ── SMTP ──────────────────────────────────────────────────────────────────────────────────────

const smtpSend = async (config: EmailTransportConfig, mime: string, to: string): Promise<void> => {
  const stream = await connectStream(config.smtpHost, config.smtpPort, false)
  const expect = async (prefix: string) => {
    let raw = await stream.line()
    // Multi-line replies: "250-..." continues, "250 ..." ends.
    while (/^\d{3}-/.test(raw)) raw = await stream.line()
    if (!raw.startsWith(prefix)) throw new Error(`SMTP expected ${prefix}, got: ${raw}`)
  }
  await expect("220")
  stream.write(`EHLO novaclaw\r\n`)
  await expect("250")
  if (config.secure !== false) {
    stream.write(`STARTTLS\r\n`)
    await expect("220")
    await stream.upgradeTLS(config.smtpHost)
    stream.write(`EHLO novaclaw\r\n`)
    await expect("250")
  }
  if (config.auth.accessToken !== undefined && config.auth.accessToken.length > 0) {
    stream.write(`AUTH XOAUTH2 ${xoauth2(config.auth.user, config.auth.accessToken)}\r\n`)
    await expect("235")
  } else {
    // Basic-Auth (app password): AUTH LOGIN — server prompts (334) for base64 user then password.
    stream.write(`AUTH LOGIN\r\n`)
    await expect("334")
    stream.write(`${Buffer.from(config.auth.user, "utf8").toString("base64")}\r\n`)
    await expect("334")
    stream.write(`${Buffer.from(config.auth.password ?? "", "utf8").toString("base64")}\r\n`)
    await expect("235")
  }
  stream.write(`MAIL FROM:<${config.auth.user}>\r\n`)
  await expect("250")
  stream.write(`RCPT TO:<${to}>\r\n`)
  await expect("250")
  stream.write(`DATA\r\n`)
  await expect("354")
  stream.write(dotStuff(mime))
  await expect("250")
  stream.write(`QUIT\r\n`)
  stream.close()
}

let outSeq = 0

export const factory: EmailClientFactory = async (config: EmailTransportConfig): Promise<EmailClient> => {
  const { stream, uidValidity, uidNext } = await imapConnect(config)
  // The highest EXISTING UID at connect — the driver starts the inbound cursor here so first
  // connect delivers only NEW mail, never the entire back-catalogue (a real inbox is huge: a live
  // Gmail had 14,408 messages, and `UID FETCH 1:*` on that hangs). History is served by fetchRecent.
  const startUid = Math.max(0, uidNext - 1)
  let tag = 100

  // ONE IMAP connection is shared by the background poll (fetchSince) and the read ops
  // (fetchRecent) — but IMAP is strictly one command at a time, so their tagged responses would
  // interleave and desync if they overlapped. Serialize every command through this lock.
  let lock: Promise<unknown> = Promise.resolve()
  const withLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = lock.then(fn, fn)
    lock = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  // Run one FETCH command and parse its items. Literals are read as EXACT BYTES (so multibyte UTF-8
  // is intact) and associated with their BODY[<label>] — because servers may REORDER the requested
  // items (Gmail returns BODY[TEXT] before BODY[HEADER.FIELDS] regardless of the request order), so
  // position can't be trusted; the label is authoritative. A FETCH-start line can itself carry the
  // UID and a trailing literal (`* 3 FETCH (UID 9 BODY[TEXT] {n}`), so it's handled in one pass.
  const runFetch = async (fetchCommand: string): Promise<RawEmail[]> => {
    const id = `b${++tag}`
    stream.write(`${id} ${fetchCommand}\r\n`)
    const items: { uid?: number; header?: string; text?: string }[] = []
    let cur: { uid?: number; header?: string; text?: string } | undefined
    const takeUid = (line: string) => {
      const u = /UID (\d+)/i.exec(line)
      if (u && cur) cur.uid = Number(u[1])
    }
    while (true) {
      const raw = await stream.line()
      if (raw.startsWith(`${id} `)) {
        if (cur) items.push(cur)
        if (!/^\S+\s+OK/i.test(raw)) throw new Error(`IMAP FETCH failed: ${raw}`)
        break
      }
      if (/^\* \d+ FETCH/i.test(raw)) {
        if (cur) items.push(cur)
        cur = {}
      }
      takeUid(raw)
      // A trailing literal `… BODY[<label>] {n}` (or a bare `{n}`) — read exactly n bytes as data.
      const labelled = /BODY\[([^\]]*)\][^{]*\{(\d+)\}\s*$/i.exec(raw)
      const bare = labelled ? null : /\{(\d+)\}\s*$/.exec(raw)
      if (labelled || bare) {
        const size = Number(labelled ? labelled[2] : bare![1])
        const data = (await stream.readExact(size)).toString("utf8")
        if (cur === undefined) cur = {}
        if (labelled && /HEADER/i.test(labelled[1]!)) cur.header = data
        else cur.text = data // BODY[TEXT] / BODY[] / an unlabelled literal
      }
    }
    return items
      .filter((item) => item.uid !== undefined)
      .map((item) => assembleEmail({ uid: item.uid!, headerBlock: item.header ?? "", text: item.text ?? "", fallbackAt: Date.now() }))
  }
  const BODY = `(UID BODY.PEEK[HEADER.FIELDS (${HEADER_FIELDS})] BODY.PEEK[TEXT])`

  const fetchSince: EmailClient["fetchSince"] = (sinceUid) =>
    withLock(async () => {
      const messages = (await runFetch(`UID FETCH ${sinceUid + 1}:* ${BODY}`)).filter((m) => m.uid > sinceUid)
      return { uidValidity, messages }
    })
  // The last `limit` inbox messages — a fresh SELECT INBOX refreshes the EXISTS count, then a
  // sequence-number range fetches the tail. The read ops (history / listChats) that let an agent
  // summarize recent mail without waiting for new arrivals. Serialized with the poll (one connection).
  const fetchRecent: EmailClient["fetchRecent"] = (limit) =>
    withLock(async () => {
      let exists = 0
      const id = `b${++tag}`
      stream.write(`${id} SELECT INBOX\r\n`)
      while (true) {
        const raw = await stream.line()
        const count = /^\* (\d+) EXISTS/i.exec(raw)
        if (count) exists = Number(count[1])
        if (raw.startsWith(`${id} `)) break
      }
      if (exists === 0) return { messages: [] }
      const start = Math.max(1, exists - limit + 1)
      return { messages: await runFetch(`FETCH ${start}:${exists} ${BODY}`) }
    })
  const send: EmailClient["send"] = async (email) => {
    const messageID = `novaclaw-${Date.now()}-${++outSeq}@${config.auth.user.split("@")[1] ?? "novaclaw.local"}`
    await smtpSend(config, buildMime(email, config.auth.user, messageID), email.to)
    return { messageID }
  }
  return { fetchSince, fetchRecent, send, startUid, uidValidity, close: async () => stream.close() }
}
