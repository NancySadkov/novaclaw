import { Credential } from "@novaclaw/core/credential"
import { MessengerDrivers } from "@novaclaw/core/messenger/drivers"
import { MessengerGateway } from "@novaclaw/core/messenger/gateway"
import { MessengerLogin } from "@novaclaw/core/messenger/login"
import { MessengerStore } from "@novaclaw/core/messenger/store"
import type { Integration } from "@novaclaw/schema/integration"
import { Messenger } from "@novaclaw/schema/messenger"
import { InvalidRequestError } from "@novaclaw/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder, HttpApiSchema } from "effect/unstable/httpapi"
import { Api } from "../api"

// P0 handlers (notes/messenger-plan.md §5): driver discovery + account CRUD. Secrets go through
// the credential store under a PER-ACCOUNT synthetic integration id — Credential.create replaces
// any credential for an integration, so two accounts on one platform must not share one id. The
// gateway reloads after every mutation so status reflects the store immediately. P1.7 adds the
// login-attempt trio for `login`-auth drivers; a successful complete also reloads the gateway so
// the freshly-credentialed account connects without further user action.

const loginError = (error: MessengerLogin.LoginError) =>
  new InvalidRequestError({
    message: error.message,
    kind: error.retryable ? "messenger_login_retry" : "messenger_login_failed",
  })

const credentialIntegrationID = (driverID: string, accountID: Messenger.AccountID): Integration.ID =>
  `messenger.${driverID}.${accountID}` as Integration.ID

export const MessengerHandler = HttpApiBuilder.group(Api, "server.messenger", (handlers) =>
  Effect.gen(function* () {
    return handlers
      .handle(
        "messenger.driver.list",
        Effect.fn(function* () {
          const drivers = yield* MessengerDrivers.Service
          return drivers.all().map((driver) => driver.meta)
        }),
      )
      .handle(
        "messenger.account.list",
        Effect.fn(function* () {
          const store = yield* MessengerStore.Service
          const gateway = yield* MessengerGateway.Service
          const accounts = yield* store.listAccounts()
          const status = yield* gateway.status()
          return accounts.map((account) => ({
            account,
            status:
              status.get(account.id) ??
              ({ state: account.enabled ? "connecting" : "disabled" } satisfies Messenger.AccountStatus),
          }))
        }),
      )
      .handle(
        "messenger.account.create",
        Effect.fn(function* (ctx) {
          const drivers = yield* MessengerDrivers.Service
          const store = yield* MessengerStore.Service
          const gateway = yield* MessengerGateway.Service
          const credentials = yield* Credential.Service
          if (drivers.get(ctx.payload.driverID) === undefined)
            return yield* Effect.fail(
              new InvalidRequestError({
                message: `No "${ctx.payload.driverID}" messenger driver is installed in this build.`,
                kind: "messenger_driver_unknown",
              }),
            )
          const account = yield* store.createAccount({
            driverID: ctx.payload.driverID,
            label: ctx.payload.label,
            enabled: ctx.payload.enabled,
            settings: ctx.payload.settings,
          })
          if (ctx.payload.secret !== undefined && ctx.payload.secret.length > 0) {
            const credential = yield* credentials.create({
              integrationID: credentialIntegrationID(account.driverID, account.id),
              value: { type: "key", key: ctx.payload.secret },
              label: ctx.payload.label,
            })
            yield* store.updateAccount(account.id, { credentialID: credential.id })
          }
          yield* gateway.reload()
          const created = yield* store.getAccount(account.id)
          return created ?? account
        }),
      )
      .handle(
        "messenger.account.update",
        Effect.fn(function* (ctx) {
          const store = yield* MessengerStore.Service
          const gateway = yield* MessengerGateway.Service
          const credentials = yield* Credential.Service
          const account = yield* store.getAccount(ctx.params.accountID)
          if (account === undefined)
            return yield* Effect.fail(
              new InvalidRequestError({ message: "Unknown messenger account.", kind: "messenger_account_unknown" }),
            )
          if (ctx.payload.secret !== undefined && ctx.payload.secret.length > 0) {
            if (account.credentialID !== undefined) {
              yield* credentials.update(account.credentialID as Credential.ID, {
                value: { type: "key", key: ctx.payload.secret },
              })
            } else {
              const credential = yield* credentials.create({
                integrationID: credentialIntegrationID(account.driverID, account.id),
                value: { type: "key", key: ctx.payload.secret },
                label: ctx.payload.label ?? account.label,
              })
              yield* store.updateAccount(account.id, { credentialID: credential.id })
            }
          }
          yield* store.updateAccount(account.id, {
            ...(ctx.payload.label === undefined ? {} : { label: ctx.payload.label }),
            ...(ctx.payload.enabled === undefined ? {} : { enabled: ctx.payload.enabled }),
            ...(ctx.payload.settings === undefined ? {} : { settings: ctx.payload.settings }),
          })
          yield* gateway.reload()
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "messenger.account.remove",
        Effect.fn(function* (ctx) {
          const store = yield* MessengerStore.Service
          const gateway = yield* MessengerGateway.Service
          const credentials = yield* Credential.Service
          const account = yield* store.getAccount(ctx.params.accountID)
          if (account?.credentialID !== undefined) yield* credentials.remove(account.credentialID as Credential.ID)
          if (account !== undefined) yield* store.removeAccount(account.id)
          yield* gateway.reload()
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "messenger.account.pair",
        Effect.fn(function* (ctx) {
          const store = yield* MessengerStore.Service
          const gateway = yield* MessengerGateway.Service
          const account = yield* store.getAccount(ctx.params.accountID)
          if (account === undefined)
            return yield* Effect.fail(
              new InvalidRequestError({ message: "Unknown messenger account.", kind: "messenger_account_unknown" }),
            )
          return yield* gateway.mintPairingCode(account.id, ctx.payload.trust)
        }),
      )
      .handle(
        "messenger.login.begin",
        Effect.fn(function* (ctx) {
          const login = yield* MessengerLogin.Service
          return yield* login
            .begin({ accountID: ctx.params.accountID, inputs: ctx.payload.inputs })
            .pipe(Effect.mapError(loginError))
        }),
      )
      .handle(
        "messenger.login.status",
        Effect.fn(function* (ctx) {
          const login = yield* MessengerLogin.Service
          return yield* login.status(ctx.params.attemptID).pipe(Effect.mapError(loginError))
        }),
      )
      .handle(
        "messenger.login.complete",
        Effect.fn(function* (ctx) {
          const login = yield* MessengerLogin.Service
          const gateway = yield* MessengerGateway.Service
          yield* login.complete({ attemptID: ctx.params.attemptID, code: ctx.payload.code }).pipe(Effect.mapError(loginError))
          // The account now holds its session credential — connect it right away.
          yield* gateway.reload()
          return HttpApiSchema.NoContent.make()
        }),
      )
      .handle(
        "messenger.login.cancel",
        Effect.fn(function* (ctx) {
          const login = yield* MessengerLogin.Service
          yield* login.cancel(ctx.params.attemptID)
          return HttpApiSchema.NoContent.make()
        }),
      )
  }),
)
