export * as MessengerGateway from "./gateway"

import { Context, Duration, Effect, Fiber, FiberSet, Layer, Semaphore, Stream } from "effect"
import { Messenger } from "@novaclaw/schema/messenger"
import { Credential } from "../credential"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { Offline } from "../offline"
import type { Connection, Driver, InboundEvent } from "./driver"
import { MessengerDrivers } from "./drivers"
import { MessengerStore } from "./store"

// The Messenger gateway (notes/messenger-plan.md §3.2): the ONE instance-global service owning
// every live platform connection. UI and runtime need never be colocated (the P2P stance), so
// connections live HERE, server-side — the phone remote-control use case works with the desktop
// closed. P0 scope: the account lifecycle (boot/reload/teardown), the per-account status machine
// (with airgap honesty — OFF-C force-disables every messenger), reconnect backoff, and inbound
// seen-chat upkeep. The full inbound pipeline (commands → bindings → SessionV2.prompt) and the
// outbound relay land with the first driver (P1); routeInbound() is the seam they extend.
// Connection fibers ride the layer scope's FiberSet — teardown interrupts them all (never
// publish from a dying caller fiber; these fibers are the gateway's own, detached from callers).

const BACKOFF_BASE_MS = 1_000
const BACKOFF_FACTOR = 3
const BACKOFF_CAP_MS = 300_000

export interface Interface {
  /** Live per-account connection status (accounts the store knows, whether running or not). */
  readonly status: () => Effect.Effect<ReadonlyMap<Messenger.AccountID, Messenger.AccountStatus>>
  /** Reconcile live connections with the store — call after any account CRUD. Serialized. */
  readonly reload: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/MessengerGateway") {}

type Entry = {
  status: Messenger.AccountStatus
  fiber?: Fiber.Fiber<void, never>
  /** Restart-relevant account shape; a reload only restarts a connection when this changes. */
  fingerprint: string
}

const fingerprintOf = (account: Messenger.AccountInfo): string =>
  JSON.stringify([account.driverID, account.credentialID ?? null, account.settings, account.enabled])

const backoffDelay = (failures: number): number =>
  Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * BACKOFF_FACTOR ** Math.max(0, failures - 1))

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* MessengerStore.Service
    const drivers = yield* MessengerDrivers.Service
    const events = yield* EventV2.Service
    const offline = yield* Offline.Service
    const credentials = yield* Credential.Service
    const fork = yield* FiberSet.makeRuntime<never, void, never>()
    const reloadLock = Semaphore.makeUnsafe(1)

    const entries = new Map<Messenger.AccountID, Entry>()

    const setStatus = (accountID: Messenger.AccountID, entry: Entry, status: Messenger.AccountStatus) =>
      Effect.gen(function* () {
        entry.status = status
        // Status is telemetry for the UI — publish failures never fail the gateway.
        yield* events.publish(Messenger.Event.AccountStatusChanged, { accountID, status }).pipe(Effect.ignore)
      })

    const resolveSecret = (account: Messenger.AccountInfo) =>
      Effect.gen(function* () {
        if (account.credentialID === undefined) return undefined
        const info = yield* credentials.get(account.credentialID)
        if (info === undefined) return undefined
        return info.value.type === "key" ? info.value.key : info.value.access
      })

    const routeInbound = (account: Messenger.AccountInfo, event: InboundEvent) =>
      Effect.gen(function* () {
        // P0: drop self-echo unconditionally and keep the seen-chat cache fresh (for "seen"
        // platforms this cache IS the Tuning picker's chat list). P1 plugs the rest of the
        // pipeline in here: gateway commands → contact trust → binding → SessionV2.prompt.
        if (event.kind !== "message") return
        if (event.sender.isSelf) return
        yield* store.seenChat({
          accountID: account.id,
          chatID: event.chat.chatID,
          kind: event.chat.kind,
          title: event.chat.title,
          at: event.at,
        })
        yield* events.publish(Messenger.Event.ChatSeen, { accountID: account.id, chatID: event.chat.chatID }).pipe(Effect.ignore)
      })

    const consume = (account: Messenger.AccountInfo, connection: Connection) =>
      connection.inbound.pipe(Stream.runForEach((event) => routeInbound(account, event)))

    /** One connect attempt: open the scoped connection, mark connected, drain inbound until the
     *  stream ends or fails. Typed failures reach the loop; interruption unwinds the fiber. */
    const attempt = (account: Messenger.AccountInfo, driver: Driver, entry: Entry) =>
      Effect.scoped(
        Effect.gen(function* () {
          const secret = yield* resolveSecret(account)
          const connection = yield* driver.connect({
            account,
            secret,
            cursor: {
              get: () => store.getCursor(account.id),
              set: (value) => store.setCursor(account.id, value),
            },
          })
          yield* setStatus(account.id, entry, { state: "connected" })
          yield* consume(account, connection)
        }),
      )

    const connectionLoop = (account: Messenger.AccountInfo, driver: Driver, entry: Entry) =>
      Effect.gen(function* () {
        let failures = 0
        while (true) {
          yield* setStatus(account.id, entry, { state: "connecting" })
          const reason = yield* attempt(account, driver, entry).pipe(
            Effect.as("connection ended"),
            Effect.catch((error) => Effect.succeed(error.reason)),
          )
          failures += 1
          const delay = backoffDelay(failures)
          yield* setStatus(account.id, entry, {
            state: "backoff",
            until: Date.now() + delay,
            message: reason,
          })
          yield* Effect.sleep(Duration.millis(delay))
        }
      })

    const stop = (accountID: Messenger.AccountID): Effect.Effect<void> =>
      Effect.suspend(() => {
        const entry = entries.get(accountID)
        entries.delete(accountID)
        return entry?.fiber === undefined ? Effect.void : Fiber.interrupt(entry.fiber).pipe(Effect.asVoid)
      })

    const start = (account: Messenger.AccountInfo, driver: Driver) =>
      Effect.gen(function* () {
        const entry: Entry = { status: { state: "connecting" }, fingerprint: fingerprintOf(account) }
        entries.set(account.id, entry)
        entry.fiber = fork(connectionLoop(account, driver, entry).pipe(Effect.exit, Effect.asVoid))
      })

    const reconcile = Effect.gen(function* () {
      const accounts = yield* store.listAccounts()
      const known = new Set(accounts.map((account) => account.id))
      for (const accountID of [...entries.keys()]) if (!known.has(accountID)) yield* stop(accountID)

      for (const account of accounts) {
        const existing = entries.get(account.id)
        const fingerprint = fingerprintOf(account)

        const parked = (status: Messenger.AccountStatus) =>
          Effect.gen(function* () {
            yield* stop(account.id)
            const entry: Entry = { status, fingerprint }
            entries.set(account.id, entry)
            yield* setStatus(account.id, entry, status)
          })

        if (!account.enabled) {
          if (existing?.status.state !== "disabled") yield* parked({ state: "disabled" })
          continue
        }
        // Airgap wins (messenger-plan §1.6): offline mode parks every account, starts nothing.
        if (offline.policy.enabled) {
          if (existing?.status.state !== "airgapped") yield* parked({ state: "airgapped" })
          continue
        }
        const driver = drivers.get(account.driverID)
        if (driver === undefined) {
          const status: Messenger.AccountStatus = {
            state: "error",
            message: `No "${account.driverID}" messenger driver is installed in this build.`,
          }
          if (existing?.status.state !== "error") yield* parked(status)
          continue
        }
        if (existing?.fiber !== undefined && existing.fingerprint === fingerprint) continue
        yield* stop(account.id)
        yield* start(account, driver)
      }
    })

    const reload = () => reloadLock.withPermit(reconcile)

    // Boot: bring up whatever the store already holds. Best-effort — a broken account parks in
    // its error status; it must never keep the instance from starting.
    yield* reload().pipe(Effect.ignore)

    return Service.of({
      status: () => Effect.sync(() => new Map([...entries].map(([id, entry]) => [id, entry.status]))),
      reload,
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [MessengerStore.node, MessengerDrivers.node, EventV2.node, Offline.node, Credential.node],
})
