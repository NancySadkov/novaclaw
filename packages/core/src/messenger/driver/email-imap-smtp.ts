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
    const name = angle[1]!.trim().replace(/^"(.*)"$/, "$1").trim()
    return { address: angle[2]!.trim(), ...(name.length > 0 ? { name } : {}) }
  }
  return { address: value.trim() }
}

/** Best-effort RFC 5322 date → epoch ms (falls back to `fallback` on an unparseable date). */
export const parseDate = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? fallback : ms
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
    subject: (headers.get("subject") ?? "").trim(),
    ...(inReplyTo === undefined ? {} : { inReplyTo }),
    references,
    at: parseDate(headers.get("date"), input.fallbackAt),
    text: input.text.replace(/\r\n/g, "\n").trim(),
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
  const settle = () => {
    const w = wake
    wake = undefined
    w?.()
  }
  const handlers = {
    data: (_s: unknown, data: Buffer) => {
      buffer = Buffer.concat([buffer, data])
      settle()
    },
    close: () => {
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
      // Bun's socket.upgradeTLS returns a [raw, tls] tuple — swap to the TLS socket for later writes.
      const upgrade = (socket as unknown as { upgradeTLS?: (o: unknown) => [unknown, typeof socket] }).upgradeTLS
      if (typeof upgrade !== "function") throw new Error("STARTTLS not supported by this runtime (no socket.upgradeTLS)")
      const result = upgrade.call(socket, { hostname: tlsHost, socket: handlers })
      if (Array.isArray(result) && result[1]) socket = result[1] as typeof socket
    },
    close: () => void (socket as { end: () => void }).end(),
  }
}

// ── IMAP ──────────────────────────────────────────────────────────────────────────────────────

const HEADER_FIELDS = "MESSAGE-ID IN-REPLY-TO REFERENCES FROM SUBJECT DATE"

const imapConnect = async (config: EmailTransportConfig): Promise<{ stream: ByteStream; uidValidity: number }> => {
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
  await command(`AUTHENTICATE XOAUTH2 ${xoauth2(config.auth.user, config.auth.accessToken ?? "")}`)
  let uidValidity = 0
  await command("SELECT INBOX", {
    collectUntagged: (raw) => {
      const match = /UIDVALIDITY (\d+)/i.exec(raw)
      if (match) uidValidity = Number(match[1])
    },
  })
  return { stream, uidValidity }
}

// Parse one FETCH item block (the lines between a `* n FETCH (` and its close) into headers+text via
// the two BODY[...] literal segments we asked for.
const extractFetch = (block: string): { uid: number; headerBlock: string; text: string } | undefined => {
  const uid = /UID (\d+)/i.exec(block)?.[1]
  if (uid === undefined) return undefined
  // Our FETCH asks for BODY[HEADER.FIELDS (...)] then BODY[TEXT]; each arrives as `{n}<data>`.
  const segments = Array.from(block.matchAll(/\{(\d+)\}([\s\S]*?)(?=(?:BODY|\)|$))/g), (m) => m[2] ?? "")
  return { uid: Number(uid), headerBlock: segments[0] ?? "", text: segments[1] ?? "" }
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
  stream.write(`AUTH XOAUTH2 ${xoauth2(config.auth.user, config.auth.accessToken ?? "")}\r\n`)
  await expect("235")
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
  const { stream, uidValidity } = await imapConnect(config)
  let tag = 100
  const fetchSince: EmailClient["fetchSince"] = async (sinceUid) => {
    const id = `b${++tag}`
    const range = `${sinceUid + 1}:*`
    stream.write(`${id} UID FETCH ${range} (UID BODY.PEEK[HEADER.FIELDS (${HEADER_FIELDS})] BODY.PEEK[TEXT])\r\n`)
    const messages: RawEmail[] = []
    let current = ""
    const flush = () => {
      const parsed = current.trim().length > 0 ? extractFetch(current) : undefined
      if (parsed && parsed.uid > sinceUid)
        messages.push(assembleEmail({ uid: parsed.uid, headerBlock: parsed.headerBlock, text: parsed.text, fallbackAt: Date.now() }))
      current = ""
    }
    while (true) {
      const raw = await stream.line()
      const lit = /\{(\d+)\}$/.exec(raw)
      if (lit) {
        const data = await stream.readExact(Number(lit[1]))
        current += raw + data.toString("utf8")
        continue
      }
      if (raw.startsWith(`${id} `)) {
        flush()
        if (!/^\S+\s+OK/i.test(raw)) throw new Error(`IMAP UID FETCH failed: ${raw}`)
        break
      }
      if (/^\* \d+ FETCH/i.test(raw)) {
        flush()
        current = raw
      } else current += "\n" + raw
    }
    return { uidValidity, messages }
  }
  const send: EmailClient["send"] = async (email) => {
    const messageID = `novaclaw-${Date.now()}-${++outSeq}@${config.auth.user.split("@")[1] ?? "novaclaw.local"}`
    await smtpSend(config, buildMime(email, config.auth.user, messageID), email.to)
    return { messageID }
  }
  return { fetchSince, send, close: async () => stream.close() }
}
