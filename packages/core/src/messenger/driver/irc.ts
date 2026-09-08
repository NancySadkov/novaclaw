export * as IrcDriver from "./irc"

import { createHash } from "node:crypto"
import { Effect, Queue, Stream } from "effect"
import type { Messenger } from "@novaclaw/schema/messenger"
import { MessengerWire } from "../wire"
import type { ChatSnapshot, Connection, ConnectContext, Driver, InboundEvent } from "../driver"
import { ConnectError, SendError, withAbortSignal } from "../driver"

// The IRC driver (messenger-plan §2.1) — the contract's DEGRADATION FLOOR: no files, no edits,
// no message ids from the platform (we DERIVE them — see `messageIDOf`), no chat enumeration (join-by-name; the
// gateway's seen-cache + the picker's manual handle entry are the list). Raw line protocol over
// TCP/TLS behind an injectable socket seam, so tests drive a fake socket and production uses
// `Bun.connect`. Lines budget BYTES (RFC 1459: 512 incl. command + CRLF) — the byte-mode chunker
// (format.ts) guarantees no UTF-8 code point is ever severed (edge #17).

/** What the driver needs from a socket: line-out, batched line-in (holds when empty — the scoped
 *  pump interrupt ends the wait, mirroring the other drivers' long-poll hold), close. */
export interface IrcSocket {
  readonly send: (line: string) => Promise<void>
  readonly lines: () => Promise<readonly string[]>
  readonly close: () => Promise<void>
}

export type IrcSocketFactory = (target: {
  readonly host: string
  readonly port: number
  readonly tls: boolean
}) => Promise<IrcSocket>

// 512 bytes minus "PRIVMSG " + a generous target + " :" + CRLF — a safe fixed text budget.
const LINE_TEXT_BYTES = 400

const CAPS: Messenger.Capabilities = {
  listChats: "none", // join-by-name; seen chats accumulate from traffic
  files: { up: false, down: false },
  edits: false,
  threads: false,
  moderation: { delete: false, ban: false, kick: false, mute: false, pin: false },
  format: "plain",
  maxChars: LINE_TEXT_BYTES,
}

/** One parsed server line: optional IRCv3 tags, optional prefix, command, params (trailing folded
 *  in last). `tags` is ABSENT (never an empty object) on the ordinary untagged line. */
export interface IrcLine {
  readonly tags?: Readonly<Record<string, string>>
  readonly prefix?: string
  readonly command: string
  readonly params: readonly string[]
}

// IRCv3 tag-value escapes. A backslash before anything else is dropped and the character kept,
// which is what the spec says to do with an undefined escape.
const TAG_ESCAPES: Readonly<Record<string, string>> = { ":": ";", s: " ", "\\": "\\", r: "\r", n: "\n" }

const unescapeTagValue = (raw: string): string => {
  if (!raw.includes("\\")) return raw
  let out = ""
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]
    if (char !== "\\") {
      out += char
      continue
    }
    index += 1
    const escaped = raw[index]
    if (escaped === undefined) break // a trailing lone backslash is dropped
    out += TAG_ESCAPES[escaped] ?? escaped
  }
  return out
}

export const parseLine = (raw: string): IrcLine | undefined => {
  let rest = raw.replace(/\r?\n$/, "")
  if (rest.length === 0) return undefined
  // IRCv3 message tags: `@key=value;flag :prefix CMD …`. We do not negotiate the caps that make a
  // server send them, so this is defensive rather than expected — but a bouncer or proxy in front
  // of the server can add them, and without this branch the whole tag blob was read as the COMMAND
  // and the message silently vanished. When they are present they carry the two things IRC
  // otherwise denies us: `msgid` (a provider-issued id) and `time` (the server's own timestamp).
  let tags: Record<string, string> | undefined
  if (rest.startsWith("@")) {
    const space = rest.indexOf(" ")
    if (space === -1) return undefined
    const parsed: Record<string, string> = {}
    for (const pair of rest.slice(1, space).split(";")) {
      if (pair.length === 0) continue
      const equals = pair.indexOf("=")
      const key = equals === -1 ? pair : pair.slice(0, equals)
      if (key.length === 0) continue
      parsed[key] = equals === -1 ? "" : unescapeTagValue(pair.slice(equals + 1))
    }
    tags = parsed
    rest = rest.slice(space + 1).replace(/^ +/, "")
    if (rest.length === 0) return undefined
  }
  let prefix: string | undefined
  if (rest.startsWith(":")) {
    const space = rest.indexOf(" ")
    if (space === -1) return undefined
    prefix = rest.slice(1, space)
    rest = rest.slice(space + 1)
  }
  const params: string[] = []
  let trailing: string | undefined
  const colon = rest.indexOf(" :")
  if (colon !== -1) {
    trailing = rest.slice(colon + 2)
    rest = rest.slice(0, colon)
  }
  const parts = rest.split(" ").filter((part) => part.length > 0)
  const command = parts[0]
  if (command === undefined) return undefined
  params.push(...parts.slice(1))
  if (trailing !== undefined) params.push(trailing)
  return { ...(tags === undefined ? {} : { tags }), prefix, command: command.toUpperCase(), params }
}

// NUL is the one byte an IRC line can never carry, so it is the field separator the digest below
// joins on: no combination of sender, target and text can be re-cut into a different message that
// hashes the same. Built from a char code rather than written as an escape, so the byte in this
// file stays printable.
const FIELD_SEPARATOR = String.fromCharCode(0)

/**
 * 🔴 **The id the durable inbound ledger keys on** — `messenger_inbound` is
 * `(account, chat, message_id)`, and `sql.ts` says in as many words that the key must be the
 * PROVIDER's message id, because that is the only identifier that survives a replay.
 *
 * IRC hands us no id on a bare connection, and the obvious substitute — a counter minted per
 * connection — is the one thing that must never be used. It restarts at 1 every time the socket
 * comes back, so after a reconnect the first messages of the new session collide with rows the
 * PREVIOUS session already wrote, the gateway reads them as `delivered`, and the account goes
 * **silently deaf** until the counter climbs past wherever it stopped. Nothing logs, nothing
 * fails; the messages are simply never routed.
 *
 * So the id is derived, in the order the key demands:
 *
 *  · an IRCv3 `msgid` tag is a provider-issued id and is used verbatim — it is also the only form
 *    that dedupes a bouncer's history playback, which is the case the ledger exists for;
 *  · otherwise the id is content-addressed over the line and its timestamp (the `time` tag when
 *    the server sends one, else the moment we read the line). Deterministic, so the same line seen
 *    twice derives the same id, and distinct across reconnects, because the timestamp is.
 *
 * ⚠️ **The derived arm is not unique by itself**: two byte-identical messages from one sender
 * inside a single millisecond hash alike. The connect loop de-collides them; keeping this function
 * pure is what lets the derivation be tested on its own. (When a `time` tag IS present, identical
 * content at an identical server timestamp is the same message, so collapsing them is correct.)
 */
export const messageIDOf = (line: IrcLine, receivedAt: number): string => {
  const provider = line.tags?.["msgid"]
  if (provider !== undefined && provider.length > 0) return provider
  const at = line.tags?.["time"] ?? String(receivedAt)
  const digest = createHash("sha1")
    .update([at, line.prefix ?? "", line.command, ...line.params].join(FIELD_SEPARATOR))
    .digest("hex")
  return `irc-${digest.slice(0, 24)}`
}

/** A middle parameter: no line break (it would end the record), no space (it would start the NEXT
 *  parameter), no leading colon (it would start the trailing). Deleted rather than replaced with a
 *  space — a space is the very thing a middle param may not carry. */
const middleParam = (value: string): string => MessengerWire.flatten(value, "").replaceAll(" ", "").replace(/^:+/, "")

/**
 * 🔴 **The one place an IRC line is produced.** RFC 2812 §2.3 — `<command> <middle>* [" :" trailing]`
 * terminated by CRLF — so a CR, LF or NUL anywhere inside a value does not corrupt the line, it ENDS
 * it, and the server reads the remainder as a *second command issued by our nick*: JOIN, PART, KICK,
 * QUIT, `PRIVMSG NickServ`. A space inside a middle parameter is the same shape one level down: it
 * starts a new parameter, so an unvalidated target can move the message to another channel.
 *
 * Neither is the caller's problem — the caller is precisely who forgets, because interpolating the
 * value straight into the template is the shorter call and it works on every input anyone types by
 * hand. `trailing` is the only field allowed to carry spaces: the ` :` marker runs it to end-of-line.
 */
export const formatCommand = (command: string, params: readonly string[], trailing?: string): string => {
  const head = [middleParam(command), ...params.map(middleParam)].filter((part) => part.length > 0).join(" ")
  return trailing === undefined ? head : `${head} :${MessengerWire.flatten(trailing)}`
}

/** The nick half of a `nick!user@host` prefix. */
export const nickOf = (prefix: string | undefined): string => prefix?.split("!")[0] ?? "server"

const isChannel = (target: string): boolean => target.startsWith("#") || target.startsWith("&")

/** Map one PRIVMSG onto the normalized event. A channel message's chat is the channel; a DM's
 *  chat is the SENDER's nick (that is the conversation handle you reply to). CTCP (\x01…) is
 *  protocol noise, not chat. Returns undefined for lines that are not chat messages. */
export const toInbound = (line: IrcLine, selfNick: string, messageID: string): InboundEvent | undefined => {
  if (line.command !== "PRIVMSG") return undefined
  const target = line.params[0]
  const text = line.params[1]
  if (target === undefined || text === undefined) return undefined
  if (text.charCodeAt(0) === 1) return undefined // CTCP ( VERSION/ACTION/… — protocol noise)
  const sender = nickOf(line.prefix)
  const channel = isChannel(target)
  // Ruling 7: a private message is correspondence (`private`); a channel may be open, +s (secret)
  // or +k (keyed) and PRIVMSG says nothing about which, so the honest proposal is no proposal.
  const chat: ChatSnapshot = channel
    ? { chatID: target, kind: "group", title: target, proposedAccess: "unknown" }
    : { chatID: sender, kind: "dm", title: sender, proposedAccess: "private" }
  return {
    kind: "message",
    chat,
    messageID,
    sender: {
      id: sender,
      name: sender,
      isSelf: sender.toLowerCase() === selfNick.toLowerCase(),
    },
    text,
    at: Date.now(),
  }
}

export const make = (factory: IrcSocketFactory): Driver => ({
  id: "irc",
  meta: {
    id: "irc",
    name: "IRC",
    icon: "speech-bubble",
    // `key` carries the optional NickServ password through the credential store (never a
    // plaintext settings field); an unregistered nick simply leaves it empty.
    auth: "key",
    settings: [
      { type: "text", key: "host", message: "IRC server host", placeholder: "irc.libera.chat" },
      { type: "text", key: "port", message: "Port (6697 is the usual TLS port)", placeholder: "6697" },
      { type: "text", key: "tls", message: "Use TLS? (yes/no)", placeholder: "yes" },
      { type: "text", key: "nick", message: "Nickname the agent connects as", placeholder: "nova-agent" },
      {
        type: "text",
        key: "channels",
        message:
          "Channels to join at connect, comma-separated (a channel can also be typed by hand in the chat picker)",
        placeholder: "#novaclaw, #support",
      },
    ],
    capabilities: CAPS,
  },
  capabilities: () => CAPS,
  connect: (ctx: ConnectContext) =>
    Effect.gen(function* () {
      const host = (ctx.account.settings["host"] ?? "").trim()
      const nick = (ctx.account.settings["nick"] ?? "").trim()
      const port = Number((ctx.account.settings["port"] ?? "6697").trim() || "6697")
      const tls = (ctx.account.settings["tls"] ?? "yes").trim().toLowerCase() !== "no"
      if (host.length === 0 || nick.length === 0)
        return yield* Effect.fail(
          new ConnectError({
            reason: "This IRC account needs a server host and a nickname — fill both in Settings → Messengers.",
          }),
        )
      if (!Number.isInteger(port) || port <= 0 || port > 65535)
        return yield* Effect.fail(
          new ConnectError({ reason: `"${ctx.account.settings["port"]}" is not a valid port.` }),
        )
      const channels = (ctx.account.settings["channels"] ?? "")
        .split(",")
        .map((channel) => channel.trim())
        .filter((channel) => channel.length > 0)

      const socket = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => factory({ host, port, tls }),
          catch: (error) => new ConnectError({ reason: `Could not reach ${host}:${port} — ${String(error)}` }),
        }),
        (open) => Effect.promise(() => open.close().catch(() => undefined)),
      )
      // ⚠️ Every write goes through `formatCommand` — a raw `socket.send` is the call this driver
      // does not make, because a value reaching the wire unserialized is how a chat id or a
      // password becomes an IRC command.
      const sendCommand = (command: string, params: readonly string[], trailing?: string) =>
        Effect.tryPromise({
          try: (signal) => withAbortSignal(signal, () => socket.send(formatCommand(command, params, trailing)), socket.close),
          catch: (error) => new ConnectError({ reason: `IRC write failed: ${String(error)}` }),
        })

      // Registration: NICK + USER; the server's 001 welcome confirms. NickServ IDENTIFY + JOINs
      // ride after the welcome (sending them earlier is legal but widely dropped).
      yield* sendCommand("NICK", [nick])
      const user = nick.replaceAll(/[^A-Za-z0-9]/g, "").slice(0, 10) || "novaclaw"
      yield* sendCommand("USER", [user, "0", "*"], "NovaClaw")

      const queue = yield* Queue.unbounded<InboundEvent, ConnectError>()
      // The same-millisecond de-collider for `messageIDOf`'s derived arm (its doc comment carries
      // the why). Two byte-identical messages from one sender inside one millisecond derive one
      // id, and the gateway's ledger would read the second as a replay and drop it — a silent
      // loss, which is the same class of fault the derivation exists to end. Only ids issued at
      // the CURRENT millisecond are held, so the set resets constantly and never grows.
      // ⚠️ Provider ids (`msgid`) are never passed through here: a repeated provider id IS the
      // same message, and de-colliding it would resurrect the double-delivery the ledger stops.
      let stampMs = -1
      let issued = new Set<string>()
      const disambiguate = (id: string, at: number): string => {
        if (at !== stampMs) {
          stampMs = at
          issued = new Set()
        }
        let candidate = id
        for (let nth = 2; issued.has(candidate); nth += 1) candidate = `${id}-${nth}`
        issued.add(candidate)
        return candidate
      }
      const pump = Effect.gen(function* () {
        while (true) {
          const batch = yield* Effect.tryPromise({
            try: () => socket.lines(),
            catch: (error) => new ConnectError({ reason: `IRC connection lost: ${String(error)}` }),
          })
          for (const raw of batch) {
            const line = parseLine(raw)
            if (line === undefined) continue
            switch (line.command) {
              case "PING":
                yield* sendCommand("PONG", [], line.params[0] ?? "")
                continue
              case "001": {
                // Registered. Identify (secret = the NickServ password), then join the rooms.
                if (ctx.secret !== undefined && ctx.secret.length > 0)
                  yield* sendCommand("PRIVMSG", ["NickServ"], `IDENTIFY ${ctx.secret}`)
                for (const channel of channels) yield* sendCommand("JOIN", [channel])
                continue
              }
              case "433":
                return yield* Effect.fail(
                  new ConnectError({
                    reason: `The nickname "${nick}" is already in use on ${host} — pick another in Settings.`,
                  }),
                )
              case "ERROR":
                return yield* Effect.fail(
                  new ConnectError({
                    reason: `${host} closed the connection: ${line.params.at(-1) ?? "no reason given"}`,
                  }),
                )
              case "PRIVMSG": {
                const at = Date.now()
                const derived = messageIDOf(line, at)
                const provider = line.tags?.["msgid"]
                const messageID =
                  provider !== undefined && provider.length > 0 ? derived : disambiguate(derived, at)
                const event = toInbound(line, nick, messageID)
                if (event !== undefined) yield* Queue.offer(queue, event)
                continue
              }
              default:
                continue
            }
          }
        }
      })
      // ⚠️ A pump failure must reach the STREAM, not vanish. `Queue.shutdown` transitions the queue
      // to Done with an INTERRUPT cause, and an interrupt is off the error channel — so the
      // gateway's consumer is interrupted rather than failed, the reconnect loop's catch never
      // sees it, and the account sits at `connected` with a dead fiber behind it. Fail first, then
      // shut down for a defect that carries no error.
      yield* Effect.forkScoped(
        pump.pipe(
          Effect.catch((error) => Queue.fail(queue, error)),
          Effect.catchCause(() => Queue.shutdown(queue)),
        ),
      )

      // The outbound receipt id. IRC issues none for our own sends either, so it is synthesized —
      // but it carries the connection's epoch for the same reason the inbound id is derived: a
      // bare per-connection counter hands two different messages the same receipt across a
      // reconnect, and a receipt that repeats is a receipt that identifies nothing.
      const openedAt = Date.now()
      let sentSeq = 0
      const send = (chatID: string, message: { text?: string }) =>
        Effect.gen(function* () {
          if (message.text === undefined || message.text.length === 0) return { messageID: "0" }
          if (MessengerWire.breaksLine(message.text))
            return yield* Effect.fail(
              new SendError({
                reason: "IRC outbound text must be one line; the gateway should split it before calling the driver.",
                retryable: false,
              }),
            )
          // 🔴 A target is REFUSED, never repaired. `formatCommand` would strip the breaks and the
          // spaces out of it, but the survivor names a DIFFERENT channel — and delivering a private
          // reply to a channel nobody asked for is a worse outcome than not sending it. The value
          // arrives from the `messenger` tool's `send` op, i.e. from a model, so "it can't happen"
          // is not available; the reason quotes it so the break cannot ride into the log line.
          if (chatID.trim().length === 0 || MessengerWire.breaksLine(chatID) || /[\s,]/.test(chatID))
            return yield* Effect.fail(
              new SendError({
                reason: `${MessengerWire.quote(chatID)} is not an IRC target — a channel or a nick, no spaces.`,
                retryable: false,
              }),
            )
          yield* sendCommand("PRIVMSG", [chatID], message.text).pipe(
            Effect.mapError((error) => new SendError({ reason: error.reason, retryable: true })),
          )
          sentSeq += 1
          return { messageID: `irc-out-${openedAt}-${sentSeq}` }
        })

      return {
        inbound: Stream.fromQueue(queue),
        send,
      } satisfies Connection
    }),
})

/** The production driver: `Bun.connect` TCP/TLS with a line buffer behind the socket seam. */
export const factory: IrcSocketFactory = async ({ host, port, tls }) => {
  let buffer = ""
  let pending: string[] = []
  let waiter: { resolve: (lines: readonly string[]) => void; reject: (error: Error) => void } | undefined
  let failed: Error | undefined
  const settle = () => {
    if (waiter === undefined) return
    if (pending.length > 0) {
      const { resolve } = waiter
      waiter = undefined
      const batch = pending
      pending = []
      resolve(batch)
      return
    }
    // Nothing buffered and the socket died — a parked waiter must fail, never hang.
    if (failed !== undefined) {
      const { reject } = waiter
      waiter = undefined
      reject(failed)
    }
  }
  const socket = await Bun.connect({
    hostname: host,
    port,
    ...(tls ? { tls: true } : {}),
    socket: {
      data: (_socket, data) => {
        buffer += new TextDecoder().decode(data)
        let index = buffer.indexOf("\n")
        while (index !== -1) {
          pending.push(buffer.slice(0, index + 1))
          buffer = buffer.slice(index + 1)
          index = buffer.indexOf("\n")
        }
        settle()
      },
      close: () => {
        failed ??= new Error("connection closed")
        settle()
      },
      error: (_socket, error) => {
        failed ??= error instanceof Error ? error : new Error(String(error))
        settle()
      },
    },
  })
  return {
    send: async (line) => {
      // The last gate before the wire, and the one that catches the NEXT author rather than this
      // one: `IrcSocket.send` takes a string, so nothing in the type stops a future call from
      // building a line by hand. A line that already contains a terminator is two commands, and it
      // must fail loudly here rather than reach the server as one of them.
      if (MessengerWire.breaksLine(line))
        throw new Error("IRC line carries an embedded terminator — build it with formatCommand")
      socket.write(`${line}\r\n`)
    },
    lines: () =>
      new Promise((resolve, reject) => {
        if (pending.length > 0) {
          const batch = pending
          pending = []
          resolve(batch)
          return
        }
        if (failed !== undefined) {
          reject(failed)
          return
        }
        waiter = { resolve, reject }
      }),
    close: async () => {
      socket.end()
    },
  }
}

/** The default production driver. */
export const driver: Driver = make(factory)
