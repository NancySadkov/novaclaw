import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { EmailImapSmtp } from "@novaclaw/core/messenger/driver/email-imap-smtp"
import type { EmailClient } from "@novaclaw/core/messenger/driver/email"

// P9 WIRE gate: the REAL raw IMAP/SMTP client (email-imap-smtp.ts) driven against an in-process
// IMAP+SMTP server over a real TCP socket (plaintext — `secure:false`). This exercises exactly the
// surface the pure-helper unit tests can't: socket buffering, the byte-exact IMAP literal reader,
// XOAUTH2 on the wire, the SELECT→UID FETCH→parse pipeline, and the SMTP EHLO/AUTH/DATA + dot-stuff
// round-trip. It is NOT a real Dovecot — the live Outlook OAuth run remains the fidelity gate — but
// it deterministically proves the client's protocol handling with zero external deps.

// The one inbound message the fake IMAP server serves on FETCH. Literals are byte-counted, so the
// header block's internal CRLFs ride inside the {n} literal (the whole point of the reader).
const HEADER =
  "From: Acme Client <client@acme.com>\r\n" +
  "Subject: Logo brief\r\n" +
  "Message-ID: <m5@acme.com>\r\n" +
  "References: <root@acme.com>\r\n" +
  "In-Reply-To: <root@acme.com>\r\n" +
  "Date: Wed, 22 Jul 2026 10:00:00 +0000\r\n"
const BODY = "Hi, I need a logo. Thanks!\r\n"

interface Conn {
  buf: string
  inData?: boolean
}

const imapState = { xoauth2: "", fetched: false }
const smtpState = { xoauth2: "", rcpt: "", data: "" }

let imapServer: Bun.TCPSocketListener<Conn>
let smtpServer: Bun.TCPSocketListener<Conn>

const linesOf = (conn: Conn, chunk: Uint8Array, onLine: (line: string) => void) => {
  conn.buf += Buffer.from(chunk).toString("utf8")
  let idx = conn.buf.indexOf("\r\n")
  while (idx !== -1) {
    const line = conn.buf.slice(0, idx)
    conn.buf = conn.buf.slice(idx + 2)
    onLine(line)
    idx = conn.buf.indexOf("\r\n")
  }
}

beforeAll(() => {
  // ── fake IMAP server ──
  imapServer = Bun.listen<Conn>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        ;(socket.data as Conn).buf = ""
        socket.write("* OK NovaClaw test IMAP ready\r\n")
      },
      data(socket, chunk) {
        linesOf(socket.data as Conn, chunk, (line) => {
          const sp = line.indexOf(" ")
          const tag = line.slice(0, sp)
          const rest = line.slice(sp + 1)
          const cmd = rest.split(" ")[0]?.toUpperCase()
          if (cmd === "AUTHENTICATE") {
            imapState.xoauth2 = rest.split(" ")[2] ?? ""
            socket.write(`${tag} OK authenticated\r\n`)
          } else if (cmd === "SELECT") {
            socket.write("* OK [UIDVALIDITY 42] UIDs valid\r\n")
            socket.write(`${tag} OK [READ-WRITE] SELECT completed\r\n`)
          } else if (cmd === "UID" && rest.toUpperCase().includes("FETCH")) {
            imapState.fetched = true
            socket.write(
              `* 1 FETCH (UID 5 BODY[HEADER.FIELDS (MESSAGE-ID IN-REPLY-TO REFERENCES FROM SUBJECT DATE)] {${Buffer.byteLength(HEADER)}}\r\n`,
            )
            socket.write(HEADER)
            socket.write(` BODY[TEXT] {${Buffer.byteLength(BODY)}}\r\n`)
            socket.write(BODY)
            socket.write(")\r\n")
            socket.write(`${tag} OK FETCH completed\r\n`)
          } else {
            socket.write(`${tag} OK\r\n`)
          }
        })
      },
    },
    data: { buf: "" } as Conn,
  })

  // ── fake SMTP server (plaintext, no STARTTLS since secure:false) ──
  smtpServer = Bun.listen<Conn>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        ;(socket.data as Conn).buf = ""
        socket.write("220 novaclaw test SMTP ready\r\n")
      },
      data(socket, chunk) {
        const conn = socket.data as Conn
        linesOf(conn, chunk, (line) => {
          if (conn.inData) {
            if (line === ".") {
              conn.inData = false
              socket.write("250 2.0.0 OK queued\r\n")
            } else {
              // Un-dot-stuff a leading ".." → ".".
              smtpState.data += (line.startsWith("..") ? line.slice(1) : line) + "\n"
            }
            return
          }
          const cmd = line.split(" ")[0]?.toUpperCase()
          if (cmd === "EHLO" || cmd === "HELO") socket.write("250-novaclaw\r\n250 AUTH XOAUTH2\r\n")
          else if (cmd === "AUTH") {
            smtpState.xoauth2 = line.split(" ")[2] ?? ""
            socket.write("235 2.7.0 Accepted\r\n")
          } else if (cmd === "MAIL") socket.write("250 2.1.0 OK\r\n")
          else if (cmd === "RCPT") {
            smtpState.rcpt = line.match(/<([^>]+)>/)?.[1] ?? ""
            socket.write("250 2.1.5 OK\r\n")
          } else if (cmd === "DATA") {
            conn.inData = true
            socket.write("354 End data with <CR><LF>.<CR><LF>\r\n")
          } else if (cmd === "QUIT") socket.write("221 2.0.0 Bye\r\n")
          else socket.write("250 OK\r\n")
        })
      },
    },
    data: { buf: "" } as Conn,
  })
})

afterAll(() => {
  imapServer?.stop(true)
  smtpServer?.stop(true)
})

describe("EmailImapSmtp wire client (real sockets, in-process servers)", () => {
  test("IMAP XOAUTH2 → SELECT → UID FETCH parses a threaded email; SMTP sends a threaded reply", async () => {
    const config = {
      imapHost: "127.0.0.1",
      imapPort: imapServer.port,
      smtpHost: "127.0.0.1",
      smtpPort: smtpServer.port,
      auth: { user: "me@outlook.com", accessToken: "access-tok" },
      secure: false,
    }
    let client: EmailClient | undefined
    try {
      client = await EmailImapSmtp.factory(config)

      // IMAP: the XOAUTH2 SASL response reached the server correctly.
      expect(Buffer.from(imapState.xoauth2, "base64").toString("utf8")).toBe(
        "user=me@outlook.com\x01auth=Bearer access-tok\x01\x01",
      )

      // FETCH + literal parse: the byte-counted header + text literals reassemble into a RawEmail.
      const { uidValidity, messages } = await client.fetchSince(0)
      expect(uidValidity).toBe(42)
      expect(imapState.fetched).toBe(true)
      expect(messages).toHaveLength(1)
      expect(messages[0]).toMatchObject({
        uid: 5,
        messageID: "m5@acme.com",
        fromAddress: "client@acme.com",
        fromName: "Acme Client",
        subject: "Logo brief",
        references: ["root@acme.com"],
        inReplyTo: "root@acme.com",
        text: "Hi, I need a logo. Thanks!",
      })

      // SMTP: a threaded reply round-trips through EHLO/AUTH/MAIL/RCPT/DATA + dot-stuffing.
      const result = await client.send({
        to: "client@acme.com",
        subject: "Re: Logo brief",
        text: "On it — draft by Friday.\n.a dotted line survives", // a leading-dot line exercises stuffing
        inReplyTo: "m5@acme.com",
        references: ["root@acme.com", "m5@acme.com"],
      })
      expect(result.messageID).toContain("@outlook.com")
      expect(smtpState.rcpt).toBe("client@acme.com")
      expect(Buffer.from(smtpState.xoauth2, "base64").toString("utf8")).toContain("auth=Bearer access-tok")
      expect(smtpState.data).toContain("To: client@acme.com")
      expect(smtpState.data).toContain("Subject: Re: Logo brief")
      expect(smtpState.data).toContain("In-Reply-To: <m5@acme.com>")
      expect(smtpState.data).toContain("References: <root@acme.com> <m5@acme.com>")
      expect(smtpState.data).toContain("On it — draft by Friday.")
      // The dot-stuffed line was un-stuffed by the server back to a single leading dot.
      expect(smtpState.data).toContain("\n.a dotted line survives")
    } finally {
      await client?.close()
    }
  })
})
