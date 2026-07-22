export * as MessengerGateway from "./gateway"

import { Context, Duration, Effect, Fiber, FiberSet, Layer, Semaphore, Stream } from "effect"
import { Messenger } from "@novaclaw/schema/messenger"
import { Session } from "@novaclaw/schema/session"
import { SessionEvent } from "@novaclaw/schema/session-event"
import { Credential } from "../credential"
import { makeGlobalNode } from "../effect/app-node"
import { EventV2 } from "../event"
import { Offline } from "../offline"
import { SessionV2 } from "../session"
import { MessengerCommands } from "./commands"
import type { Connection, Driver, InboundEvent } from "./driver"
import { MessengerDrivers } from "./drivers"
import { MessengerPipeline } from "./pipeline"
import { MessengerStore } from "./store"

// The Messenger gateway (notes/messenger-plan.md §3.2): the ONE instance-global service owning
// every live platform connection. UI and runtime need never be colocated (the P2P stance), so
// connections live HERE, server-side — the phone remote-control use case works with the desktop
// closed. Scope (P0 + P1): account lifecycle + status machine (airgap-honest), reconnect backoff,
// the INBOUND pipeline (self-echo drop → seen-cache → gateway commands → binding → SessionV2.prompt)
// and the OUTBOUND relay (subscribe finished assistant text → format → driver.send). Connection
// fibers + the relay ride the layer scope's FiberSet — teardown interrupts them all (never publish
// from a dying caller fiber; these fibers are the gateway's own, detached from callers).

const BACKOFF_BASE_MS = 1_000
const BACKOFF_FACTOR = 3
const BACKOFF_CAP_MS = 300_000
const PAIRING_TTL_MS = 10 * 60_000

export interface PairingCode {
  readonly code: string
  readonly expiresAt: number
}

export interface Interface {
  /** Live per-account connection status (accounts the store knows, whether running or not). */
  readonly status: () => Effect.Effect<ReadonlyMap<Messenger.AccountID, Messenger.AccountStatus>>
  /** Reconcile live connections with the store — call after any account CRUD. Serialized. */
  readonly reload: () => Effect.Effect<void>
  /** Mint a single-use pairing code (10-min TTL) a sender redeems with `/pair <code>` to become a
   *  contact at `trust`. This is how a stranger becomes somebody (messenger-plan §7). */
  readonly mintPairingCode: (accountID: Messenger.AccountID, trust: Messenger.ContactTrust) => Effect.Effect<PairingCode>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/MessengerGateway") {}

type Entry = {
  status: Messenger.AccountStatus
  fiber?: Fiber.Fiber<void, never>
  connection?: Connection
  fingerprint: string
}

const fingerprintOf = (account: Messenger.AccountInfo): string =>
  JSON.stringify([account.driverID, account.credentialID ?? null, account.settings, account.enabled])

const backoffDelay = (failures: number): number =>
  Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * BACKOFF_FACTOR ** Math.max(0, failures - 1))

const newPairingCode = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(3))
  const digits = Array.from(bytes, (byte) => (byte % 100).toString().padStart(2, "0")).join("")
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}`
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* MessengerStore.Service
    const drivers = yield* MessengerDrivers.Service
    const events = yield* EventV2.Service
    const offline = yield* Offline.Service
    const credentials = yield* Credential.Service
    const sessions = yield* SessionV2.Service
    const fork = yield* FiberSet.makeRuntime<never, void, never>()
    const reloadLock = Semaphore.makeUnsafe(1)

    const entries = new Map<Messenger.AccountID, Entry>()
    const pairing = new Map<string, { accountID: Messenger.AccountID; trust: Messenger.ContactTrust; expiresAt: number }>()
    // Last `/sessions` listing per operator chat, so `/use N` indexes exactly what they saw.
    const listings = new Map<string, string[]>()

    const setStatus = (accountID: Messenger.AccountID, entry: Entry, status: Messenger.AccountStatus) =>
      Effect.gen(function* () {
        entry.status = status
        yield* events.publish(Messenger.Event.AccountStatusChanged, { accountID, status }).pipe(Effect.ignore)
      })

    const resolveSecret = (account: Messenger.AccountInfo) =>
      Effect.gen(function* () {
        if (account.credentialID === undefined) return undefined
        const info = yield* credentials.get(account.credentialID as Credential.ID)
        if (info === undefined) return undefined
        return info.value.type === "key" ? info.value.key : info.value.access
      })

    // ── inbound ────────────────────────────────────────────────────────────────────────────────

    const reply = (send: Connection["send"], chatID: string, text: string) =>
      send(chatID, { text }).pipe(Effect.ignore)

    const handleCommand = (
      account: Messenger.AccountInfo,
      send: Connection["send"],
      event: Extract<InboundEvent, { kind: "message" }>,
      command: MessengerCommands.Command,
      trust: Messenger.ContactTrust | undefined,
    ) =>
      Effect.gen(function* () {
        const key = MessengerPipeline.chatKey(account.id, event.chat.chatID)
        // /pair is the ONLY command a non-operator may run — it's how they become one.
        if (command.kind === "pair") {
          const now = Date.now()
          const record = pairing.get(command.code)
          if (record === undefined || record.accountID !== account.id || record.expiresAt < now) {
            yield* reply(send, event.chat.chatID, "That pairing code is invalid or expired. Mint a fresh one in Settings → Messengers.")
            return
          }
          pairing.delete(command.code)
          yield* store.upsertContact({
            accountID: account.id,
            senderID: event.sender.id,
            name: event.sender.name,
            trust: record.trust,
            pairedAt: now,
          })
          yield* reply(send, event.chat.chatID, `Paired — you're set as "${record.trust}". Send /help to see what you can do.`)
          return
        }
        // Everything else is operator-only, in a DM.
        if (trust !== "operator" || event.chat.kind !== "dm") {
          yield* reply(send, event.chat.chatID, "Only the operator can run that, and only in a direct message.")
          return
        }
        switch (command.kind) {
          case "help":
            yield* reply(send, event.chat.chatID, MessengerPipeline.HELP_TEXT)
            return
          case "status": {
            const binding = yield* store.bindingForChat(account.id, event.chat.chatID)
            yield* reply(
              send,
              event.chat.chatID,
              binding === undefined
                ? "This chat isn't driving any session. /sessions then /use <n>."
                : `This chat drives session ${binding.sessionID} (${binding.trust}).`,
            )
            return
          }
          case "sessions": {
            const list = yield* sessions.list({ order: "desc" }).pipe(Effect.orElseSucceed(() => []))
            const rendered = MessengerPipeline.renderSessions(
              list.map((session) => ({
                id: session.id,
                ...(session.title ? { title: session.title } : {}),
                ...(session.agent ? { agent: session.agent } : {}),
              })),
            )
            listings.set(key, rendered.ids)
            yield* reply(send, event.chat.chatID, rendered.text)
            return
          }
          case "use": {
            const ids = listings.get(key) ?? []
            const sessionID = ids[command.index - 1]
            if (sessionID === undefined) {
              yield* reply(send, event.chat.chatID, "Run /sessions first, then /use a number from that list.")
              return
            }
            const existing = yield* store.bindingForChat(account.id, event.chat.chatID)
            if (existing !== undefined) yield* store.removeBinding(existing.id)
            const binding = yield* store
              .createBinding({ accountID: account.id, chatID: event.chat.chatID, sessionID, trust: "operator" })
              .pipe(Effect.orElseSucceed(() => undefined))
            if (binding !== undefined)
              yield* events
                .publish(Messenger.Event.BindingUpdated, { bindingID: binding.id, sessionID: sessionID as Session.ID })
                .pipe(Effect.ignore)
            yield* reply(send, event.chat.chatID, `This chat now drives session ${sessionID}. Just type to talk to it.`)
            return
          }
          case "new":
          case "stop":
            // Both need machinery P1 defers (a working-directory pick / a drain interrupt seam) —
            // honest degrade, tracked as P1b, never a silent no-op.
            yield* reply(
              send,
              event.chat.chatID,
              command.kind === "new"
                ? "Creating a new session from chat is coming soon — for now make one in the app, then /use its number."
                : "To stop the agent, use the app for now.",
            )
            return
          case "unknown":
            yield* reply(send, event.chat.chatID, `Unknown command /${command.name}. /help for the list.`)
            return
        }
      })

    const routeInbound = (account: Messenger.AccountInfo, send: Connection["send"], event: InboundEvent) =>
      Effect.gen(function* () {
        if (event.kind !== "message") return
        if (event.sender.isSelf) return // echo guard #1
        yield* store.seenChat({
          accountID: account.id,
          chatID: event.chat.chatID,
          kind: event.chat.kind,
          title: event.chat.title,
          at: event.at,
        })
        yield* events.publish(Messenger.Event.ChatSeen, { accountID: account.id, chatID: event.chat.chatID }).pipe(Effect.ignore)

        const contact = yield* store.getContact(account.id, event.sender.id)
        if (contact?.trust === "blocked") return // dropped before anything else sees it

        const command = event.text ? MessengerCommands.parse(event.text) : undefined
        if (command !== undefined) {
          yield* handleCommand(account, send, event, command, contact?.trust)
          return
        }

        // Not a command → route to the bound session (a genuine queued user turn), or guide.
        const binding = yield* store.bindingForChat(account.id, event.chat.chatID)
        if (binding === undefined) {
          if (contact === undefined) {
            // Unpaired stranger: silence by default (never a model turn — cost + injection surface).
            return
          }
          yield* reply(send, event.chat.chatID, "No session is linked here yet. /sessions then /use <n>.")
          return
        }
        const text = MessengerPipeline.provenance(event, account.driverID, binding.trust)
        yield* sessions
          .prompt({ sessionID: binding.sessionID as Session.ID, prompt: { text }, delivery: "queue" })
          .pipe(
            Effect.catch(() => reply(send, event.chat.chatID, "That session is no longer available. /sessions to pick another.")),
          )
      })

    const consume = (account: Messenger.AccountInfo, connection: Connection) =>
      connection.inbound.pipe(Stream.runForEach((event) => routeInbound(account, connection.send, event)))

    // ── outbound relay ───────────────────────────────────────────────────────────────────────────

    // ONE cross-session tap on finished assistant text → send to every chat bound to that session.
    // `audience` bindings do NOT auto-relay (the agent lurks; it speaks via explicit tool ops).
    const relay = events.subscribe(SessionEvent.Text.Ended).pipe(
      Stream.runForEach((payload) =>
        Effect.gen(function* () {
          const bound = yield* store.bindingsForSession(payload.data.sessionID).pipe(Effect.orElseSucceed(() => []))
          for (const binding of bound) {
            if (binding.status !== "active" || binding.trust === "audience") continue
            const entry = entries.get(binding.accountID)
            if (entry?.connection === undefined) continue
            yield* entry.connection.send(binding.chatID, { text: payload.data.text }).pipe(Effect.ignore)
          }
        }),
      ),
    )

    // ── connection lifecycle ─────────────────────────────────────────────────────────────────────

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
          entry.connection = connection
          yield* Effect.addFinalizer(() => Effect.sync(() => (entry.connection = undefined)))
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
          yield* setStatus(account.id, entry, { state: "backoff", until: Date.now() + delay, message: reason })
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
      Effect.sync(() => {
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

    yield* Effect.forkScoped(relay.pipe(Effect.catchCause(() => Effect.void)))
    yield* reload().pipe(Effect.ignore)

    return Service.of({
      status: () => Effect.sync(() => new Map([...entries].map(([id, entry]) => [id, entry.status]))),
      reload,
      mintPairingCode: (accountID, trust) =>
        Effect.sync(() => {
          const code = newPairingCode()
          pairing.set(code, { accountID, trust, expiresAt: Date.now() + PAIRING_TTL_MS })
          return { code, expiresAt: Date.now() + PAIRING_TTL_MS }
        }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [MessengerStore.node, MessengerDrivers.node, EventV2.node, Offline.node, Credential.node, SessionV2.node],
})
