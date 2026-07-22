import { describe, expect } from "bun:test"
import { Effect, Exit, Scope, Stream } from "effect"
import type { Messenger } from "@novaclaw/schema/messenger"
import { TelegramUserDriver } from "@novaclaw/core/messenger/driver/telegram-user"
import type { UserClient, UserClientConfig, UserMessage } from "@novaclaw/core/messenger/driver/telegram-user"
import { UserClientError } from "@novaclaw/core/messenger/driver/telegram-user"
import type { InboundEvent } from "@novaclaw/core/messenger/driver"
import { it } from "./lib/effect"

// P1.7 gate (notes/messenger-plan.md §8): the Telegram USER-account driver against a FAKE
// UserClient — the login flow (code → session; wrong code retryable; 2FA both arms), the
// user-account self-echo policy (Saved Messages is the phone-remote channel), send chunking with
// sent-tracking, and dialogs mapping. mtcute itself sits behind the same seam in production
// (telegram-user-mtcute.ts) and is exercised by the owner-gated live login, not here.

const SELF_ID = "111"

type FakeOptions = {
  readonly correctCode?: string
  readonly passwordNeeded?: boolean
  readonly correctPassword?: string
  readonly pullBatches?: UserMessage[][]
  readonly challengeOnMe?: boolean
  readonly historyByChat?: Record<string, UserMessage[]>
}

const makeFakeClient = (opts: FakeOptions = {}) => {
  const state = {
    configs: [] as UserClientConfig[],
    closed: 0,
    sent: [] as { chatID: string; text: string }[],
    sentFiles: [] as { chatID: string; name: string; mime: string; bytes: number; caption?: string }[],
    downloads: [] as string[],
    signIns: [] as string[],
    passwordChecks: [] as string[],
    sessionExports: 0,
    pulls: 0,
  }
  let sendSeq = 0
  let pullIndex = 0
  const factory = async (config: UserClientConfig): Promise<UserClient> => {
    state.configs.push(config)
    const client: UserClient = {
      me: async () => {
        if (opts.challengeOnMe) throw new UserClientError({ kind: "challenge", message: "session revoked" })
        return { id: SELF_ID, name: "Nancy" }
      },
      sendCode: async () => ({ phoneCodeHash: "hash-1", via: "app" }),
      signIn: async (input) => {
        state.signIns.push(input.code)
        if (input.code !== (opts.correctCode ?? "424242"))
          throw new UserClientError({ kind: "bad-code", message: "That code doesn't match — check it and try again." })
        if (opts.passwordNeeded) throw new UserClientError({ kind: "password-needed" })
      },
      checkPassword: async (password) => {
        state.passwordChecks.push(password)
        if (password !== (opts.correctPassword ?? "hunter2"))
          throw new UserClientError({ kind: "error", message: "PASSWORD_HASH_INVALID" })
      },
      exportSession: async () => {
        state.sessionExports += 1
        return "session-string-1"
      },
      pull: () => {
        state.pulls += 1
        const batch = opts.pullBatches?.[pullIndex]
        if (batch === undefined) return new Promise<readonly UserMessage[]>(() => {}) // hold forever
        pullIndex += 1
        return Promise.resolve(batch)
      },
      dialogs: async () => [
        { chatID: SELF_ID, kind: "dm", title: "Saved Messages" },
        { chatID: "-100200", kind: "group", title: "Freelance clients" },
      ],
      history: async (chatID, limit) =>
        (opts.historyByChat?.[chatID] ?? []).slice(-limit),
      sendText: async (chatID, text) => {
        state.sent.push({ chatID, text })
        sendSeq += 1
        return { messageID: "out-" + sendSeq }
      },
      sendFile: async (chatID, file, caption) => {
        state.sentFiles.push({
          chatID,
          name: file.name,
          mime: file.mime,
          bytes: file.data.byteLength,
          ...(caption === undefined ? {} : { caption }),
        })
        sendSeq += 1
        return { messageID: "out-" + sendSeq }
      },
      downloadFile: async (fileID) => {
        state.downloads.push(fileID)
        return new TextEncoder().encode("bytes-of-" + fileID)
      },
      close: async () => {
        state.closed += 1
      },
    }
    return client
  }
  return { factory, state }
}

const ACCOUNT = {
  id: "msa_user" as never,
  driverID: "telegram-user",
  label: "my telegram",
  enabled: true,
  settings: { apiId: "1234567", apiHash: "a".repeat(32) },
} as never as Messenger.AccountInfo

const userMessage = (over: Partial<UserMessage>): UserMessage => ({
  chatID: "555",
  chatKind: "dm",
  chatTitle: "Alice",
  messageID: "m-" + Math.random().toString(36).slice(2, 8),
  senderID: "555",
  senderName: "Alice",
  outgoing: false,
  text: "hi",
  at: 1_700_000_000_000,
  ...over,
})

const beginLogin = (factory: (config: UserClientConfig) => Promise<UserClient>, inputs: Record<string, string>) =>
  Effect.gen(function* () {
    const driver = TelegramUserDriver.make(factory)
    if (driver.login === undefined) return yield* Effect.die("driver.login missing")
    return yield* driver.login.begin({ account: ACCOUNT, inputs })
  })

describe("TelegramUserDriver login", () => {
  it.live("happy path: code → exported session, client closed with the scope", () =>
    Effect.gen(function* () {
      const { factory, state } = makeFakeClient()
      const scope = yield* Scope.make()
      const pending = yield* beginLogin(factory, { phone: "+491701234567" }).pipe(Scope.provide(scope))
      expect(pending.instructions).toContain("code")
      expect(pending.instructions).toContain("Telegram apps") // via: "app" phrasing
      const result = yield* pending.complete("424242")
      expect(result.session).toBe("session-string-1")
      // The login client stays open until the attempt scope closes (the code is tied to it).
      expect(state.closed).toBe(0)
      yield* Scope.close(scope, Exit.void)
      expect(state.closed).toBe(1)
      // No session config on the LOGIN client (fresh identity), settings parsed into numbers.
      expect(state.configs[0]?.session).toBeUndefined()
      expect(state.configs[0]?.apiId).toBe(1234567)
    }),
  )

  it.live("a wrong code is retryable and the attempt survives to accept the right one", () =>
    Effect.gen(function* () {
      const { factory, state } = makeFakeClient()
      yield* Effect.scoped(
        Effect.gen(function* () {
          const pending = yield* beginLogin(factory, { phone: "+491701234567" })
          const failure = yield* pending.complete("111111").pipe(Effect.flip)
          expect(failure._tag).toBe("MessengerDriver.LoginCodeError")
          if (failure._tag === "MessengerDriver.LoginCodeError") expect(failure.retryable).toBe(true)
          const result = yield* pending.complete("424242")
          expect(result.session).toBe("session-string-1")
          expect(state.signIns).toEqual(["111111", "424242"])
        }),
      )
    }),
  )

  it.live("2FA: the up-front password is used when Telegram asks for it", () =>
    Effect.gen(function* () {
      const { factory, state } = makeFakeClient({ passwordNeeded: true })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const pending = yield* beginLogin(factory, { phone: "+491701234567", password: "hunter2" })
          const result = yield* pending.complete("424242")
          expect(result.session).toBe("session-string-1")
          expect(state.passwordChecks).toEqual(["hunter2"])
        }),
      )
    }),
  )

  it.live("2FA without a password fails terminally with a legible pointer", () =>
    Effect.gen(function* () {
      const { factory } = makeFakeClient({ passwordNeeded: true })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const pending = yield* beginLogin(factory, { phone: "+491701234567" })
          const failure = yield* pending.complete("424242").pipe(Effect.flip)
          expect(failure._tag).toBe("MessengerDriver.LoginCodeError")
          if (failure._tag === "MessengerDriver.LoginCodeError") {
            expect(failure.retryable).toBe(false)
            expect(failure.reason).toContain("two-step verification")
          }
        }),
      )
    }),
  )

  it.live("missing api credentials fail before any client is built", () =>
    Effect.gen(function* () {
      const { factory, state } = makeFakeClient()
      const bare = { ...ACCOUNT, settings: {} } as never as Messenger.AccountInfo
      const driver = TelegramUserDriver.make(factory)
      const failure = yield* Effect.scoped(
        driver.login!.begin({ account: bare, inputs: { phone: "+491701234567" } }),
      ).pipe(Effect.flip)
      expect(failure._tag).toBe("MessengerDriver.ConnectError")
      if (failure._tag === "MessengerDriver.ConnectError") expect(failure.reason).toContain("my.telegram.org")
      expect(state.configs).toHaveLength(0)
    }),
  )
})

describe("TelegramUserDriver connect", () => {
  const connect = (factory: (config: UserClientConfig) => Promise<UserClient>, secret: string | undefined) =>
    TelegramUserDriver.make(factory).connect({
      account: ACCOUNT,
      secret,
      cursor: { get: () => Effect.succeed(undefined), set: () => Effect.void },
    })

  it.live("refuses without a session and challenges on a revoked one", () =>
    Effect.gen(function* () {
      const { factory } = makeFakeClient()
      const missing = yield* Effect.scoped(connect(factory, undefined)).pipe(Effect.flip)
      expect(missing._tag).toBe("MessengerDriver.ConnectError")
      if (missing._tag === "MessengerDriver.ConnectError") expect(missing.reason).toContain("logged in")

      const revoked = makeFakeClient({ challengeOnMe: true })
      const challenge = yield* Effect.scoped(connect(revoked.factory, "session-string-1")).pipe(Effect.flip)
      expect(challenge._tag).toBe("MessengerDriver.ChallengeError")
    }),
  )

  it.live("self-echo policy: incoming delivers, Saved-Messages outgoing delivers, elsewhere-outgoing is self", () =>
    Effect.gen(function* () {
      const batches: UserMessage[][] = [
        [
          // Alice writes in → real input.
          userMessage({ messageID: "in-1", text: "please fix the logo" }),
          // The operator types into their own Saved Messages from the phone → the remote-control channel.
          userMessage({
            chatID: SELF_ID,
            chatKind: "dm",
            chatTitle: "Saved Messages",
            messageID: "op-1",
            senderID: SELF_ID,
            senderName: "Nancy",
            outgoing: true,
            text: "/sessions",
          }),
          // The human answers a client from their phone (outgoing elsewhere) → NOT agent input.
          userMessage({ chatID: "555", messageID: "human-1", senderID: SELF_ID, senderName: "Nancy", outgoing: true, text: "on it!" }),
        ],
      ]
      const { factory } = makeFakeClient({ pullBatches: batches })
      const received: InboundEvent[] = []
      yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(factory, "session-string-1")
          yield* connection.inbound.pipe(
            Stream.take(3),
            Stream.runForEach((event) => Effect.sync(() => received.push(event))),
          )
        }),
      )
      const selfFlags = received.map((event) => (event.kind === "message" ? event.sender.isSelf : undefined))
      expect(selfFlags).toEqual([false, false, true])
      const first = received[0]
      if (first?.kind === "message") {
        expect(first.chat.title).toBe("Alice")
        expect(first.text).toBe("please fix the logo")
      }
    }),
  )

  it.live("our own sends are tracked so their echoes come back as self", () =>
    Effect.gen(function* () {
      const echoed: UserMessage[][] = []
      const { factory, state } = makeFakeClient({ pullBatches: echoed })
      const received: InboundEvent[] = []
      yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(factory, "session-string-1")
          const sent = yield* connection.send(SELF_ID, { text: "done, boss" })
          // The platform echoes our own outgoing message back — even in Saved Messages it must
          // be recognized as ours (else the agent would answer itself forever).
          echoed.push([
            userMessage({
              chatID: SELF_ID,
              messageID: sent.messageID,
              senderID: SELF_ID,
              outgoing: true,
              text: "done, boss",
            }),
          ])
          yield* connection.inbound.pipe(
            Stream.take(1),
            Stream.runForEach((event) => Effect.sync(() => received.push(event))),
          )
        }),
      )
      expect(state.sent).toHaveLength(1)
      const echo = received[0]
      expect(echo?.kind).toBe("message")
      if (echo?.kind === "message") expect(echo.sender.isSelf).toBe(true)
    }),
  )

  it.live("long replies chunk at 4096 and markdown downgrades to plain", () =>
    Effect.gen(function* () {
      const { factory, state } = makeFakeClient()
      yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(factory, "session-string-1")
          const long = ("word ".repeat(1000) + "\n\n").repeat(2) + "**bold** and `code`"
          yield* connection.send("555", { text: long })
        }),
      )
      expect(state.sent.length).toBeGreaterThan(1)
      for (const message of state.sent) expect(message.text.length).toBeLessThanOrEqual(4096)
      const last = state.sent.at(-1)
      expect(last?.text).toContain("bold and code")
      expect(last?.text).not.toContain("**")
    }),
  )

  it.live("listChats maps the user's dialogs (a user sees all their chats)", () =>
    Effect.gen(function* () {
      const { factory } = makeFakeClient()
      const chats = yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(factory, "session-string-1")
          return yield* connection.listChats!()
        }),
      )
      expect(chats.map((chat) => chat.title)).toEqual(["Saved Messages", "Freelance clients"])
      expect(TelegramUserDriver.make(factory).meta.capabilities.listChats).toBe("full")
    }),
  )

  it.live("files both ways: attachments pass through inbound; sendFile captions + tracks; downloads map (P5)", () =>
    Effect.gen(function* () {
      const batches: UserMessage[][] = [
        [
          userMessage({
            messageID: "in-file",
            text: "here's the brief",
            attachments: [{ id: "file-abc", name: "brief.pdf", mime: "application/pdf", size: 1234 }],
          }),
        ],
      ]
      const { factory, state } = makeFakeClient({ pullBatches: batches })
      const received: InboundEvent[] = []
      yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* connect(factory, "session-string-1")
          yield* connection.inbound.pipe(
            Stream.take(1),
            Stream.runForEach((event) => Effect.sync(() => received.push(event))),
          )
          // Files out: rides sendFile with the text as the caption, and is sent-tracked.
          const sent = yield* connection.send("555", {
            file: { name: "logo-v2.svg", mime: "image/svg+xml", data: new TextEncoder().encode("<svg/>") },
            text: "second draft",
          })
          expect(sent.messageID).toBe("out-1")
          // Files in, by ref: the driver's downloadFile maps to the client.
          const bytes = yield* connection.downloadFile!({ id: "file-abc" })
          expect(new TextDecoder().decode(bytes)).toBe("bytes-of-file-abc")
        }),
      )
      const inbound = received[0]
      expect(inbound?.kind).toBe("message")
      if (inbound?.kind === "message") {
        expect(inbound.attachments).toHaveLength(1)
        expect(inbound.attachments?.[0]?.name).toBe("brief.pdf")
      }
      expect(state.sentFiles).toEqual([
        { chatID: "555", name: "logo-v2.svg", mime: "image/svg+xml", bytes: 6, caption: "second draft" },
      ])
      expect(state.downloads).toEqual(["file-abc"])
    }),
  )
})
