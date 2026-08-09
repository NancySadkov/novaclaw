import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Schema } from "effect"
import { Config } from "@novaclaw/core/config"
import { ConfigDevice } from "@novaclaw/core/config/device"
import { DeviceRegistry } from "@novaclaw/core/session/device-registry"
import { it } from "./lib/effect"

// A Config layer whose `devices` value the test can rewrite between reads, mirroring the real
// service's read-THROUGH behaviour (`Config.entries()` hits the settings store on every call and
// returns fresh objects — ruling 3, "a settings change is not a reboot"). Returning a NEW array each
// time is the point: it is why the registry memoizes on the decoded VALUE rather than on a reference.
const configOf = (
  devices: () =>
    | Record<string, { endpoints: string[]; concurrency?: number; locality?: ConfigDevice.Locality }>
    | undefined,
) =>
  Layer.succeed(
    Config.Service,
    Config.Service.of({
      entries: () =>
        Effect.sync(() => {
          const value = devices()
          if (value === undefined) return []
          const decoded = Object.fromEntries(
            Object.entries(value).map(([id, entry]) => [id, new ConfigDevice.Info(entry)]),
          )
          return [new Config.Document({ type: "document", info: new Config.Info({ devices: decoded }) })]
        }),
    }),
  )

const registryIn = (config: Layer.Layer<Config.Service>) => DeviceRegistry.layer.pipe(Layer.provide(config))

describe("DeviceRegistry.endpointMap — the grouping algebra", () => {
  it.effect("device capacity is a positive integer and locality is closed-vocabulary", () =>
    Effect.sync(() => {
      const decode = Schema.decodeUnknownSync(ConfigDevice.Info)
      expect(decode({ endpoints: [], concurrency: 3, locality: "local" }).concurrency).toBe(3)
      expect(() => decode({ endpoints: [], concurrency: 0 })).toThrow()
      expect(() => decode({ endpoints: [], concurrency: 1.5 })).toThrow()
      expect(() => decode({ endpoints: [], locality: "nearby" })).toThrow()
    }),
  )

  it.effect("collapses several endpoint origins onto ONE device", () =>
    Effect.sync(() => {
      const map = DeviceRegistry.endpointMap({
        spark: { endpoints: ["http://192.168.178.40:8010", "http://192.168.178.40:8011"] },
      })
      expect(map.get("http://192.168.178.40:8010")).toBe("spark")
      expect(map.get("http://192.168.178.40:8011")).toBe("spark")
    }),
  )

  // The same three normalizations `deviceKeyFor` applies to a model's `api.url`. If the two sides
  // normalized differently, a registered endpoint would simply never match and the whole registry
  // would be silently inert — which is the failure mode this item exists to stop repeating.
  it.effect("normalizes a registered endpoint exactly as a model's url is normalized", () =>
    Effect.sync(() => {
      for (const written of [
        "http://192.168.178.40:8010/v1",
        "http://192.168.178.40:8010/v1/",
        "HTTP://192.168.178.40:8010/V1",
        "http://192.168.178.40:8010",
      ]) {
        const map = DeviceRegistry.endpointMap({ spark: { endpoints: [written] } })
        expect(map.get("http://192.168.178.40:8010")).toBe("spark")
      }
    }),
  )

  // The CONTROL: grouping must not become "everything is one device".
  it.effect("leaves an unregistered origin unclaimed", () =>
    Effect.sync(() => {
      const map = DeviceRegistry.endpointMap({ spark: { endpoints: ["http://192.168.178.40:8010"] } })
      expect(map.get("http://192.168.178.40:8011")).toBeUndefined()
      expect(map.get("https://api.openai.com")).toBeUndefined()
    }),
  )

  it.effect("ignores an unparsable endpoint instead of failing", () =>
    Effect.sync(() => {
      const map = DeviceRegistry.endpointMap({
        broken: { endpoints: ["not a url", "http://192.168.178.40:8010"] },
      })
      expect(map.size).toBe(1)
      expect(map.get("http://192.168.178.40:8010")).toBe("broken")
    }),
  )

  // A collision is a config mistake; answering it differently on two boots would turn one mistake
  // into a scheduler that regroups itself at random, so the lowest id wins by sorted walk.
  it.effect("resolves two devices claiming one endpoint deterministically", () =>
    Effect.sync(() => {
      const shared = "http://192.168.178.40:8010"
      const forward = DeviceRegistry.endpointMap({ alpha: { endpoints: [shared] }, beta: { endpoints: [shared] } })
      const reversed = DeviceRegistry.endpointMap({ beta: { endpoints: [shared] }, alpha: { endpoints: [shared] } })
      expect(forward.get(shared)).toBe("alpha")
      expect(reversed.get(shared)).toBe("alpha")
    }),
  )

  it.effect("an absent registry is an empty index, not a throw", () =>
    Effect.sync(() => {
      expect(DeviceRegistry.endpointMap(undefined).size).toBe(0)
      expect(DeviceRegistry.endpointMap({}).size).toBe(0)
    }),
  )
})

describe("DeviceRegistry reads through the settings store", () => {
  it.effect("serves a device declared in config", () =>
    Effect.gen(function* () {
      const registry = yield* DeviceRegistry.Service
      expect((yield* registry.endpoints()).get("http://192.168.178.40:8010")).toBe("spark")
    }).pipe(Effect.provide(registryIn(configOf(() => ({ spark: { endpoints: ["http://192.168.178.40:8010/v1"] } }))))),
  )

  it.effect("serves scheduling facts from the same live Device entry", () =>
    Effect.gen(function* () {
      const registry = yield* DeviceRegistry.Service
      expect(yield* registry.profile("spark")).toEqual({ concurrency: 6, locality: "lan" })
      expect(yield* registry.profile("missing")).toBeUndefined()
    }).pipe(
      Effect.provide(
        registryIn(
          configOf(() => ({
            spark: { endpoints: ["http://192.168.178.40:8010/v1"], concurrency: 6, locality: "lan" },
          })),
        ),
      ),
    ),
  )

  // Ruling 3: a `PATCH /config` must be live on the next turn. The memo below must not become a
  // freeze — this is the assertion that says the optimization did not eat the behaviour.
  it.effect("picks up a registry edit without a restart", () =>
    Effect.gen(function* () {
      let devices: Record<string, { endpoints: string[] }> = {}
      const registry = yield* Effect.provide(
        Effect.gen(function* () {
          return yield* DeviceRegistry.Service
        }),
        registryIn(configOf(() => devices)),
      )
      expect((yield* registry.endpoints()).get("http://192.168.178.40:8010")).toBeUndefined()
      devices = { spark: { endpoints: ["http://192.168.178.40:8010"] } }
      expect((yield* registry.endpoints()).get("http://192.168.178.40:8010")).toBe("spark")
    }).pipe(Effect.scoped),
  )
})

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 🔴 THE MEMO-MAP GUARD, and why a read-mostly service still gets one.
//
// Effect's `MemoMap` is keyed on layer OBJECT IDENTITY, and only `Layer.effect` is ever a key —
// `provide`/`catchCause`/`unwrap` are pass-throughs, never keys. So a service layer written as a
// FUNCTION of a parameter mints a fresh key per call and every consumer that believes it is sharing
// gets its own instance with its own state. That mistake cost this repo a day (two `:memory:`
// databases, `Session.NotFoundError`, 11 red) and was invisible to 19 of its own tests plus a live
// smoke — because every one of them built ONE composition, and one composition cannot tell the two
// cases apart.
//
// ⚠️ So the test builds TWO consumers and then, as the control, builds them under SEPARATE memo maps
// and requires the sharing to STOP. Without that arm the first two assertions are satisfied by any
// implementation at all.
//
// The observable is the memo: `endpoints()` returns the SAME `Map` object to a second consumer only
// if that consumer is the same service instance. Contents would be equal either way, which is
// exactly why the assertion is identity and not `toEqual`.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe("DeviceRegistry is ONE object per memo map", () => {
  const config = configOf(() => ({ spark: { endpoints: ["http://192.168.178.40:8010"] } }))

  /** Build the registry N times against one memo map and report each build's service + index. */
  const build = (memoMaps: readonly Layer.MemoMap[]) =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const built: { service: DeviceRegistry.Interface; map: DeviceRegistry.EndpointMap }[] = []
      for (const memoMap of memoMaps) {
        const context = yield* Layer.buildWithMemoMap(registryIn(config), memoMap, scope)
        const service = Context.get(context, DeviceRegistry.Service)
        built.push({ service, map: yield* service.endpoints() })
      }
      return built
    }).pipe(Effect.scoped)

  it.effect("two consumers in ONE memo map resolve to the same object", () =>
    Effect.gen(function* () {
      const memoMap = yield* Layer.makeMemoMap
      const [first, second] = yield* build([memoMap, memoMap])
      expect(first).toBeDefined()
      expect(second).toBeDefined()
      expect(Object.is(first!.service, second!.service)).toBe(true)
    }),
  )

  it.effect("state built through one consumer is served to the other", () =>
    Effect.gen(function* () {
      const memoMap = yield* Layer.makeMemoMap
      const [first, second] = yield* build([memoMap, memoMap])
      // The first read built the index; the second must be handed that very object, not an equal one.
      expect(Object.is(first!.map, second!.map)).toBe(true)
      expect(second!.map.get("http://192.168.178.40:8010")).toBe("spark")
    }),
  )

  // THE CONTROL. A guard that cannot be shown to bite is not a guard: separate memo maps are what a
  // per-call layer object produces, and both properties above must fail here.
  it.effect("separate memo maps must NOT share — the control", () =>
    Effect.gen(function* () {
      const [first, second] = yield* build([yield* Layer.makeMemoMap, yield* Layer.makeMemoMap])
      expect(Object.is(first!.service, second!.service)).toBe(false)
      expect(Object.is(first!.map, second!.map)).toBe(false)
      // …and the contents are identical, which is precisely why identity is the only discriminator
      // and why a behavioural test could never have caught the incident this guard is written for.
      expect([...second!.map]).toEqual([...first!.map])
    }),
  )
})
