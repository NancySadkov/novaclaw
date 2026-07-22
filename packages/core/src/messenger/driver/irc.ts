export * as IrcDriver from "./irc"

import { Effect, Queue, Stream } from "effect"
import type { Messenger } from "@novaclaw/schema/messenger"
import { MessengerFormat } from "../format"
import type { ChatSnapshot, Connection, ConnectContext, Driver, InboundEvent } from "../driver"
import { ConnectError, SendError } from "../driver"

// The IRC driver (messenger-plan §2.1) — the contract's DEGRADATION FLOOR: no files, no edits,
// no message ids from the platform (we synthesize), no chat enumeration (join-by-name; the
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
  typing: false,
  threads: false,
  moderation: { delete: false, ban: false, kick: false, mute: false, pin: false },
  format: "plain",
  maxChars: LINE_TEXT_BYTES,
}

/** One parsed server line: optional prefix, command, params (trailing folded in last). */
export interface IrcLine {
  readonly prefix?: string
  readonly command: string
  readonly params: readonly string[]
}

export const parseLine = (raw: string): IrcLine | undefined => {
  let rest = raw.replace(/\r?\n$/, "")
  if (rest.length === 0) return undefined
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
  return { prefix, command: command.toUpperCase(), params }
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
  const chat: ChatSnapshot = channel
    ? { chatID: target, kind: "group", title: target }
    : { chatID: sender, kind: "dm", title: sender }
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
        message: "Channels to join at connect, comma-separated (a channel can also be typed by hand in the chat picker)",
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
          new ConnectError({ reason: "This IRC account needs a server host and a nickname — fill both in Settings → Messengers." }),
        )
      if (!Number.isInteger(port) || port <= 0 || port > 65535)
        return yield* Effect.fail(new ConnectError({ reason: `"${ctx.account.settings["port"]}" is not a valid port.` }))
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
      const sendLine = (line: string) =>
        Effect.tryPromise({
          try: () => socket.send(line),
          catch: (error) => new ConnectError({ reason: `IRC write failed: ${String(error)}` }),
        })

      // Registration: NICK + USER; the server's 001 welcome confirms. NickServ IDENTIFY + JOINs
      // ride after the welcome (sending them earlier is legal but widely dropped).
      yield* sendLine(`NICK ${nick}`)
      yield* sendLine(`USER ${nick.replaceAll(/[^A-Za-z0-9]/g, "").slice(0, 10) || "novaclaw"} 0 * :NovaClaw`)

      const queue = yield* Queue.unbounded<InboundEvent>()
      let messageSeq = 0
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
                yield* sendLine(`PONG :${line.params[0] ?? ""}`)
                continue
              case "001": {
                // Registered. Identify (secret = the NickServ password), then join the rooms.
                if (ctx.secret !== undefined && ctx.secret.length > 0)
                  yield* sendLine(`PRIVMSG NickServ :IDENTIFY ${ctx.secret}`)
                for (const channel of channels) yield* sendLine(`JOIN ${channel}`)
                continue
              }
              case "433":
                return yield* Effect.fail(
                  new ConnectError({ reason: `The nickname "${nick}" is already in use on ${host} — pick another in Settings.` }),
                )
              case "ERROR":
                return yield* Effect.fail(
                  new ConnectError({ reason: `${host} closed the connection: ${line.params.at(-1) ?? "no reason given"}` }),
                )
              case "PRIVMSG": {
                messageSeq += 1
                const event = toInbound(line, nick, `irc-${messageSeq}`)
                if (event !== undefined) yield* Queue.offer(queue, event)
                continue
              }
              default:
                continue
            }
          }
        }
      })
      yield* Effect.forkScoped(pump.pipe(Effect.catchCause(() => Queue.shutdown(queue))))

      let sentSeq = 0
      const send = (chatID: string, message: { text?: string }) =>
        Effect.gen(function* () {
          if (message.text === undefined || message.text.length === 0) return { messageID: "0" }
          const chunks = MessengerFormat.chunk(MessengerFormat.downgrade(message.text, "plain"), {
            maxChars: LINE_TEXT_BYTES,
            maxBytes: LINE_TEXT_BYTES,
          })
          for (const chunk of chunks) {
            // IRC is single-line: newlines inside a chunk become separate PRIVMSGs.
            for (const line of chunk.split("\n")) {
              if (line.trim().length === 0) continue
              yield* sendLine(`PRIVMSG ${chatID} :${line}`).pipe(
                Effect.mapError((error) => new SendError({ reason: error.reason, retryable: true })),
              )
            }
          }
          sentSeq += 1
          return { messageID: `irc-out-${sentSeq}` }
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
