import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Config as ConfigV2 } from "@novaclaw/core/config"
import { Database } from "@novaclaw/core/database/database"

import { UNKNOWN_CONFIG_KEY_KIND, unknownConfigKeys } from "../../src/server/routes/instance/httpapi/groups/config"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, TestInstance } from "../fixture/fixture"
import { testEffectShared } from "../lib/effect"
import { httpApiLayer, request, requestInDirectory } from "./httpapi-layer"

/**
 * **`PATCH /config` must not answer 200 for a key it silently threw away.**
 *
 * The payload decodes with Effect Schema's default `onExcessProperty: "ignore"`, so an undeclared
 * top-level key was erased before any handler or store could see it — `provider_preset` (the
 * singular typo for `provider_presets`) got **200 and no write**. That is todo.md ruling 2 (*a
 * failed mutation never reports success*) broken on the exact surface AGENTS.md's self-healing law
 * depends on: an agent that PATCHes, is told 200, re-reads and finds nothing cannot distinguish "I
 * typed the wrong key" from "this instance is broken", so it loops instead of repairing.
 *
 * This file is the mechanical half of the fix (ruling 1). It asserts three separable things, because
 * any one of them alone would pass while the bug shipped:
 *  1. the wire REFUSES, with a 400 that NAMES the offending key on both config PATCH routes;
 *  2. a valid patch is untouched — still 200, still stored, `$schema` still rides through so the
 *     product's own Export → Import round trip keeps working;
 *  3. an unknown key is DISTINGUISHABLE from a malformed known one, so a client knows whether to
 *     drop keys or fix a value.
 *
 * ⚠️ Its negative controls are in `describe("the guard actually bites")` at the bottom and are not
 * decoration: the decode measurement there is what proves the guard — and not the schema — is doing
 * the rejecting. If that test ever starts failing because the decode began rejecting on its own,
 * this whole file is testing a path that no longer exists.
 */

const it = testEffectShared(Layer.mergeAll(Database.defaultLayer, httpApiLayer))

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

const json = (body: unknown) => ({
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
})

describe("PATCH /config refuses an unknown top-level key", () => {
  it.instance(
    "instance route: 400 that names the key, and the write that travelled with it did NOT land",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance

        const res = yield* requestInDirectory(
          "/config",
          test.directory,
          // `provider_preset` is the real-world case: the singular typo for the declared
          // `provider_presets`. It rides along with a perfectly VALID key, which is what makes the
          // old behaviour so bad — the caller saw 200 and half a write.
          json({ username: "must-not-land", provider_preset: { spark: { baseURL: "http://x" } } }),
        )
        const body: Record<string, unknown> = JSON.parse(yield* res.text)

        expect(res.status).toBe(400)
        expect(body._tag).toBe("InvalidRequestError")
        expect(body.kind).toBe(UNKNOWN_CONFIG_KEY_KIND)
        expect(body.field).toBe("provider_preset")
        // NAMED, not merely refused: "invalid request" leaves the agent in exactly the loop this
        // exists to break.
        expect(body.message).toContain("provider_preset")

        // …and it is a refusal, not a partial apply. `username` is a routed settings key, so if the
        // guard ran after the write (or not at all) this would come back patched under a reported
        // failure — ruling 2's problem in the mirror.
        const after = yield* requestInDirectory("/config", test.directory)
        expect(after.status).toBe(200)
        const stored: { username?: string } = JSON.parse(yield* after.text)
        expect(stored.username).not.toBe("must-not-land")
      }),
    { git: true, config: { formatter: false } },
  )

  it.instance(
    "global route: the one the UI and Settings → Import actually call, same 400",
    () =>
      Effect.gen(function* () {
        // `serverSync().updateConfig` — and therefore every Settings toggle and the Import button —
        // goes to `global.config.update`, not the instance route. A guard on only one of the two
        // would leave the product's own write path silently dropping keys.
        const res = yield* request(GlobalPaths.config, json({ shell: "bash", totally_unknown_key: 1 }))
        const body: Record<string, unknown> = JSON.parse(yield* res.text)

        expect(res.status).toBe(400)
        expect(body._tag).toBe("InvalidRequestError")
        expect(body.kind).toBe(UNKNOWN_CONFIG_KEY_KIND)
        expect(body.message).toContain("totally_unknown_key")
      }),
    { git: true, config: { formatter: false } },
  )

  it.instance(
    "a valid patch still succeeds unchanged — including `$schema`, which Export stamps and Import sends back",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance

        const res = yield* requestInDirectory(
          "/config",
          test.directory,
          // `$schema` is a DECLARED `Config.Info` key that deliberately routes to no store
          // (`ConfigStoreWrite.NOT_ROUTED_KEYS`). It must keep riding through: Settings → Export
          // writes one into every document and Import PATCHes that document straight back, so a
          // guard that refused it would break the product's own round trip.
          json({ $schema: "https://novaclaw.app/config.json", username: "patched-user", formatter: false }),
        )
        const body: Record<string, unknown> = JSON.parse(yield* res.text)

        expect(res.status).toBe(200)
        // The response is built from the STORES, not echoed from the request — so this is evidence
        // the write landed, not evidence it was received.
        expect(body).toMatchObject({ username: "patched-user", formatter: false })
      }),
    { git: true, config: { formatter: false } },
  )

  it.instance(
    "a malformed KNOWN key is a different 400 — the client can tell 'drop these keys' from 'fix this value'",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance

        // `shell` is declared and takes a string. A number is a payload-schema rejection, handled by
        // `ExperimentalSchemaErrorMiddleware` — a completely different arm from the guard above.
        const res = yield* requestInDirectory("/config", test.directory, json({ shell: 42 }))
        const body: Record<string, unknown> = JSON.parse(yield* res.text)

        expect(res.status).toBe(400)
        // Forward compatibility rests on this being decidable: a newer client that gets
        // `unknown-config-key` can retry without those keys, while a malformed value must never be
        // retried that way. If both faults ever collapse to one kind, that retry becomes a guess.
        expect(body.kind).not.toBe(UNKNOWN_CONFIG_KEY_KIND)
        expect(JSON.stringify(body)).not.toContain(UNKNOWN_CONFIG_KEY_KIND)
      }),
    { git: true, config: { formatter: false } },
  )
})

describe("the guard actually bites (negative control)", () => {
  test("the payload schema STILL ignores excess — the guard is what rejects, not the decode", () => {
    // The measurement the whole fix rests on (2026-07-29). If this ever stops holding, the guard has
    // become dead code and the tests above would pass for the wrong reason.
    const decoded = Schema.decodeUnknownSync(ConfigV2.Info)({ shell: "bash", totally_unknown_key: 1 })
    expect(Object.keys(decoded)).toEqual(["shell"])
  })

  test("the predicate names the offender and stays silent on everything legitimate", () => {
    // The HTTP tests assert an EMPTY offender list in the happy cases, which alone cannot show a
    // non-empty one is reachable, and a 400 in the sad case, which alone cannot show a valid patch
    // is untouched. Exercise the predicate directly in both directions.
    expect(unknownConfigKeys({ shell: "bash", provider_presets: {} })).toEqual([])
    expect(unknownConfigKeys({ shell: "bash", provider_preset: {} })).toEqual(["provider_preset"])
    expect(unknownConfigKeys({ alpha: 1, beta: 2 }).sort()).toEqual(["alpha", "beta"])
    // `$schema` is declared, so the guard is silent about it — the round trip is protected by the
    // schema, not by a special case that could rot.
    expect(unknownConfigKeys({ $schema: "https://novaclaw.app/config.json" })).toEqual([])
    // A non-object body is the payload decoder's fault to describe; answering "unknown key" for it
    // would be a false description of the fault (ruling 2, fourth clause).
    expect(unknownConfigKeys([1, 2])).toEqual([])
    expect(unknownConfigKeys("nope")).toEqual([])
    expect(unknownConfigKeys(null)).toEqual([])
    expect(unknownConfigKeys(undefined)).toEqual([])
  })

  test("the key set it checks against is the real schema, and it is not empty", () => {
    // Two ways this guard could become a no-op or a wall without any test noticing: an EMPTY set
    // (every key unknown — the wire rejects everything) or a set that stopped being read off
    // `Config.Info` (nothing unknown). Pin the size the way config-routing-ledger.test.ts does, and
    // assert every declared key passes.
    const declared = Object.keys(ConfigV2.Info.fields)
    expect(declared.length).toBeGreaterThan(30)
    expect(declared).toContain("provider_presets")
    expect(unknownConfigKeys(Object.fromEntries(declared.map((key) => [key, undefined])))).toEqual([])
  })
})
