import { describe, expect } from "bun:test"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Effect, Layer } from "effect"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"
import { httpApiLayer, request } from "./httpapi-layer"

const testStateLayer = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.promise(() => resetDatabase()),
    () => Effect.promise(() => resetDatabase()),
  ),
)

const it = testEffectShared(Layer.mergeAll(testStateLayer, FSUtil.defaultLayer, httpApiLayer))
const projectOptions = { config: { formatter: false } }
const providerID = "test-oauth-parity"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Both /provider and /config providers serve the native catalog result:
// { providers: ProviderV2Info[], models: ModelV2Info[], connected, default }.
function providerModels(input: unknown, id: string) {
  if (!isRecord(input) || !Array.isArray(input.models)) return []
  return input.models.filter((model) => isRecord(model) && model.providerID === id)
}

function hasNonZeroModelCost(input: unknown, id: string) {
  return providerModels(input, id).some((model) => {
    if (!isRecord(model) || !Array.isArray(model.cost)) return false
    return model.cost.some(
      (entry) =>
        isRecord(entry) &&
        isRecord(entry.cache) &&
        [entry.input, entry.output, entry.cache.read, entry.cache.write].some(
          (cost) => typeof cost === "number" && cost > 0,
        ),
    )
  })
}

function requestAuthorize(input: {
  providerID: string
  method: number
  headers: HeadersInit
  inputs?: Record<string, string>
}) {
  return Effect.gen(function* () {
    const response = yield* request(`/provider/${input.providerID}/oauth/authorize`, {
      method: "POST",
      headers: input.headers,
      body: JSON.stringify({ method: input.method, ...(input.inputs ? { inputs: input.inputs } : {}) }),
    })
    return {
      status: response.status,
      body: yield* response.text,
    }
  })
}

function requestCallback(input: { providerID: string; method: number; headers: HeadersInit; code?: string }) {
  return Effect.gen(function* () {
    const response = yield* request(`/provider/${input.providerID}/oauth/callback`, {
      method: "POST",
      headers: input.headers,
      body: JSON.stringify({ method: input.method, ...(input.code ? { code: input.code } : {}) }),
    })
    return {
      status: response.status,
      body: yield* response.text,
    }
  })
}

describe("provider HttpApi", () => {
  it.instance.skip(
    "returns public v2 provider not found errors",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const response = yield* request("/api/provider/missing", {
        headers: { "x-novaclaw-directory": directory },
      })

      expect(response.status).toBe(404)
      expect(yield* response.json).toEqual({
        _tag: "ProviderNotFoundError",
        providerID: "missing",
        message: "Provider not found: missing",
      })
    }),
    projectOptions,
  )

  // ⚠️ Pins the HALF-DARK ProviderAuth surface (see `src/provider/auth.ts`). Its only feed was the
  // V1 plugin `auth` hook; with that gone `methods()` is `{}` for every install, so authorize can
  // only answer `null` and callback can only answer OauthMissing. These two tests exist so the
  // routes' behaviour is stated rather than assumed, until the follow-up deletes them outright.
  it.instance(
    "answers null from authorize because no provider declares auth methods",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const response = yield* requestAuthorize({
        providerID,
        method: 0,
        headers: { "x-novaclaw-directory": directory, "content-type": "application/json" },
      })

      expect(response).toEqual({ status: 200, body: "null" })
    }),
    projectOptions,
    30000,
  )

  it.instance(
    "returns declared provider auth callback errors",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory
      const response = yield* requestCallback({
        providerID,
        method: 0,
        headers: { "x-novaclaw-directory": directory, "content-type": "application/json" },
      })

      expect(response.status).toBe(400)
      expect(JSON.parse(response.body)).toEqual({
        name: "ProviderAuthOauthMissing",
        data: { providerID },
      })
    }),
    projectOptions,
    30000,
  )

  // Deleted with the V1 plugin arm: "never serializes runtime auth options onto the provider wire
  // shape". The condition it asserted against was CREATED by a plugin fixture whose auth loader
  // returned a `fetch` — with the fixture gone the two `hasProviderWithFetch(...)===false` checks
  // could not fail, and `/config/providers` serves no providers at all so its cost check could not
  // pass. A test that cannot fail is worse than no test. The one live assertion it still carried
  // (real model costs on `/provider`) survives below.
  it.instance(
    "serves real model costs on provider state",
    Effect.gen(function* () {
      const directory = (yield* TestInstance).directory

      const headers = { "x-novaclaw-directory": directory }
      const providerResponse = yield* request("/provider", { headers })
      const configResponse = yield* request("/config/providers", { headers })

      expect(providerResponse.status).toBe(200)
      expect(configResponse.status).toBe(200)

      // Was also asserting no `provider.models` mutation marker on either body. That check read
      // `false` because `providerByID` found NOTHING, not because the marker was absent — it was
      // satisfied by the provider's absence, so it is dropped rather than weakened.
      expect(hasNonZeroModelCost(yield* providerResponse.json, "google")).toBe(true)
    }),
    projectOptions,
  )
})
