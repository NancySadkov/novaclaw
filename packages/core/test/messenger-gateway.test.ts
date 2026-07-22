import { describe, expect } from "bun:test"
import { Duration, Effect, Layer, Queue, Stream } from "effect"
import { Messenger } from "@novaclaw/schema/messenger"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Offline } from "@novaclaw/core/offline"
import { MessengerDriver } from "@novaclaw/core/messenger/driver"
import { MessengerDrivers } from "@novaclaw/core/messenger/drivers"
import { MessengerGateway } from "@novaclaw/core/messenger/gateway"
import { MessengerStore } from "@novaclaw/core/messenger/store"
import { testEffect } from "./lib/effect"

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
    failNext: false,
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
          send: () => Effect.succeed({ messageID: "m1" }),
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

const graph = LayerNode.group([Database.node, EventV2.node, FSUtil.node, MessengerStore.node, MessengerGateway.node])

const it = testEffect(
  AppNodeBuilder.build(graph, [
    [MessengerDrivers.node, Layer.succeed(MessengerDrivers.Service, MessengerDrivers.Service.of(MessengerDrivers.make([fake.driver])))],
    [Offline.node, offlineMock(false)],
  ]),
)

const message = (chatID: string, opts?: { isSelf?: boolean; title?: string }): MessengerDriver.InboundEvent => ({
  kind: "message",
  chat: { chatID, kind: "dm", title: opts?.title ?? "Chat " + chatID },
  messageID: "msg-" + chatID,
  sender: { id: "u1", name: "Nancy", isSelf: opts?.isSelf ?? false },
  text: "hello",
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
