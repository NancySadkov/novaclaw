import { describe, expect } from "bun:test"
import { FSUtil } from "@novaclaw/core/fs-util"
import { Effect, Layer } from "effect"
import { resetDatabase } from "../fixture/db"
import { TestInstance } from "../fixture/fixture"
import { pollWithTimeout, testEffectShared } from "../lib/effect"
import { httpApiLayer, request } from "./httpapi-layer"

const testStateLayer = Layer.effectDiscard(
  Effect.acquireRelease(
    Effect.promise(() => resetDatabase()),
    () => Effect.promise(() => resetDatabase()),
  ),
)

const it = testEffectShared(Layer.mergeAll(testStateLayer, FSUtil.defaultLayer, httpApiLayer))
const projectOptions = { config: { formatter: false } }

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

// ⚠️ The catalog is not ready the instant the instance is up — and the mechanism is NOT the one
// production code suggests. In the TEST process there is no network fetch and no
// `ModelsDev.Event.Refreshed`: `test/preload.ts:38` pins `NOVACLAW_MODELS_PATH` at
// `test/tool/fixtures/models-api.json`, `core/src/models-dev.ts:201` short-circuits `populate` on
// that flag, and `refresh()` returns at its `if (!source) return` — `NOVACLAW_MODELS_URL` is unset
// here — so it never reaches the `Refreshed` publish that `plugin/models-dev.ts:129-132` subscribes
// to. The catalog is built during PLUGIN INIT instead, from `modelsDev.get()` through
// `ModelsDevPlugin`'s `integration.transform`. So the race is instance/plugin init (including
// parsing the multi-MB fixture) against the first `/provider` request, not a round-trip.
//
// It used to pass by ACCIDENT: two ProviderAuth tests ran ahead of it with 30 s timeouts and gave
// init a head start. They were deleted with the V1 plugin arm. Measured 2026-07-30 standalone,
// 8 runs per arm: 4 pass / 4 fail at HEAD (7ff825752) AND 4 pass / 4 fail with an unrelated change
// — pre-existing, not a regression. It survives the full `--only=novaclaw:server` run because
// earlier suites already paid the init cost, which is the accident this replaces.
//
// Use the house `pollWithTimeout`, not a hand-rolled loop: its `Effect.timeoutOrElse` INTERRUPTS a
// hung request mid-flight, so the budget is real rather than merely re-checked between iterations,
// and exhaustion fails with a named message instead of an opaque runner timeout. ⚠️ The budget must
// stay well under the runner's per-test timeout (`script/test.ts` `PER_TEST_TIMEOUT_MS`) or it can
// never be reached — an earlier draft of this fix set 25 s against a 15 s timeout, which made the
// "never seeded" diagnostic unreachable by construction. The property under test is unchanged: a
// real, non-zero model cost must still reach the provider wire shape.
const CATALOG_DEADLINE = "8 seconds"

const providerStateWhenSeeded = (headers: Record<string, string>) =>
  pollWithTimeout(
    Effect.gen(function* () {
      const response = yield* request("/provider", { headers })
      // A 500 while init is in flight is a legitimate transient here — retry rather than fail.
      if (response.status !== 200) return undefined
      const body = yield* response.json
      return providerModels(body, "google").length > 0 ? { status: response.status, body } : undefined
    }),
    `the models.dev catalog never seeded — GET /provider served no "google" models within ${CATALOG_DEADLINE}`,
    CATALOG_DEADLINE,
  )

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
      const provider = yield* providerStateWhenSeeded(headers)
      const configResponse = yield* request("/config/providers", { headers })

      expect(provider.status).toBe(200)
      expect(configResponse.status).toBe(200)

      // No "did the seed land?" assertion here on purpose: `providerStateWhenSeeded` only returns
      // once `google` models are present and otherwise FAILS with its own named message, so an
      // unseeded catalog can no longer reach this line and read as "costs are zero".
      //
      // Was also asserting no `provider.models` mutation marker on either body. That check read
      // `false` because `providerByID` found NOTHING, not because the marker was absent — it was
      // satisfied by the provider's absence, so it is dropped rather than weakened.
      expect(hasNonZeroModelCost(provider.body, "google")).toBe(true)
    }),
    projectOptions,
  )
})
