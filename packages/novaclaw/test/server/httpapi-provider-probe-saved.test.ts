import { describe, expect } from "bun:test"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Effect, Layer } from "effect"
import { resetDatabase } from "../fixture/db"
import { testEffectShared } from "../lib/effect"
import { httpApiLayer, request } from "./httpapi-layer"

// Testing a SAVED model must resolve that provider's own address.
//
// The defect this pins, measured against a live instance 2026-09-02: the probe read the endpoint from
// `Config.get().providers`, which has been EMPTY since providers moved into `CatalogStore`
// (settings-in-SQLite). A PATCH of `providers` is routed to the catalog by a layered arm and the
// config document keeps nothing, so `GET /config` reported the URL correctly while the probe — same
// process, same request — saw no providers at all and answered "no-url".
//
// Two paths reach this endpoint and only one of them was alive. The New-Model dialog passes a
// `baseURL` in the payload, so discovery worked; Test on an already-saved model passes no baseURL and
// could therefore only ever fail. The dead one is the path a user reaches from Settings, which is why
// it read as "this used to work".
//
// The assertion is deliberately about RESOLUTION, not reachability: the URL points at a closed port,
// so a correct probe answers "unreachable" and a broken one answers "no-url". That keeps the test off
// the network while still failing if the endpoint is read from the wrong source again.
const testStateLayer = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.promise(() => resetDatabase()),
    () => Effect.promise(() => resetDatabase()),
  ),
)

const it = testEffectShared(Layer.mergeAll(testStateLayer, FSUtil.defaultLayer, httpApiLayer))

const PROVIDER = "probe-saved-fixture"
// Port 1 refuses immediately on every platform we ship, so this costs no wall clock.
const CLOSED = "http://127.0.0.1:1/v1"

const json = (body: unknown) => ({
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

const save = () =>
  request(
    "/config",
    json({
      providers: {
        [PROVIDER]: {
          name: "Probe fixture",
          api: { type: "aisdk", package: "@ai-sdk/openai-compatible", url: CLOSED },
          models: { "fixture-model": { name: "fixture-model" } },
        },
      },
    }),
  )

const probe = (payload: Record<string, unknown>) =>
  request(`/provider/${PROVIDER}/probe`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  })

describe("probing a SAVED provider", () => {
  it.instance(
    "resolves the endpoint from the provider the user saved, with no baseURL in the payload",
    Effect.gen(function* () {
      const saved = yield* save()
      expect(saved.status).toBe(200)

      const response = yield* probe({ modelID: "fixture-model" })
      expect(response.status).toBe(200)
      const result = (yield* response.json) as { status: string; detail?: string }

      // The whole defect in one assertion: the address is saved, so "no address saved" is a lie.
      expect(result.status).not.toBe("no-url")
      expect(result.status).toBe("unreachable")
    }),
  )

  it.instance(
    "still answers no-url when the provider genuinely has no address",
    Effect.gen(function* () {
      // The control. Without it this file would pass on a probe that never reports no-url at all,
      // which is a different bug wearing the same green.
      const saved = yield* request(
        "/config",
        json({ providers: { "probe-saved-urlless": { name: "No address", models: { m: { name: "m" } } } } }),
      )
      expect(saved.status).toBe(200)

      const response = yield* request("/provider/probe-saved-urlless/probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ modelID: "m" }),
      })
      const result = (yield* response.json) as { status: string; detail?: string }
      expect(result.status).toBe("no-url")
      // And it tells the user what to do about it, in their terms — this string is rendered verbatim
      // in Settings, so a regression to internal prose fails here.
      expect(result.detail ?? "").toContain("Add the server address")
    }),
  )
})
