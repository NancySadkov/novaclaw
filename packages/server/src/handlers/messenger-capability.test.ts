import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { MessengerGateway } from "@novaclaw/core/messenger/gateway"
import { MessengerLogin } from "@novaclaw/core/messenger/login"
import { acquireGateway, acquireLogin } from "./messenger"

const unavailable = (name: string) => ({
  name,
  get: Effect.succeed({
    ok: false as const,
    error: {
      capability: name,
      kind: "failed" as const,
      summary: `${name} refused during startup`,
    },
  }),
  status: Effect.succeed({ state: "idle" as const }),
  retry: Effect.succeed({ state: "idle" as const }),
})

describe("messenger capability refusals", () => {
  test("maps a gateway refusal through the declared HTTP error arm", async () => {
    const error = await Effect.runPromise(
      acquireGateway.pipe(
        Effect.flip,
        Effect.provide(Layer.succeed(MessengerGateway.CapabilityService, unavailable("messenger"))),
      ),
    )
    expect(error).toMatchObject({
      _tag: "InvalidRequestError",
      kind: "messenger_unavailable",
      message: "messenger refused during startup",
    })
  })

  test("maps a login refusal through the declared HTTP error arm", async () => {
    const error = await Effect.runPromise(
      acquireLogin.pipe(
        Effect.flip,
        Effect.provide(Layer.succeed(MessengerLogin.CapabilityService, unavailable("messenger-login"))),
      ),
    )
    expect(error).toMatchObject({
      _tag: "InvalidRequestError",
      kind: "messenger_login_unavailable",
      message: "messenger-login refused during startup",
    })
  })
})
