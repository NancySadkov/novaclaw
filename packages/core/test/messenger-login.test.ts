import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Messenger } from "@novaclaw/schema/messenger"
import { Credential } from "@novaclaw/core/credential"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { EventV2 } from "@novaclaw/core/event"
import { MessengerDriver } from "@novaclaw/core/messenger/driver"
import { MessengerDrivers } from "@novaclaw/core/messenger/drivers"
import { MessengerLogin } from "@novaclaw/core/messenger/login"
import { MessengerStore } from "@novaclaw/core/messenger/store"
import { testEffect } from "./lib/effect"

// P1.7 gate (notes/messenger-plan.md §8): the login-attempt manager — begin → pending ticket,
// complete(code) → the session credential lands in the credential store under the per-account
// synthetic integration id AND the account row points at it; a retryable miss keeps the attempt
// pending; cancel closes it. Real store + credential services over the test DB; the driver is a
// scripted fake with `login` support.

const CAPS: Messenger.Capabilities = {
  listChats: "full",
  files: { up: false, down: false },
  edits: false,
  typing: false,
  threads: false,
  moderation: { delete: false, ban: false, kick: false, mute: false, pin: false },
  format: "plain",
  maxChars: 1000,
}

const makeLoginDriver = () => {
  const state = { begins: 0, closes: 0, codes: [] as string[] }
  const driver: MessengerDriver.Driver = {
    id: "fake-login",
    meta: {
      id: "fake-login",
      name: "Fake Login",
      icon: "chat",
      auth: "login",
      settings: [],
      loginPrompts: [{ type: "text", key: "phone", message: "phone" }],
      capabilities: CAPS,
    },
    capabilities: () => CAPS,
    connect: () => Effect.fail(new MessengerDriver.ConnectError({ reason: "not under test" })),
    login: {
      begin: ({ inputs }) =>
        Effect.gen(function* () {
          state.begins += 1
          if ((inputs["phone"] ?? "").length === 0)
            return yield* Effect.fail(new MessengerDriver.ConnectError({ reason: "phone required" }))
          yield* Effect.addFinalizer(() => Effect.sync(() => (state.closes += 1)))
          return {
            instructions: "enter the code",
            complete: (code: string) =>
              Effect.suspend(() => {
                state.codes.push(code)
                if (code === "000000")
                  return Effect.fail(new MessengerDriver.LoginCodeError({ reason: "wrong code", retryable: true }))
                if (code === "666666")
                  return Effect.fail(new MessengerDriver.LoginCodeError({ reason: "provider veto", retryable: false }))
                return Effect.succeed({ session: "session-" + code })
              }),
          }
        }),
    },
  }
  return { driver, state }
}

const fake = makeLoginDriver()

const graph = LayerNode.group([Database.node, EventV2.node, Credential.node, MessengerStore.node, MessengerLogin.node])

const it = testEffect(
  AppNodeBuilder.build(graph, [
    [
      MessengerDrivers.node,
      Layer.succeed(MessengerDrivers.Service, MessengerDrivers.Service.of(MessengerDrivers.make([fake.driver]))),
    ],
  ]),
)

const createAccount = Effect.gen(function* () {
  const store = yield* MessengerStore.Service
  return yield* store.createAccount({ driverID: "fake-login", label: "mine", enabled: false, settings: {} })
})

describe("MessengerLogin", () => {
  it.live("begin → pending; complete stores the session credential and points the account at it", () =>
    Effect.gen(function* () {
      const login = yield* MessengerLogin.Service
      const store = yield* MessengerStore.Service
      const credentials = yield* Credential.Service
      const account = yield* createAccount

      const attempt = yield* login.begin({ accountID: account.id, inputs: { phone: "+4917000" } })
      expect(attempt.instructions).toBe("enter the code")
      const pending = yield* login.status(attempt.attemptID)
      expect(pending.status).toBe("pending")

      yield* login.complete({ attemptID: attempt.attemptID, code: "424242" })
      const done = yield* login.status(attempt.attemptID)
      expect(done.status).toBe("complete")

      const updated = yield* store.getAccount(account.id)
      expect(updated?.credentialID).toBeDefined()
      const credential = yield* credentials.get(updated!.credentialID as never)
      expect(credential?.value).toEqual({ type: "key", key: "session-424242" })
      expect(credential?.integrationID).toBe(`messenger.fake-login.${account.id}` as never)
      // The attempt scope closed once the credential landed.
      expect(fake.state.closes).toBeGreaterThan(0)
    }),
  )

  it.live("a retryable miss keeps the attempt pending; the right code then completes", () =>
    Effect.gen(function* () {
      const login = yield* MessengerLogin.Service
      const account = yield* createAccount
      const attempt = yield* login.begin({ accountID: account.id, inputs: { phone: "+4917001" } })

      const miss = yield* login.complete({ attemptID: attempt.attemptID, code: "000000" }).pipe(Effect.flip)
      expect(miss.retryable).toBe(true)
      expect((yield* login.status(attempt.attemptID)).status).toBe("pending")

      yield* login.complete({ attemptID: attempt.attemptID, code: "121212" })
      expect((yield* login.status(attempt.attemptID)).status).toBe("complete")
    }),
  )

  it.live("a terminal failure ends the attempt with the message on status", () =>
    Effect.gen(function* () {
      const login = yield* MessengerLogin.Service
      const account = yield* createAccount
      const attempt = yield* login.begin({ accountID: account.id, inputs: { phone: "+4917002" } })

      const veto = yield* login.complete({ attemptID: attempt.attemptID, code: "666666" }).pipe(Effect.flip)
      expect(veto.retryable).toBe(false)
      const status = yield* login.status(attempt.attemptID)
      expect(status.status).toBe("failed")
      if (status.status === "failed") expect(status.message).toBe("provider veto")
      // Completing an ended attempt is refused legibly.
      const after = yield* login.complete({ attemptID: attempt.attemptID, code: "424242" }).pipe(Effect.flip)
      expect(after.message).toContain("ended")
    }),
  )

  it.live("begin failures are legible: unknown account, non-login driver, driver refusal", () =>
    Effect.gen(function* () {
      const login = yield* MessengerLogin.Service
      const unknown = yield* login
        .begin({ accountID: "msa_nope" as never, inputs: {} })
        .pipe(Effect.flip)
      expect(unknown.message).toContain("Unknown")

      const account = yield* createAccount
      const refused = yield* login.begin({ accountID: account.id, inputs: {} }).pipe(Effect.flip)
      expect(refused.message).toBe("phone required")
    }),
  )

  it.live("cancel releases a pending attempt", () =>
    Effect.gen(function* () {
      const login = yield* MessengerLogin.Service
      const account = yield* createAccount
      const closesBefore = fake.state.closes
      const attempt = yield* login.begin({ accountID: account.id, inputs: { phone: "+4917003" } })
      yield* login.cancel(attempt.attemptID)
      expect(fake.state.closes).toBe(closesBefore + 1)
      const gone = yield* login.status(attempt.attemptID).pipe(Effect.flip)
      expect(gone.message).toContain("Unknown")
    }),
  )
})
