import { describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { SettingsConfigStore } from "../../settings-config-store"
import { SETTINGS_KEY, Service, decodeAll, key, layer, resolveProfile, type Scope } from "./model-route-profile-store"

const scope = (overrides: Partial<Scope> = {}): Scope => ({
  providerID: "local",
  wireModelID: "model",
  serverKey: "http://127.0.0.1:8000/v1",
  routeID: "openai-chat",
  protocolID: "openai",
  ...overrides,
})

const memorySettings = (values: Record<string, unknown>) =>
  Layer.succeed(
    SettingsConfigStore.Service,
    SettingsConfigStore.Service.of({
      all: () => Effect.succeed({ ...values }),
      set: (setting, value) => Effect.sync(() => void (values[setting] = value)),
      remove: (setting) => Effect.sync(() => void delete values[setting]),
      serverPassword: () => Effect.succeed(undefined),
      unreadable: () => Effect.succeed([]),
      isEmpty: () => Effect.succeed(Object.keys(values).length === 0),
    }),
  )

const run = <A>(values: Record<string, unknown>, effect: Effect.Effect<A, never, Service>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer.pipe(Layer.provide(memorySettings(values))))))

describe("model route profile decoding", () => {
  test("salvages valid fields, rejects poisoned values, and retains the newest eight usable ratios", () => {
    const ratios = [1.01, 0, 1.02, Number.NaN, 1.03, 1.04, 1.05, 1.06, 1.07, 1.08, 1.09]
    const decoded = decodeAll({
      valid: {
        promptRatios: ratios,
        imagePatchPixels: 1024,
        prefixCacheRetentionTokens: -1,
      },
      empty: { promptRatios: [0, Number.POSITIVE_INFINITY], imagePatchPixels: "1024" },
      array: [],
    })

    expect(decoded).toEqual({
      valid: {
        promptRatios: [1.02, 1.03, 1.04, 1.05, 1.06, 1.07, 1.08, 1.09],
        imagePatchPixels: 1024,
      },
    })
  })

  test("the key cannot alias slashes and includes every exact wire-route identity", () => {
    expect(key(scope({ providerID: "a/b", wireModelID: "c" }))).not.toBe(
      key(scope({ providerID: "a", wireModelID: "b/c" })),
    )
    for (const changed of [
      scope({ providerID: "other" }),
      scope({ wireModelID: "other" }),
      scope({ serverKey: "http://other/v1" }),
      scope({ routeID: "responses" }),
      scope({ protocolID: "ollama" }),
    ]) {
      expect(key(changed)).not.toBe(key(scope()))
    }
  })

  test("normalizes equivalent endpoint trailing slashes without merging different endpoints", () => {
    expect(key(scope({ serverKey: "http://host/v1/" }))).toBe(key(scope({ serverKey: "http://host/v1" })))
    expect(key(scope({ serverKey: "http://host/v1///" }))).toBe(key(scope({ serverKey: "http://host/v1" })))
    expect(key(scope({ serverKey: "http://host/v2" }))).not.toBe(key(scope({ serverKey: "http://host/v1" })))
  })
})

describe("model route profile persistence", () => {
  test("observations survive through SettingsConfigStore and stay bounded per exact scope", async () => {
    const values: Record<string, unknown> = {}
    const route = scope()
    await run(
      values,
      Effect.gen(function* () {
        const store = yield* Service
        for (let ratio = 1; ratio <= 9; ratio++)
          yield* store.observe(route, { estimatedTokens: 100, reportedTokens: 100 + ratio })
        yield* store.put(route, { imagePatchPixels: 1024, prefixCacheRetentionTokens: 4096 })
      }),
    )

    const persisted = (values[SETTINGS_KEY] as Record<string, unknown>)[key(route)]
    expect(persisted).toEqual({
      promptRatios: [1.02, 1.03, 1.04, 1.05, 1.06, 1.07, 1.08, 1.09],
      imagePatchPixels: 1024,
      prefixCacheRetentionTokens: 4096,
    })
    await run(
      values,
      Effect.gen(function* () {
        const store = yield* Service
        expect((yield* store.read(route))?.promptRatios).toHaveLength(8)
        expect(yield* store.factor(route)).toBeCloseTo(1.055)
        expect(yield* store.read(scope({ serverKey: "http://other/v1" }))).toBeUndefined()
      }),
    )
  })

  test("invalid observations do not write or displace usable samples", async () => {
    const values: Record<string, unknown> = {}
    await run(
      values,
      Effect.gen(function* () {
        const store = yield* Service
        expect(yield* store.observe(scope(), { estimatedTokens: 0, reportedTokens: 5 })).toBe(false)
        expect(
          yield* store.observe(scope(), { estimatedTokens: Number.MIN_VALUE, reportedTokens: Number.MAX_VALUE }),
        ).toBe(false)
        expect(yield* store.read(scope())).toBeUndefined()
      }),
    )
    expect(values).toEqual({})
  })

  test("serializes concurrent observations so read-modify-write cannot lose the window", async () => {
    const values: Record<string, unknown> = {}
    await run(
      values,
      Effect.gen(function* () {
        const store = yield* Service
        yield* Effect.all(
          Array.from({ length: 20 }, () => store.observe(scope(), { estimatedTokens: 100, reportedTokens: 110 })),
          { concurrency: "unbounded" },
        )
        expect((yield* store.read(scope()))?.promptRatios).toEqual(Array.from({ length: 8 }, () => 1.1))
      }),
    )
  })

  test("same-URL serving-process changes discard the stale profile before learning again", async () => {
    const values: Record<string, unknown> = {}
    await run(
      values,
      Effect.gen(function* () {
        const store = yield* Service
        yield* store.put(scope(), {
          promptRatios: [1.2, 1.2],
          imagePatchPixels: 1024,
          prefixCacheRetentionTokens: 4096,
          servedBy: "process-a",
        })

        yield* store.observe(
          scope({ serverKey: "http://127.0.0.1:8000/v1/" }),
          { estimatedTokens: 100, reportedTokens: 110 },
          "process-a",
        )
        expect((yield* store.read(scope()))?.promptRatios).toEqual([1.2, 1.2, 1.1])

        yield* store.observe(scope(), { estimatedTokens: 100, reportedTokens: 105 })
        expect((yield* store.read(scope()))?.promptRatios).toEqual([1.2, 1.2, 1.1, 1.05])

        yield* store.observe(scope(), { estimatedTokens: 100, reportedTokens: 115 }, "process-b")
        expect(yield* store.read(scope())).toEqual({ promptRatios: [1.15], servedBy: "process-b" })
      }),
    )
  })
})

describe("profile precedence", () => {
  test("resolves each property as declared, discovered, persisted, then safe default", () => {
    const persisted = {
      promptRatios: [1.1],
      imagePatchPixels: 900,
      prefixCacheRetentionTokens: 3_000,
      servedBy: "process-a",
    }
    expect(
      resolveProfile(persisted, {
        declared: { imagePatchPixels: 400 },
        discovered: { imagePatchPixels: 500, prefixCacheRetentionTokens: 2_000 },
        safeDefault: { imagePatchPixels: 1024, prefixCacheRetentionTokens: 1_000 },
      }),
    ).toEqual({
      promptFactor: 1.1,
      imagePatchPixels: 400,
      prefixCacheRetentionTokens: 2_000,
      servedBy: "process-a",
    })
    expect(resolveProfile(persisted, { safeDefault: { imagePatchPixels: 1024 } }).imagePatchPixels).toBe(900)
    expect(resolveProfile(undefined, { safeDefault: { imagePatchPixels: 1024 } }).imagePatchPixels).toBe(1024)
  })

  test("invalid higher-precedence values cannot mask a usable lower-precedence source", () => {
    expect(
      resolveProfile(
        { promptRatios: [], imagePatchPixels: 768 },
        { declared: { imagePatchPixels: Number.NaN }, discovered: { imagePatchPixels: -1 } },
      ).imagePatchPixels,
    ).toBe(768)
  })
})
