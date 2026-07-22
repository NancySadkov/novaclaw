import { describe, expect } from "bun:test"
import { DateTime, Duration, Effect, Layer, Queue, Stream } from "effect"
import { Messenger } from "@novaclaw/schema/messenger"
import { SessionEvent } from "@novaclaw/schema/session-event"
import { SessionMessage } from "@novaclaw/schema/session-message"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Offline } from "@novaclaw/core/offline"
import { SessionV2 } from "@novaclaw/core/session"
import { MessengerDriver } from "@novaclaw/core/messenger/driver"
import { MessengerPace } from "@novaclaw/core/messenger/pace"
import { MessengerDrivers } from "@novaclaw/core/messenger/drivers"
import { MessengerGateway } from "@novaclaw/core/messenger/gateway"
import { MessengerStore } from "@novaclaw/core/messenger/store"
import { testEffect } from "./lib/effect"

// Mock SessionV2 so the gateway graph never boots the real runner / LocationServiceMap. The
// gateway only calls prompt (records the injected turn) and list (feeds /sessions).
const makeSessionMock = () => {
  const prompts: { sessionID: string; text: string }[] = []
  const sessionList: { id: string; title?: string; agent?: string }[] = [
    { id: "ses_alpha", title: "Fix the login bug", agent: "build" },
    { id: "ses_beta", title: "Design a logo" },
  ]
  const layer = Layer.mock(SessionV2.Service, {
    prompt: (input: { sessionID: string; prompt: { text: string } }) =>
      Effect.sync(() => {
        prompts.push({ sessionID: input.sessionID, text: input.prompt.text })
        return undefined as never
      }),
    list: () => Effect.succeed(sessionList as never),
  } as never)
  return { layer, prompts, sessionList }
}

// P0 gates (notes/messenger-plan.md §8): the gateway's account state machine — boot/reload
// reconcile, connected/backoff/error/disabled/airgapped statuses, inbound seen-chat upkeep,
// self-echo drop, and scope teardown on disable — all against a controllable fake driver.

const CAPS: Messenger.Capabilities = {
  listChats: "seen",
  files: { up: false, down: false },
  edits: false,
  typing: false,
  threads: false,
  moderation: { delete: false, ban: false, kick: false, mute: false, pin: false },
  format: "plain",
  maxChars: 1000,
}

const makeFakeDriver = () => {
  const state = {
    connects: 0,
    secrets: [] as (string | undefined)[],
    queue: undefined as Queue.Queue<MessengerDriver.InboundEvent> | undefined,
    sent: [] as { chatID: string; text: string | undefined }[],
    failNext: false,
    challengeNext: false,
    open: 0,
  }
  const driver: MessengerDriver.Driver = {
    id: "fake",
    meta: { id: "fake", name: "Fake", icon: "chat", auth: "none", settings: [], capabilities: CAPS },
    capabilities: () => CAPS,
    connect: (ctx) =>
      Effect.gen(function* () {
        state.connects += 1
        state.secrets.push(ctx.secret)
        if (state.challengeNext) {
          state.challengeNext = false
          return yield* Effect.fail(new MessengerDriver.ChallengeError({ message: "solve this CAPTCHA" }))
        }
        if (state.failNext) {
          state.failNext = false
          return yield* Effect.fail(new MessengerDriver.ConnectError({ reason: "boom" }))
        }
        const queue = yield* Queue.unbounded<MessengerDriver.InboundEvent>()
        state.queue = queue
        state.open += 1
        yield* Effect.addFinalizer(() => Effect.sync(() => (state.open -= 1)))
        return {
          inbound: Stream.fromQueue(queue),
          send: (chatID, message) =>
            Effect.sync(() => {
              state.sent.push({ chatID, text: message.text })
              return { messageID: "m" + state.sent.length }
            }),
        } satisfies MessengerDriver.Connection
      }),
  }
  return { driver, state }
}

const offlineMock = (enabled: boolean) =>
  Layer.mock(Offline.Service)({
    policy: { enabled, allowedHosts: new Set<string>() },
    check: () => ({ allowed: true }) as const,
    egressEnv: () => undefined,
    manifest: () => ({ enabled, active: 0, total: 9, layers: [] }),
  })

const fake = makeFakeDriver()
const session = makeSessionMock()

const graph = LayerNode.group([Database.node, EventV2.node, FSUtil.node, MessengerStore.node, MessengerGateway.node])

const it = testEffect(
  AppNodeBuilder.build(graph, [
    [MessengerDrivers.node, Layer.succeed(MessengerDrivers.Service, MessengerDrivers.Service.of(MessengerDrivers.make([fake.driver])))],
    [Offline.node, offlineMock(false)],
    [SessionV2.node, session.layer],
    // Instant, still-serialized pacing: these tests exercise routing LOGIC; the real human-typing
    // timing is proven directly in messenger-pace.test.ts.
    [MessengerPace.node, MessengerPace.layerWith({ sleep: () => Effect.void })],
  ]),
)

let messageSeq = 0
const message = (
  chatID: string,
  opts?: { isSelf?: boolean; title?: string; text?: string; sender?: string; kind?: Messenger.ChatKind },
): MessengerDriver.InboundEvent => ({
  kind: "message",
  chat: { chatID, kind: opts?.kind ?? "dm", title: opts?.title ?? "Chat " + chatID },
  messageID: "msg-" + ++messageSeq,
  sender: { id: opts?.sender ?? "u1", name: "Nancy", isSelf: opts?.isSelf ?? false },
  text: opts?.text ?? "hello",
  at: Date.now(),
})

const eventually = <A>(effect: Effect.Effect<A>, predicate: (value: A) => boolean, label: string) =>
  Effect.gen(function* () {
    for (let round = 0; round < 200; round++) {
      const value = yield* effect
      if (predicate(value)) return value
      yield* Effect.sleep(Duration.millis(25))
    }
    return yield* Effect.die(`timeout waiting for ${label}`)
  })

describe("MessengerGateway", () => {
  it.live("connects an enabled account, tracks seen chats, drops self-echo, and parks on disable", () =>
    Effect.gen(function* () {
      const store = yield* MessengerStore.Service
      const gateway = yield* MessengerGateway.Service
      const account = yield* store.createAccount({ driverID: "fake", label: "t", enabled: true, settings: {} })
      yield* gateway.reload()

      yield* eventually(gateway.status(), (map) => map.get(account.id)?.state === "connected", "connected")
      expect(fake.state.secrets.at(-1)).toBeUndefined()
      expect(fake.state.open).toBe(1)

      const queue = fake.state.queue
      if (queue === undefined) throw new Error("driver queue missing")
      yield* Queue.offer(queue, message("42", { title: "Nancy DM" }))
      yield* Queue.offer(queue, message("self-chat", { isSelf: true }))
      yield* eventually(store.listChats(account.id), (chats) => chats.length > 0, "seen chat")
      const chats = yield* store.listChats(account.id)
      expect(chats.map((chat) => chat.chatID)).toEqual(["42"])
      expect(chats[0]?.title).toBe("Nancy DM")

      yield* store.updateAccount(account.id, { enabled: false })
      yield* gateway.reload()
      yield* eventually(gateway.status(), (map) => map.get(account.id)?.state === "disabled", "disabled")
      yield* eventually(Effect.sync(() => fake.state.open), (open) => open === 0, "connection scope closed")
      yield* store.removeAccount(account.id)
      yield* gateway.reload()
    }),
  )

  it.live("a failing connect goes to backoff with the reason, then reconnects", () =>
    Effect.gen(function* () {
      const store = yield* MessengerStore.Service
      const gateway = yield* MessengerGateway.Service
      fake.state.failNext = true
      const account = yield* store.createAccount({ driverID: "fake", label: "b", enabled: true, settings: {} })
      yield* gateway.reload()

      const backoff = yield* eventually(
        gateway.status(),
        (map) => map.get(account.id)?.state === "backoff",
        "backoff",
      )
      const status = backoff.get(account.id)
      expect(status?.state === "backoff" && status.message).toBe("boom")
      // The first backoff is 1s; the loop must come back on its own.
      yield* eventually(gateway.status(), (map) => map.get(account.id)?.state === "connected", "reconnected")
      yield* store.removeAccount(account.id)
      yield* gateway.reload()
    }),
  )

  it.live("an account whose driver is not installed parks in a legible error", () =>
    Effect.gen(function* () {
      const store = yield* MessengerStore.Service
      const gateway = yield* MessengerGateway.Service
      const account = yield* store.createAccount({ driverID: "ghost", label: "g", enabled: true, settings: {} })
      yield* gateway.reload()
      const map = yield* gateway.status()
      const status = map.get(account.id)
      expect(status?.state).toBe("error")
      expect(status?.state === "error" && status.message).toContain('"ghost"')
      yield* store.removeAccount(account.id)
      yield* gateway.reload()
    }),
  )
})

describe("MessengerGateway pipeline", () => {
  // Bring one fake account online and hand back its live inbound queue + a helper to wait for
  // the gateway to have processed up to N outbound sends / prompt injections.
  const online = (label: string) =>
    Effect.gen(function* () {
      const store = yield* MessengerStore.Service
      const gateway = yield* MessengerGateway.Service
      const account = yield* store.createAccount({ driverID: "fake", label, enabled: true, settings: {} })
      yield* gateway.reload()
      yield* eventually(gateway.status(), (map) => map.get(account.id)?.state === "connected", "connected")
      const queue = fake.state.queue
      if (queue === undefined) throw new Error("driver queue missing")
      return { store, gateway, account, queue }
    })

  it.live("pairs an operator, lists sessions, /use binds the chat, and plain text injects a turn", () =>
    Effect.gen(function* () {
      const { store, gateway, account, queue } = yield* online("pair")
      const sentBefore = fake.state.sent.length
      const promptsBefore = session.prompts.length

      const pair = yield* gateway.mintPairingCode(account.id, "operator")
      yield* Queue.offer(queue, message("100", { text: `/pair ${pair.code}` }))
      yield* eventually(store.getContact(account.id, "u1"), (c) => c?.trust === "operator", "paired operator")

      yield* Queue.offer(queue, message("100", { text: "/sessions" }))
      yield* eventually(
        Effect.sync(() => fake.state.sent.slice(sentBefore)),
        (sent) => sent.some((s) => s.text?.includes("Fix the login bug")),
        "sessions listed",
      )

      yield* Queue.offer(queue, message("100", { text: "/use 1" }))
      yield* eventually(store.bindingForChat(account.id, "100"), (b) => b?.sessionID === "ses_alpha", "bound")

      yield* Queue.offer(queue, message("100", { text: "ship it please" }))
      yield* eventually(
        Effect.sync(() => session.prompts.slice(promptsBefore)),
        (p) => p.some((entry) => entry.sessionID === "ses_alpha" && entry.text.includes("ship it please")),
        "prompt injected",
      )
      const injected = session.prompts.slice(promptsBefore).find((p) => p.text.includes("ship it please"))
      // Operator provenance: header present, no untrusted framing.
      expect(injected?.text).toContain("[via fake")
      expect(injected?.text).not.toContain("external CLIENT")

      yield* store.removeAccount(account.id)
      yield* gateway.reload()
    }),
  )

  it.live("an unpaired stranger's plain text never injects a turn (default-deny)", () =>
    Effect.gen(function* () {
      const { store, gateway, account, queue } = yield* online("deny")
      const promptsBefore = session.prompts.length
      yield* Queue.offer(queue, message("200", { text: "please run rm -rf", sender: "stranger" }))
      // Give the gateway a beat; nothing should be injected.
      yield* Effect.sleep(Duration.millis(150))
      expect(session.prompts.length).toBe(promptsBefore)
      // But the chat WAS seen (feeds the picker) — silence is not blindness.
      expect((yield* store.listChats(account.id)).some((c) => c.chatID === "200")).toBe(true)
      yield* store.removeAccount(account.id)
      yield* gateway.reload()
    }),
  )

  it.live("finished assistant text relays out to the bound chat", () =>
    Effect.gen(function* () {
      const { store, gateway, account, queue } = yield* online("relay")
      const events = yield* EventV2.Service
      // Bind chat 300 to ses_beta directly (operator trust) so the relay has a target.
      yield* store.createBinding({ accountID: account.id, chatID: "300", sessionID: "ses_beta", trust: "operator" })
      const sentBefore = fake.state.sent.length

      yield* events.publish(SessionEvent.Text.Ended, {
        sessionID: "ses_beta" as never,
        assistantMessageID: SessionMessage.ID.make("msg_relay"),
        textID: "t1",
        text: "Logo draft is ready.",
        timestamp: DateTime.makeUnsafe(1),
      })
      yield* eventually(
        Effect.sync(() => fake.state.sent.slice(sentBefore)),
        (sent) => sent.some((s) => s.chatID === "300" && s.text === "Logo draft is ready."),
        "relayed out",
      )
      void queue
      yield* store.removeAccount(account.id)
      yield* gateway.reload()
    }),
  )

  it.live("a provider challenge parks the account (no retry-loop) — traffic rules §2.3", () =>
    Effect.gen(function* () {
      const store = yield* MessengerStore.Service
      const gateway = yield* MessengerGateway.Service
      fake.state.challengeNext = true
      const account = yield* store.createAccount({ driverID: "fake", label: "captcha", enabled: true, settings: {} })
      yield* gateway.reload()
      const status = yield* eventually(
        gateway.status(),
        (map) => map.get(account.id)?.state === "challenge",
        "challenge",
      )
      const parked = status.get(account.id)
      expect(parked?.state === "challenge" && parked.message).toContain("CAPTCHA")
      yield* store.removeAccount(account.id)
      yield* gateway.reload()
    }),
  )

  it.live("gateway.send is cold-start-guarded then paced (traffic rules §2.3)", () =>
    Effect.gen(function* () {
      const { store, gateway, account, queue } = yield* online("send")
      // A chat we've never heard from: initiating is refused by default.
      const cold = yield* gateway.send({ accountID: account.id, chatID: "999", text: "hi there" })
      expect(cold.ok).toBe(false)
      if (!cold.ok) expect(cold.reason).toContain("never messaged us")

      // With explicit initiate it goes (and counts against the daily bucket).
      const sentBefore = fake.state.sent.length
      const initiated = yield* gateway.send({ accountID: account.id, chatID: "999", text: "hi there", initiate: true })
      expect(initiated.ok).toBe(true)

      // A chat that HAS messaged us is a reply, never a cold start — allowed without initiate.
      yield* Queue.offer(queue, message("888", { text: "hello", sender: "friend" }))
      yield* eventually(store.hasChat(account.id, "888"), (seen) => seen === true, "seen 888")
      const reply = yield* gateway.send({ accountID: account.id, chatID: "888", text: "welcome back" })
      expect(reply.ok).toBe(true)
      yield* eventually(
        Effect.sync(() => fake.state.sent.slice(sentBefore)),
        (sent) => sent.some((s) => s.chatID === "888" && s.text === "welcome back"),
        "reply delivered",
      )
      yield* store.removeAccount(account.id)
      yield* gateway.reload()
    }),
  )

  it.live("an audience binding does NOT auto-relay (the agent lurks)", () =>
    Effect.gen(function* () {
      const { store, gateway, account } = yield* online("lurk")
      const events = yield* EventV2.Service
      yield* store.createBinding({ accountID: account.id, chatID: "400", sessionID: "ses_audience", trust: "audience" })
      const sentBefore = fake.state.sent.length
      yield* events.publish(SessionEvent.Text.Ended, {
        sessionID: "ses_audience" as never,
        assistantMessageID: SessionMessage.ID.make("msg_lurk"),
        textID: "t1",
        text: "should NOT be posted",
        timestamp: DateTime.makeUnsafe(1),
      })
      yield* Effect.sleep(Duration.millis(150))
      expect(fake.state.sent.slice(sentBefore).some((s) => s.chatID === "400")).toBe(false)
      yield* store.removeAccount(account.id)
      yield* gateway.reload()
    }),
  )
})

// Airgap wins (§1.6): with offline mode on, enabled accounts park as `airgapped` and the driver
// is never touched.
const airgapFake = makeFakeDriver()
const itAirgap = testEffect(
  AppNodeBuilder.build(graph, [
    [
      MessengerDrivers.node,
      Layer.succeed(MessengerDrivers.Service, MessengerDrivers.Service.of(MessengerDrivers.make([airgapFake.driver]))),
    ],
    [Offline.node, offlineMock(true)],
    [SessionV2.node, makeSessionMock().layer],
    [MessengerPace.node, MessengerPace.layerWith({ sleep: () => Effect.void })],
  ]),
)

describe("MessengerGateway (airgapped)", () => {
  itAirgap.live("parks enabled accounts as airgapped and never dials out", () =>
    Effect.gen(function* () {
      const store = yield* MessengerStore.Service
      const gateway = yield* MessengerGateway.Service
      const account = yield* store.createAccount({ driverID: "fake", label: "a", enabled: true, settings: {} })
      yield* gateway.reload()
      const map = yield* gateway.status()
      expect(map.get(account.id)?.state).toBe("airgapped")
      expect(airgapFake.state.connects).toBe(0)
    }),
  )
})
