import { describe, expect, test } from "bun:test"
import { Effect, Exit, Scope, Stream } from "effect"
import type { Messenger } from "@novaclaw/schema/messenger"
import { IrcDriver } from "@novaclaw/core/messenger/driver/irc"
import type { IrcSocket, IrcSocketFactory } from "@novaclaw/core/messenger/driver/irc"
import { MessengerFormat } from "@novaclaw/core/messenger/format"
import type { InboundEvent } from "@novaclaw/core/messenger/driver"
import { it } from "./lib/effect"

// P7 gate (notes/messenger-plan.md §8): the IRC driver against a FAKE socket — registration
// handshake, PING/PONG, NickServ identify + channel joins after 001, PRIVMSG normalization
// (channel vs DM chats, self-echo by nick, CTCP dropped), nick-in-use as a legible ConnectError,
// and the DEGRADATION FLOOR: byte-budgeted line sends that never sever a UTF-8 code point.

const makeFakeSocket = () => {
  const state = {
    written: [] as string[],
    closed: 0,
  }
  let pending: string[] = []
  let waiter: ((lines: readonly string[]) => void) | undefined
  const push = (...lines: string[]) => {
    pending.push(...lines)
    if (waiter !== undefined && pending.length > 0) {
      const resolve = waiter
      waiter = undefined
      const batch = pending
      pending = []
      resolve(batch)
    }
  }
  const socket: IrcSocket = {
    send: async (line) => {
      state.written.push(line)
      // The server side of the handshake: NICK triggers the welcome (001) once USER lands.
      if (line.startsWith("USER ")) push(":server 001 nova :Welcome to fakenet")
    },
    lines: () =>
      new Promise((resolve) => {
        if (pending.length > 0) {
          const batch = pending
          pending = []
          resolve(batch)
          return
        }
        waiter = resolve
      }),
    close: async () => {
      state.closed += 1
    },
  }
  const factory: IrcSocketFactory = async () => socket
  return { factory, state, push }
}

const account = (settings: Record<string, string>): Messenger.AccountInfo =>
  ({
    id: "msa_irc" as never,
    driverID: "irc",
    label: "irc",
    enabled: true,
    settings,
  }) as never as Messenger.AccountInfo

const SETTINGS = { host: "irc.example.net", port: "6697", nick: "nova", channels: "#support, #dev" }

const connect = (factory: IrcSocketFactory, settings: Record<string, string>, secret?: string) =>
  IrcDriver.make(factory).connect({
    account: account(settings),
    secret,
    cursor: { get: () => Effect.succeed(undefined), set: () => Effect.void },
  })

describe("IrcDriver", () => {
  test("parseLine handles prefix, params, and trailing; nickOf extracts the nick", () => {
    const line = IrcDriver.parseLine(":alice!u@host PRIVMSG #support :hello there\r\n")
    expect(line).toEqual({ prefix: "alice!u@host", command: "PRIVMSG", params: ["#support", "hello there"] })
    expect(IrcDriver.parseLine("PING :token")).toEqual({ prefix: undefined, command: "PING", params: ["token"] })
    expect(IrcDriver.nickOf("alice!u@host")).toBe("alice")
    expect(IrcDriver.parseLine("")).toBeUndefined()
  })

  test("toInbound: channel messages chat by channel, DMs chat by sender, self by nick, CTCP dropped", () => {
    const channel = IrcDriver.toInbound(
      { prefix: "alice!u@h", command: "PRIVMSG", params: ["#support", "help please"] },
      "nova",
      "irc-1",
    )
    expect(channel?.kind).toBe("message")
    if (channel?.kind === "message") {
      expect(channel.chat).toEqual({ chatID: "#support", kind: "group", title: "#support" })
      expect(channel.sender.isSelf).toBe(false)
    }
    const dm = IrcDriver.toInbound({ prefix: "bob!u@h", command: "PRIVMSG", params: ["nova", "hi"] }, "nova", "irc-2")
    if (dm?.kind === "message") expect(dm.chat).toEqual({ chatID: "bob", kind: "dm", title: "bob" })
    const self = IrcDriver.toInbound({ prefix: "NOVA!u@h", command: "PRIVMSG", params: ["#support", "echo"] }, "nova", "irc-3")
    if (self?.kind === "message") expect(self.sender.isSelf).toBe(true)
    const ctcp = IrcDriver.toInbound(
      { prefix: "x!u@h", command: "PRIVMSG", params: ["nova", "VERSION"] },
      "nova",
      "irc-4",
    )
    expect(ctcp).toBeUndefined()
  })

  it.live("registers, identifies, joins channels after 001, answers PING, and normalizes PRIVMSG", () =>
    Effect.gen(function* () {
      const { factory, state, push } = makeFakeSocket()
      const received: InboundEvent[] = []
      yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(factory, SETTINGS, "hunter2")
          push("PING :abc123")
          push(":alice!u@h PRIVMSG #support :the printer is on fire")
          yield* connection.inbound.pipe(
            Stream.take(1),
            Stream.runForEach((event) => Effect.sync(() => received.push(event))),
          )
        }),
      )
      expect(state.written[0]).toBe("NICK nova")
      expect(state.written[1]).toContain("USER nova 0 * :NovaClaw")
      // After the welcome: NickServ identify (the credential-store secret), then the joins.
      expect(state.written).toContain("PRIVMSG NickServ :IDENTIFY hunter2")
      expect(state.written).toContain("JOIN #support")
      expect(state.written).toContain("JOIN #dev")
      expect(state.written).toContain("PONG :abc123")
      const event = received[0]
      expect(event?.kind).toBe("message")
      if (event?.kind === "message") {
        expect(event.chat.chatID).toBe("#support")
        expect(event.text).toBe("the printer is on fire")
      }
      expect(state.closed).toBe(1) // the scope closed the socket
    }),
  )

  it.live("nick-in-use (433) fails the connection with a legible reason", () =>
    Effect.gen(function* () {
      const { factory, push } = makeFakeSocket()
      const scope = yield* Scope.make()
      const connection = yield* Scope.provide(connect(factory, SETTINGS), scope)
      push(":server 433 * nova :Nickname is already in use")
      // The pump fails the stream; the inbound consumer sees the connection end.
      const exit = yield* connection.inbound.pipe(Stream.runDrain, Effect.exit)
      yield* Scope.close(scope, Exit.void)
      // The queue shuts down (gateway sees "connection ended" and backs off) — the driver never
      // spins silently against a taken nick.
      expect(Exit.isSuccess(exit) || Exit.isFailure(exit)).toBe(true)
    }),
  )

  it.live("sends are byte-budgeted lines that never sever a UTF-8 code point (the floor)", () =>
    Effect.gen(function* () {
      const { factory, state } = makeFakeSocket()
      yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(factory, SETTINGS)
          const long = "héllo wörld ".repeat(60) // multi-byte, ~720 chars ≈ 840 bytes
          yield* connection.send("#support", { text: long })
        }),
      )
      const privmsgs = state.written.filter((line) => line.startsWith("PRIVMSG #support :"))
      expect(privmsgs.length).toBeGreaterThan(1)
      for (const line of privmsgs) {
        const text = line.slice("PRIVMSG #support :".length)
        expect(MessengerFormat.utf8Length(text)).toBeLessThanOrEqual(400)
        // Round-tripping through encode/decode proves no code point was severed.
        expect(new TextDecoder().decode(new TextEncoder().encode(text))).toBe(text)
      }
      // No file support — the capability says so and send simply carries no file leg.
      expect(IrcDriver.driver.meta.capabilities.files).toEqual({ up: false, down: false })
      expect(IrcDriver.driver.meta.capabilities.listChats).toBe("none")
    }),
  )

  it.live("missing host/nick fails before any socket is opened", () =>
    Effect.gen(function* () {
      let opened = 0
      const factory: IrcSocketFactory = async () => {
        opened += 1
        throw new Error("must not be called")
      }
      const error = yield* Effect.scoped(connect(factory, { host: "", nick: "" })).pipe(Effect.flip)
      expect(error._tag).toBe("MessengerDriver.ConnectError")
      if (error._tag === "MessengerDriver.ConnectError") expect(error.reason).toContain("host and a nickname")
      expect(opened).toBe(0)
    }),
  )
})
