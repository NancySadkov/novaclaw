import { describe, expect } from "bun:test"
import type { Cause } from "effect"
import { Duration, Effect, Layer, Queue, Stream } from "effect"
import { Messenger } from "@novaclaw/schema/messenger"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Global } from "@novaclaw/core/global"
import { Offline } from "@novaclaw/core/offline"
import { SessionV2 } from "@novaclaw/core/session"
import { MessengerDriver } from "@novaclaw/core/messenger/driver"
import type { ChatSnapshot, ConnectContext, OutboundFile } from "@novaclaw/core/messenger/driver"
import { MessengerDrivers } from "@novaclaw/core/messenger/drivers"
import { MessengerGateway } from "@novaclaw/core/messenger/gateway"
import { MessengerPace } from "@novaclaw/core/messenger/pace"
import { MessengerStore } from "@novaclaw/core/messenger/store"
import { TelegramUserDriver } from "@novaclaw/core/messenger/driver/telegram-user"
import type { UserClient, UserClientConfig, UserMessage } from "@novaclaw/core/messenger/driver/telegram-user"
import { UserClientError } from "@novaclaw/core/messenger/driver/telegram-user"
import { WhatsAppBaileysDriver } from "@novaclaw/core/messenger/driver/whatsapp-baileys"
import type { WAClient, WALink, WAMessage } from "@novaclaw/core/messenger/driver/whatsapp-baileys"
import { WAClientError } from "@novaclaw/core/messenger/driver/whatsapp-baileys"
import { it as bareIt, testEffect } from "./lib/effect"

/**
 * **AGENTS.md design principle 9(c) — "challenges are first-class: a CAPTCHA parks the account and
 * notifies the operator; we never auto-solve or evade" — on all THREE doors a challenge can arrive
 * at.** The rule exists so a real person's account is never flagged or banned, and it is only worth
 * anything if every door obeys it. There are three:
 *
 *  1. **connect** — obeyed since the gateway was written.
 *  2. **send** — an outbound op that meets a login veto. Obeyed once `Connection.send` was widened
 *     to carry `ChallengeError`.
 *  3. **a chat listing / history read** — the door this file exists for. `listChats` and `history`
 *     were typed `ConnectError` alone, so BOTH linked-account drivers (WhatsApp, Telegram User)
 *     wrapped them in a private helper that DOWNGRADED a `ChallengeError` into a `ConnectError` —
 *     it was the only way to satisfy the narrower channel. A revoked or unlinked session found
 *     while enumerating chats therefore read as an ordinary read failure: the account stayed
 *     `connected`, no banner went up, and the operator was never told. Both driver copies were
 *     wrong the same way, so merging them would have produced one wrong answer instead of two.
 *
 * The three doors are asserted TOGETHER, in one test, on purpose: the interesting failure is not
 * "door 3 breaks" but "door 3 breaks alone while 1 and 2 stay green", which is exactly what a
 * per-door test file would let through unremarked.
 *
 * **A/B controls (both halves are separately reversible).**
 *  · Re-demote in the drivers (wrap `listChats`/`history` in the old `ChallengeError → ConnectError`
 *    mapper): the DRIVER leg below fails — the tag comes back `ConnectError`.
 *  · Drop the `isChallenge` branch from the gateway's `chats`/`history` catch: the THIRD DOOR of the
 *    gateway leg fails — the account sits at `connected` — while doors 1 and 2 stay green. That is
 *    what proves the control isolates the third door rather than knocking the whole file over.
 */

// ── the gateway leg: one fake driver that can raise a challenge at each of the three doors ───────

const CAPS: Messenger.Capabilities = {
  listChats: "full",
  files: { up: false, down: false },
  edits: false,
  threads: false,
  moderation: { delete: false, ban: false, kick: false, mute: false, pin: false },
  format: "plain",
  maxChars: 1000,
}

const CONNECT_CHALLENGE = "scan the CAPTCHA at connect"
const SEND_CHALLENGE = "verify this device before sending"
const LIST_CHALLENGE = "this session was revoked — re-link the device"

const makeFakeDriver = () => {
  const state = {
    /** Which door the NEXT operation of that kind fails at. Set per test, cleared by `ensuring`. */
    challengeAtConnect: false,
    challengeOnSend: false,
    challengeOnRead: false,
    queue: undefined as Queue.Queue<MessengerDriver.InboundEvent, Cause.Done> | undefined,
    sent: [] as { chatID: string; text: string | undefined }[],
  }
  const driver: MessengerDriver.Driver = {
    id: "fake",
    meta: { id: "fake", name: "Fake", icon: "chat", auth: "none", settings: [], capabilities: CAPS },
    capabilities: () => CAPS,
    connect: () =>
      Effect.gen(function* () {
        if (state.challengeAtConnect) {
          state.challengeAtConnect = false
          return yield* Effect.fail(new MessengerDriver.ChallengeError({ message: CONNECT_CHALLENGE }))
        }
        const queue = yield* Queue.unbounded<MessengerDriver.InboundEvent, Cause.Done>()
        state.queue = queue
        return {
          inbound: Stream.fromQueue(queue),
          send: (chatID, message) =>
            Effect.suspend(() =>
              state.challengeOnSend
                ? Effect.fail(new MessengerDriver.ChallengeError({ message: SEND_CHALLENGE }))
                : Effect.sync(() => {
                    state.sent.push({ chatID, text: message.text })
                    return { messageID: "m" + state.sent.length }
                  }),
            ),
          // ⚠️ These two arms are the whole point: a driver can only SAY "challenge" here because
          // the contract widened. Under the old signature this file would not compile.
          listChats: () =>
            Effect.suspend(() =>
              state.challengeOnRead
                ? Effect.fail(new MessengerDriver.ChallengeError({ message: LIST_CHALLENGE }))
                : Effect.succeed([{ chatID: "770", kind: "dm", title: "Alice" } as ChatSnapshot]),
            ),
          history: () =>
            Effect.suspend(() =>
              state.challengeOnRead
                ? Effect.fail(new MessengerDriver.ChallengeError({ message: LIST_CHALLENGE }))
                : Effect.succeed([]),
            ),
        } satisfies MessengerDriver.Connection
      }),
  }
  return { driver, state }
}

const fake = makeFakeDriver()

const session = Layer.mock(SessionV2.Service, {
  prompt: () => Effect.succeed(undefined as never),
  list: () => Effect.succeed([] as never),
  get: () => Effect.fail({ _tag: "Session.NotFoundError" } as never),
  revert: {
    stage: () => Effect.die("challenge-doors: revert.stage is not part of this test"),
    clear: () => Effect.die("challenge-doors: revert.clear is not part of this test"),
    commit: () => Effect.die("challenge-doors: revert.commit is not part of this test"),
  } as never,
})

const REPLACEMENTS = [
  [
    MessengerDrivers.node,
    Layer.succeed(MessengerDrivers.Service, MessengerDrivers.Service.of(MessengerDrivers.make([fake.driver]))),
  ],
  [
    Offline.node,
    Layer.mock(Offline.Service)({
      policy: { enabled: false, allowedHosts: new Set<string>() },
      check: () => ({ allowed: true }) as const,
      egressEnv: () => undefined,
      manifest: () => ({ enabled: false, active: 0, total: 9, layers: [] }),
    }),
  ],
  [SessionV2.node, session],
  // Instant, still-serialized pacing: nothing here measures timing.
  [MessengerPace.node, MessengerPace.layerWith({ sleep: () => Effect.void })],
] satisfies LayerNode.Replacements

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      FSUtil.node,
      Global.node,
      MessengerStore.node,
      MessengerGateway.node,
    ]),
    REPLACEMENTS,
  ),
)

let seq = 0
const message = (chatID: string): MessengerDriver.InboundEvent => ({
  kind: "message",
  chat: { chatID, kind: "dm", title: "Chat " + chatID },
  messageID: "msg-" + ++seq,
  sender: { id: "u1", name: "Alice", isSelf: false },
  text: "hello",
  at: Date.now(),
})

const eventually = <A, E>(effect: Effect.Effect<A, E>, predicate: (value: A) => boolean, label: string, rounds = 200) =>
  Effect.gen(function* () {
    for (let round = 0; round < rounds; round++) {
      const value = yield* effect
      if (predicate(value)) return value
      yield* Effect.sleep(Duration.millis(25))
    }
    return yield* Effect.die(`timeout waiting for ${label}`)
  })

const parkedMessage = (status: Messenger.AccountStatus | undefined) =>
  status?.state === "challenge" ? status.message : `NOT PARKED (state: ${status?.state ?? "absent"})`

describe("MessengerGateway challenge doors (#9(c))", () => {
  it.live("🔴 a challenge parks the account at CONNECT, at SEND, and during a CHAT LISTING", () =>
    Effect.gen(function* () {
      const store = yield* MessengerStore.Service
      const gateway = yield* MessengerGateway.Service

      // ── DOOR 1: connect ──────────────────────────────────────────────────────────────────────
      fake.state.challengeAtConnect = true
      const atConnect = yield* store.createAccount({ driverID: "fake", label: "door-1", enabled: true, settings: {} })
      yield* gateway.reload()
      const afterConnect = yield* eventually(
        gateway.status(),
        (map) => map.get(atConnect.id)?.state === "challenge",
        "door 1 (connect) parked",
      )
      expect(parkedMessage(afterConnect.get(atConnect.id))).toContain(CONNECT_CHALLENGE)
      yield* store.removeAccount(atConnect.id)

      // Doors 2 and 3 get an account EACH, so the third door can only pass by parking an account
      // that is `connected` at the moment it is asked to read — never on door 2's leftover status.
      const sender = yield* store.createAccount({ driverID: "fake", label: "door-2", enabled: true, settings: {} })
      yield* gateway.reload()
      yield* eventually(gateway.status(), (map) => map.get(sender.id)?.state === "connected", "door 2 connected")
      const queue = fake.state.queue
      if (queue === undefined) throw new Error("driver queue missing")
      // The chat must have written to us first, or the cold-start guard refuses before the driver is
      // ever asked — and door 2 would then be measuring the guard, not the challenge.
      yield* Queue.offer(queue, message("770"))
      yield* eventually(store.hasInbound(sender.id, "770"), (seen) => seen === true, "inbound 770")

      const reader = yield* store.createAccount({ driverID: "fake", label: "door-3", enabled: true, settings: {} })
      yield* gateway.reload()
      yield* eventually(gateway.status(), (map) => map.get(reader.id)?.state === "connected", "door 3 connected")

      // ── DOOR 2: an outbound send ─────────────────────────────────────────────────────────────
      fake.state.challengeOnSend = true
      const sendOutcome = yield* gateway.send({ accountID: sender.id, chatID: "770", text: "hello" })
      fake.state.challengeOnSend = false
      expect(sendOutcome.kind).toBe("refused")
      expect(sendOutcome.kind === "refused" && sendOutcome.reason).toContain("verification required")
      expect(parkedMessage((yield* gateway.status()).get(sender.id))).toContain(SEND_CHALLENGE)

      // ── DOOR 3: a chat listing, and a history read ───────────────────────────────────────────
      fake.state.challengeOnRead = true
      expect(parkedMessage((yield* gateway.status()).get(reader.id))).toBe("NOT PARKED (state: connected)")
      yield* gateway.chats(reader.id)
      expect(parkedMessage((yield* gateway.status()).get(reader.id))).toContain(LIST_CHALLENGE)

      // The listing parks and removes the live connection, so a subsequent history attempt is
      // refused at the account boundary rather than touching a transport that already demanded
      // verification. The linked-account driver tests below cover the history door itself.
      const historyOutcome = yield* gateway.history({ accountID: reader.id, chatID: "770", limit: 10 })
      expect(historyOutcome.ok).toBe(false)
      expect(historyOutcome.ok === false && historyOutcome.reason).toContain("isn't connected")
      expect(parkedMessage((yield* gateway.status()).get(reader.id))).toContain(LIST_CHALLENGE)

      yield* store.removeAccount(sender.id)
      yield* store.removeAccount(reader.id)
      yield* gateway.reload()
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          fake.state.challengeAtConnect = false
          fake.state.challengeOnSend = false
          fake.state.challengeOnRead = false
        }),
      ),
    ),
  )
})

// ── the driver leg: the two linked-account drivers stop demoting ─────────────────────────────────

const TG_ACCOUNT = {
  id: "msa_tg" as never,
  driverID: "telegram-user",
  label: "my telegram",
  enabled: true,
  settings: { apiId: "1234567", apiHash: "a".repeat(32) },
} as never as Messenger.AccountInfo

const WA_ACCOUNT = {
  id: "msa_wa" as never,
  driverID: "whatsapp",
  label: "WhatsApp",
  enabled: true,
  settings: {},
} as never as Messenger.AccountInfo

const ctxFor = (account: Messenger.AccountInfo, secret: string): ConnectContext => ({
  account,
  secret,
  cursor: { get: () => Effect.succeed(undefined), set: () => Effect.void },
})

const REVOKED = "session revoked"

/** A UserClient whose reads reject the way a revoked MTProto session does. */
const telegramClient = (): UserClient => ({
  me: async () => ({ id: "111", name: "Me" }),
  sendCode: async () => ({ phoneCodeHash: "h", via: "app" }),
  signIn: async () => undefined,
  checkPassword: async () => undefined,
  exportSession: async () => "session",
  pull: () => new Promise<readonly UserMessage[]>(() => {}),
  dialogs: async () => {
    throw new UserClientError({ kind: "challenge", message: REVOKED })
  },
  history: async () => {
    throw new UserClientError({ kind: "challenge", message: REVOKED })
  },
  sendText: async () => ({ messageID: "1" }),
  sendFile: async () => ({ messageID: "1" }),
  downloadFile: async () => new Uint8Array(),
  close: async () => undefined,
})

/** A WAClient whose reads AND sends reject the way an unlinked device does. */
const whatsappClient = (): WAClient => ({
  me: async () => ({ id: "me@wa", name: "Me" }),
  startLink: async () => ({}) as WALink,
  currentLink: () => ({}) as WALink,
  waitForOpen: async () => undefined,
  exportAuth: async () => "blob",
  pull: () => new Promise<readonly WAMessage[]>(() => {}),
  chats: async () => {
    throw new WAClientError({ kind: "logged-out" })
  },
  history: async () => {
    throw new WAClientError({ kind: "logged-out" })
  },
  sendText: async () => {
    throw new WAClientError({ kind: "logged-out" })
  },
  sendFile: async (_chatID: string, _file: OutboundFile) => {
    throw new WAClientError({ kind: "logged-out" })
  },
  downloadFile: async () => new Uint8Array(),
  close: async () => undefined,
})

describe("linked-account drivers: a challenge survives the read path", () => {
  bareIt.live("🔴 Telegram User's listChats and history raise a ChallengeError, never a demoted read failure", () =>
    Effect.gen(function* () {
      const client = telegramClient()
      const driver = TelegramUserDriver.make(async () => client)
      const failures = yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.connect(ctxFor(TG_ACCOUNT, "session-string-1"))
          return [
            yield* connection.listChats!().pipe(Effect.flip),
            yield* connection.history!("555", 10).pipe(Effect.flip),
          ]
        }),
      )
      for (const failure of failures) {
        expect(failure._tag).toBe("MessengerDriver.ChallengeError")
        expect(failure._tag === "MessengerDriver.ChallengeError" && failure.message).toContain(REVOKED)
      }
    }),
  )

  bareIt.live("🔴 WhatsApp maps an unlinked device to a ChallengeError on a READ and on a SEND", () =>
    Effect.gen(function* () {
      const client = whatsappClient()
      const driver = WhatsAppBaileysDriver.make(async () => client)
      const failures = yield* Effect.scoped(
        Effect.gen(function* () {
          const connection = yield* driver.connect(ctxFor(WA_ACCOUNT, "WA-SESSION-BLOB"))
          return [
            yield* connection.listChats!().pipe(Effect.flip),
            yield* connection.history!("c1@g.us", 10).pipe(Effect.flip),
            // The send mapper's own half: it collapsed `logged-out` into a non-retryable
            // SendError, so an unlinked or banned account never parked and never notified — a layer
            // BELOW the widened send channel, where the ChallengeError was never constructed at all.
            yield* connection.send("c1@g.us", { text: "hi" }).pipe(Effect.flip),
          ]
        }),
      )
      for (const failure of failures) {
        expect(failure._tag).toBe("MessengerDriver.ChallengeError")
        expect(failure._tag === "MessengerDriver.ChallengeError" && failure.message).toContain("re-link")
      }
    }),
  )
})
