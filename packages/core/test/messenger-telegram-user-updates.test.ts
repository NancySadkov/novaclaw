import { describe, expect } from "bun:test"
import { Duration, Effect, Layer } from "effect"
import type { Messenger } from "@novaclaw/schema/messenger"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Global } from "@novaclaw/core/global"
import { Offline } from "@novaclaw/core/offline"
import { SessionV2 } from "@novaclaw/core/session"
import type { Driver } from "@novaclaw/core/messenger/driver"
import { MessengerDrivers } from "@novaclaw/core/messenger/drivers"
import { MessengerGateway } from "@novaclaw/core/messenger/gateway"
import { MessengerPace } from "@novaclaw/core/messenger/pace"
import { MessengerStore } from "@novaclaw/core/messenger/store"
import { TelegramUserDriver } from "@novaclaw/core/messenger/driver/telegram-user"
import type { UserClient, UserMessage } from "@novaclaw/core/messenger/driver/telegram-user"
import { TelegramUserMtcute } from "@novaclaw/core/messenger/driver/telegram-user-mtcute"
import { testEffect } from "./lib/effect"

/**
 * **A dead update loop used to leave a Telegram user account "connected" and permanently deaf.**
 *
 * The adapter's `pull()` settled only when a message arrived — it had no rejection path at all —
 * and the loop that feeds it threw its own rejection away (`startUpdatesLoop().catch(() =>
 * undefined)`). So when that loop died past mtcute's internal recovery, the driver's pump sat on a
 * promise nothing could ever settle: the connection attempt never returned, the reconnect ladder was
 * never reached, and the account's status stayed `connected` while it received nothing, forever.
 * Outbound kept working, so it read as "the agent is ignoring me" rather than as a broken account —
 * the hardest failure in this subsystem to diagnose, on the one driver that is live-proven.
 *
 * **What is asserted is the ACCOUNT's observable state, not that a promise rejected.** A rejected
 * promise is a step; the thing a person notices is whether their messenger says it is fine. So the
 * legs below read `gateway.status()`, the same map the Settings banner renders.
 *
 * **Controls, both required and both present:**
 *  · a HEALTHY loop is unchanged — the account reaches `connected`, a pushed message drives all the
 *    way into the inbound ledger, and the status never leaves `connected` while nothing is wrong;
 *  · a TRANSIENT death does not park — the account drops out of `connected` and comes back by
 *    itself, and never reaches `challenge`. Parking a working account on a network blip would be a
 *    worse bug than the one being fixed here.
 *
 * **A/B control for the fix itself.** Restore `pull()` to `new Promise((resolve) => …)` with no
 * `dead` check (or take `fail` out of `messageInbox`): the DEAD-LOOP leg hangs at its first wait and
 * the test times out — which is exactly the production symptom, reproduced.
 *
 * ⚠️ The real inbox is used, not a stand-in: `messageInbox()` is the adapter's own push→pull buffer,
 * exported free of mtcute types precisely so this fault can be exercised without a provider account.
 * The one line it cannot cover is the adapter wiring `startUpdatesLoop().catch(inbox.fail)`, which
 * needs the mtcute client itself.
 */

// ── a fake Telegram client built on the REAL adapter inbox ───────────────────────────────────────

type Case = "healthy" | "transient" | "revoked"

const REVOKED = "Telegram rejected this account's session (AUTH_KEY_UNREGISTERED)"

/**
 * The raw rejection of a promise, as an Effect failure — `Effect.tryPromise`'s default wrapper would
 * hide the driver's own error type behind an adapter class.
 *
 * ⚠️ Bounded, and that bound is load-bearing: the fault under test is a promise that NEVER settles,
 * so without it a regression hangs the gate instead of failing it (measured — the A/B control ran
 * past bun's own per-test timeout). A settled-or-nothing wait must never be written unbounded here.
 */
const settled = <A>(promise: Promise<A>) =>
  Effect.tryPromise({ try: () => promise, catch: (error) => error }).pipe(Effect.timeout(Duration.seconds(5)))

const failure = <A>(promise: Promise<A>) => Effect.flip(settled(promise))

const state = {
  /** Per-case: the live inbox of the newest connection, so the test can push or kill it. */
  inbox: new Map<Case, ReturnType<typeof TelegramUserMtcute.messageInbox>>(),
  /** Set once a case's session is genuinely gone — the reconnect's `me()` then finds it, as Telegram
   *  would. This is the EXISTING challenge door; the new behaviour is only that we ever get here. */
  revoked: new Set<Case>(),
  connects: new Map<Case, number>(),
}

const caseOf = (apiId: number): Case => (apiId === 1 ? "healthy" : apiId === 2 ? "transient" : "revoked")

const fakeClient = async (config: { apiId: number }): Promise<UserClient> => {
  const which = caseOf(config.apiId)
  const inbox = TelegramUserMtcute.messageInbox()
  state.inbox.set(which, inbox)
  state.connects.set(which, (state.connects.get(which) ?? 0) + 1)
  return {
    me: async () => {
      if (state.revoked.has(which))
        throw new TelegramUserDriver.UserClientError({ kind: "challenge", message: REVOKED })
      return { id: "111", name: "Me" }
    },
    sendCode: async () => ({ phoneCodeHash: "h", via: "app" }),
    signIn: async () => undefined,
    checkPassword: async () => undefined,
    exportSession: async () => "session",
    pull: inbox.pull,
    dialogs: async () => [],
    history: async () => [],
    sendText: async () => ({ messageID: "1" }),
    sendFile: async () => ({ messageID: "1" }),
    downloadFile: async () => new Uint8Array(),
    close: async () => undefined,
  }
}

/**
 * The real driver, with the one thing the gateway would have fetched from the credential store
 * supplied inline — everything under test (the pump, the queue, the error mapping, the reconnect)
 * is the shipped code path.
 */
const real = TelegramUserDriver.make(fakeClient)
const driver: Driver = { ...real, connect: (ctx) => real.connect({ ...ctx, secret: "session-blob" }) }

const session = Layer.mock(SessionV2.Service, {
  prompt: () => Effect.succeed(undefined as never),
  list: () => Effect.succeed([] as never),
  get: () => Effect.fail({ _tag: "Session.NotFoundError" } as never),
  revert: {
    stage: () => Effect.die("telegram-user-updates: revert.stage is not part of this test"),
    clear: () => Effect.die("telegram-user-updates: revert.clear is not part of this test"),
    commit: () => Effect.die("telegram-user-updates: revert.commit is not part of this test"),
  } as never,
})

const REPLACEMENTS = [
  [
    MessengerDrivers.node,
    Layer.succeed(MessengerDrivers.Service, MessengerDrivers.Service.of(MessengerDrivers.make([driver]))),
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

const eventually = <A, E>(effect: Effect.Effect<A, E>, predicate: (value: A) => boolean, label: string, rounds = 400) =>
  Effect.gen(function* () {
    for (let round = 0; round < rounds; round++) {
      const value = yield* effect
      if (predicate(value)) return value
      yield* Effect.sleep(Duration.millis(25))
    }
    return yield* Effect.die(`timeout waiting for ${label}`)
  })

const stateOf = (status: ReadonlyMap<Messenger.AccountID, Messenger.AccountStatus>, id: Messenger.AccountID) =>
  status.get(id)?.state ?? "absent"

const settingsFor = (apiId: number) => ({ apiId: String(apiId), apiHash: "a".repeat(32) })

const inboundMessage = (chatID: string, messageID: string): UserMessage => ({
  chatID,
  chatKind: "dm",
  chatTitle: "Alice",
  messageID,
  senderID: "222",
  senderName: "Alice",
  outgoing: false,
  text: "hello",
  at: Date.now(),
})

const killLoop = (which: Case, error: unknown) => {
  const inbox = state.inbox.get(which)
  if (inbox === undefined) throw new Error(`no inbox for ${which}`)
  inbox.fail(error)
}

describe("Telegram user account: a dead update loop", () => {
  it.live("🔴 a dead loop ends the 'connected' claim; a healthy one is untouched; a transient one does not park", () =>
    Effect.gen(function* () {
      const store = yield* MessengerStore.Service
      const gateway = yield* MessengerGateway.Service

      // ── CONTROL A: a healthy loop ────────────────────────────────────────────────────────────
      const healthy = yield* store.createAccount({
        driverID: "telegram-user",
        label: "healthy",
        enabled: true,
        settings: settingsFor(1),
      })
      yield* gateway.reload()
      yield* eventually(gateway.status(), (map) => stateOf(map, healthy.id) === "connected", "healthy connected")
      // Alive, not merely claiming to be: a pushed message travels the whole pump into the ledger.
      state.inbox.get("healthy")?.push(inboundMessage("770", "m1"))
      yield* eventually(store.hasInbound(healthy.id, "770"), (seen) => seen === true, "healthy inbound recorded")
      // And it stays connected while nothing is wrong — the fix must not make a live loop look dead.
      yield* Effect.sleep(Duration.millis(300))
      expect(stateOf(yield* gateway.status(), healthy.id)).toBe("connected")

      // ── THE DEFECT: a loop that dies of an ordinary transport fault ──────────────────────────
      const transient = yield* store.createAccount({
        driverID: "telegram-user",
        label: "transient",
        enabled: true,
        settings: settingsFor(2),
      })
      yield* gateway.reload()
      yield* eventually(gateway.status(), (map) => stateOf(map, transient.id) === "connected", "transient connected")
      const connectsBefore = state.connects.get("transient") ?? 0

      killLoop("transient", new Error("CONNECTION_NOT_INITED"))

      // The account must stop CLAIMING to be connected. Before the fix this never happened: `pull()`
      // could not reject, so nothing downstream ever learned the loop was gone.
      yield* eventually(gateway.status(), (map) => stateOf(map, transient.id) !== "connected", "transient dropped")
      // ── CONTROL B: a transient death reconnects and never parks ──────────────────────────────
      yield* eventually(gateway.status(), (map) => stateOf(map, transient.id) === "connected", "transient recovered")
      expect(state.connects.get("transient") ?? 0).toBeGreaterThan(connectsBefore)
      expect(stateOf(yield* gateway.status(), transient.id)).not.toBe("challenge")

      // ── THE ROUTE INTO THE PARKING MACHINERY: a loop that died because the session is gone ───
      const revoked = yield* store.createAccount({
        driverID: "telegram-user",
        label: "revoked",
        enabled: true,
        settings: settingsFor(3),
      })
      yield* gateway.reload()
      yield* eventually(gateway.status(), (map) => stateOf(map, revoked.id) === "connected", "revoked connected")
      state.revoked.add("revoked")
      killLoop("revoked", new Error("AUTH_KEY_UNREGISTERED"))

      const parked = yield* eventually(
        gateway.status(),
        (map) => stateOf(map, revoked.id) === "challenge",
        "revoked account parked",
      )
      const status = parked.get(revoked.id)
      expect(status?.state === "challenge" ? status.message : "NOT PARKED").toContain(REVOKED)
      // The healthy account is untouched by either death — a shared fault would be a different bug.
      expect(stateOf(parked, healthy.id)).toBe("connected")

      yield* store.removeAccount(healthy.id)
      yield* store.removeAccount(transient.id)
      yield* store.removeAccount(revoked.id)
      yield* gateway.reload()
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          state.revoked.clear()
          state.inbox.clear()
          state.connects.clear()
        }),
      ),
    ),
  )
})

describe("the adapter's push→pull inbox", () => {
  it.live("holds when empty, batches what arrived, and REJECTS once the update loop is gone", () =>
    Effect.gen(function* () {
      const inbox = TelegramUserMtcute.messageInbox()

      // Batching: everything buffered since the last pull comes back at once.
      inbox.push(inboundMessage("1", "a"))
      inbox.push(inboundMessage("1", "b"))
      expect((yield* settled(inbox.pull())).map((message) => message.messageID)).toEqual(["a", "b"])

      // A WAITING pull is settled by the death — this is the wait that used to be forever.
      const waiting = inbox.pull()
      inbox.fail(new Error("CONNECTION_NOT_INITED"))
      expect(String(yield* failure(waiting))).toContain("CONNECTION_NOT_INITED")

      // And so is every later one — a dead loop does not heal.
      expect(String(yield* failure(inbox.pull()))).toContain("CONNECTION_NOT_INITED")

      // The FIRST cause is the one reported; a second death cannot overwrite the diagnosis.
      inbox.fail(new Error("AUTH_KEY_UNREGISTERED"))
      expect(String(yield* failure(inbox.pull()))).toContain("CONNECTION_NOT_INITED")
    }),
  )

  it.live("delivers what already arrived before reporting the death, and classifies a revoked session", () =>
    Effect.gen(function* () {
      const inbox = TelegramUserMtcute.messageInbox()
      inbox.push(inboundMessage("1", "a"))
      inbox.fail(new Error("AUTH_KEY_UNREGISTERED"))
      // Messages that already arrived are real; dropping them would trade one silent fault for
      // another, so the death is reported only once the buffer is drained.
      expect((yield* settled(inbox.pull())).map((message) => message.messageID)).toEqual(["a"])

      // A session-revocation death is a CHALLENGE, which is what makes the driver park the account
      // rather than reconnect-spin against a dead credential.
      const error = yield* failure(inbox.pull())
      expect(error instanceof TelegramUserDriver.UserClientError && error.failure.kind).toBe("challenge")
    }),
  )
})
