export * as MessengerLogin from "./login"

import { Clock, Context, Duration, Effect, Exit, Layer, Schedule, Schema, Scope, Semaphore } from "effect"
import { Integration } from "@novaclaw/schema/integration"
import { Messenger } from "@novaclaw/schema/messenger"
import { Credential } from "../credential"
import { makeGlobalNode } from "../effect/app-node"
import type { LoginProgress } from "./driver"
import { MessengerDrivers } from "./drivers"
import { MessengerStore } from "./store"

// The `login`-auth attempt manager (messenger-plan §0.2): phone → the provider texts a code →
// complete(code) → the session credential lands in the credential store and the account row
// points at it. Mirrors the Integration OAuth-attempt machinery (pending/complete/failed/expired,
// TTL, scrub) but lives HERE because messenger accounts are instance-global while
// Integration.Service is location-scoped — and the credential lands under the same per-account
// synthetic integration id the account routes established in P0 (`messenger.<driver>.<account>`),
// so two accounts on one platform never clobber each other's credential.

export class LoginError extends Schema.TaggedErrorClass<LoginError>()("MessengerLogin.Error", {
  message: Schema.String,
  /** true → the attempt is STILL PENDING (mistyped code — just ask again); false → terminal. */
  retryable: Schema.Boolean,
}) {}

export interface Interface {
  /** Starts a login attempt for a `login`-auth account. `inputs` answer `meta.loginPrompts`. */
  readonly begin: (input: {
    readonly accountID: Messenger.AccountID
    readonly inputs: Record<string, string>
  }) => Effect.Effect<Messenger.LoginAttempt, LoginError>
  /** The attempt's live state — including the step's CURRENT instructions/QR for a driver whose
   *  step rotates (WhatsApp's linked-device QR expires every ~20s). The wizard polls this. */
  readonly status: (attemptID: Messenger.LoginAttemptID) => Effect.Effect<Messenger.LoginStatus, LoginError>
  /** Completes the attempt: stores the session credential and points the account at it. The
   *  CALLER owns the follow-up `gateway.reload()` (login is deliberately gateway-agnostic). */
  readonly complete: (input: {
    readonly attemptID: Messenger.LoginAttemptID
    readonly code: string
  }) => Effect.Effect<void, LoginError>
  readonly cancel: (attemptID: Messenger.LoginAttemptID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/MessengerLogin") {}

const attemptLifetime = Duration.toMillis(Duration.minutes(10))
const terminalRetention = Duration.toMillis(Duration.minutes(1))
const scrubInterval = Duration.seconds(30)

type AttemptTime = { readonly created: number; readonly expires: number }
type PendingAttempt = {
  status: "pending"
  completing: boolean
  accountID: Messenger.AccountID
  driverID: string
  label: string
  complete: (code: string) => Effect.Effect<{ session: string }, unknown>
  /** The driver's live step presentation, when it rotates (WhatsApp QR); absent = `instructions` stands. */
  progress: (() => Effect.Effect<LoginProgress>) | undefined
  instructions: string
  scope: Scope.Closeable
  time: AttemptTime
}
type TerminalAttempt = {
  status: "complete" | "failed" | "expired"
  message?: string
  removeAt: number
  time: AttemptTime
}
type AttemptEntry = PendingAttempt | TerminalAttempt

const credentialIntegrationID = (driverID: string, accountID: Messenger.AccountID): Integration.ID =>
  `messenger.${driverID}.${accountID}` as Integration.ID

const describe = (error: unknown): { message: string; retryable: boolean } => {
  if (error !== null && typeof error === "object" && "_tag" in error) {
    const tagged = error as { _tag: string; reason?: string; message?: string; retryable?: boolean }
    if (tagged._tag === "MessengerDriver.LoginCodeError")
      return { message: tagged.reason ?? "Login failed.", retryable: tagged.retryable === true }
    if (tagged._tag === "MessengerDriver.ChallengeError")
      return { message: tagged.message ?? "The provider demands verification.", retryable: false }
    if (tagged._tag === "MessengerDriver.ConnectError") return { message: tagged.reason ?? "Login failed.", retryable: false }
  }
  return { message: error instanceof Error ? error.message : String(error), retryable: false }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* MessengerStore.Service
    const drivers = yield* MessengerDrivers.Service
    const credentials = yield* Credential.Service
    const scope = yield* Scope.Scope
    const lock = Semaphore.makeUnsafe(1)
    const attempts = new Map<Messenger.LoginAttemptID, AttemptEntry>()

    const close = (attemptScope: Scope.Closeable) =>
      Scope.close(attemptScope, Exit.void).pipe(Effect.forkIn(scope, { startImmediately: true }), Effect.asVoid)

    const scrub = Effect.fnUntraced(function* () {
      const now = yield* Clock.currentTimeMillis
      const expired: Scope.Closeable[] = []
      yield* lock.withPermit(
        Effect.sync(() => {
          for (const [id, attempt] of attempts) {
            if (attempt.status === "pending" && attempt.time.expires <= now) {
              expired.push(attempt.scope)
              attempts.set(id, { status: "expired", time: attempt.time, removeAt: now + terminalRetention })
              continue
            }
            if (attempt.status !== "pending" && attempt.removeAt <= now) attempts.delete(id)
          }
        }),
      )
      yield* Effect.forEach(expired, close, { discard: true })
    })

    yield* scrub().pipe(Effect.repeat(Schedule.spaced(scrubInterval)), Effect.forkIn(scope))

    return Service.of({
      begin: Effect.fn("MessengerLogin.begin")(function* (input) {
        const account = yield* store.getAccount(input.accountID)
        if (account === undefined)
          return yield* Effect.fail(new LoginError({ message: "Unknown messenger account.", retryable: false }))
        const driver = drivers.get(account.driverID)
        if (driver === undefined)
          return yield* Effect.fail(
            new LoginError({ message: `No "${account.driverID}" messenger driver is installed in this build.`, retryable: false }),
          )
        if (driver.meta.auth !== "login" || driver.login === undefined)
          return yield* Effect.fail(
            new LoginError({ message: `${driver.meta.name} does not use a login flow — paste its key instead.`, retryable: false }),
          )
        const attemptScope = yield* Scope.fork(scope)
        const pending = yield* driver.login.begin({ account, inputs: input.inputs }).pipe(
          Scope.provide(attemptScope),
          Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(attemptScope, exit) : Effect.void)),
          Effect.catch((error) => {
            const { message } = describe(error)
            return Effect.fail(new LoginError({ message, retryable: false }))
          }),
        )
        const created = yield* Clock.currentTimeMillis
        const time: AttemptTime = { created, expires: created + attemptLifetime }
        const attemptID = Messenger.LoginAttemptID.create()
        yield* lock.withPermit(
          Effect.sync(() =>
            attempts.set(attemptID, {
              status: "pending",
              completing: false,
              accountID: account.id,
              driverID: account.driverID,
              label: account.label,
              complete: pending.complete,
              progress: pending.progress,
              instructions: pending.instructions,
              scope: attemptScope,
              time,
            }),
          ),
        )
        return new Messenger.LoginAttempt({
          attemptID,
          instructions: pending.instructions,
          ...(pending.qrImage !== undefined ? { qrImage: pending.qrImage } : {}),
          time,
        })
      }),

      status: Effect.fn("MessengerLogin.status")(function* (attemptID) {
        const attempt = attempts.get(attemptID)
        if (attempt === undefined)
          return yield* Effect.fail(new LoginError({ message: "Unknown or expired login attempt.", retryable: false }))
        if (attempt.status === "failed")
          return new Messenger.LoginStatus({ status: "failed", message: attempt.message ?? "Login failed.", time: attempt.time })
        if (attempt.status !== "pending") return new Messenger.LoginStatus({ status: attempt.status, time: attempt.time })
        // Pending: re-ask the driver what the user should be looking at NOW. A rotating step (the
        // WhatsApp QR) has almost certainly changed since begin(); a driver without `progress` keeps
        // its original instructions. A progress failure must never break polling — fall back.
        const live = attempt.progress
          ? yield* attempt.progress().pipe(Effect.catchCause(() => Effect.succeed({ instructions: attempt.instructions } as LoginProgress)))
          : ({ instructions: attempt.instructions } satisfies LoginProgress)
        return new Messenger.LoginStatus({
          status: "pending",
          instructions: live.instructions,
          ...(live.qrImage !== undefined ? { qrImage: live.qrImage } : {}),
          time: attempt.time,
        })
      }),

      complete: Effect.fn("MessengerLogin.complete")(function* (input) {
        // Claim the attempt under the lock so two concurrent completes cannot both run.
        const claimed = yield* lock.withPermit(
          Effect.sync(() => {
            const attempt = attempts.get(input.attemptID)
            if (attempt === undefined || attempt.status !== "pending" || attempt.completing) return undefined
            attempt.completing = true
            return attempt
          }),
        )
        if (claimed === undefined) {
          const attempt = attempts.get(input.attemptID)
          if (attempt === undefined)
            return yield* Effect.fail(new LoginError({ message: "Unknown or expired login attempt.", retryable: false }))
          if (attempt.status === "complete") return
          return yield* Effect.fail(
            new LoginError({
              message: attempt.status === "pending" ? "This attempt is already completing." : "This login attempt has ended — start again.",
              retryable: false,
            }),
          )
        }
        const outcome = yield* claimed.complete(input.code).pipe(
          Effect.map((value) => ({ ok: true, value }) as const),
          Effect.catch((error) => Effect.succeed({ ok: false, error } as const)),
        )
        const now = yield* Clock.currentTimeMillis
        if (outcome.ok) {
          const credential = yield* credentials.create({
            integrationID: credentialIntegrationID(claimed.driverID, claimed.accountID),
            value: { type: "key", key: outcome.value.session },
            label: claimed.label,
          })
          yield* store.updateAccount(claimed.accountID, { credentialID: credential.id })
          yield* lock.withPermit(
            Effect.sync(() =>
              attempts.set(input.attemptID, { status: "complete", time: claimed.time, removeAt: now + terminalRetention }),
            ),
          )
          yield* close(claimed.scope)
          return
        }
        const { message, retryable } = describe(outcome.error)
        if (retryable) {
          // A mistyped code: the provider keeps the round alive — stay pending, let them retype.
          yield* lock.withPermit(Effect.sync(() => (claimed.completing = false)))
          return yield* Effect.fail(new LoginError({ message, retryable: true }))
        }
        yield* lock.withPermit(
          Effect.sync(() =>
            attempts.set(input.attemptID, { status: "failed", message, time: claimed.time, removeAt: now + terminalRetention }),
          ),
        )
        yield* close(claimed.scope)
        return yield* Effect.fail(new LoginError({ message, retryable: false }))
      }),

      cancel: Effect.fn("MessengerLogin.cancel")(function* (attemptID) {
        const attempt = yield* lock.withPermit(
          Effect.sync(() => {
            const match = attempts.get(attemptID)
            if (match === undefined || match.status !== "pending") return undefined
            attempts.delete(attemptID)
            return match
          }),
        )
        if (attempt !== undefined) yield* Scope.close(attempt.scope, Exit.void)
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [MessengerStore.node, MessengerDrivers.node, Credential.node],
})
