/**
 * THE DEVICE REGISTRY (v0.2.0 B2) — which endpoints are one model backend.
 *
 * AGENTS.md's organizing metaphor makes a Device the OS's CPU, and `session/scheduler.ts` is what
 * acts on that belief: its admission gate, its `MAX_BATCH` cap and its EEVDF fairness ledger are all
 * keyed on a `deviceKey`. So whatever that key GROUPS is what the OS thinks shares hardware, and
 * being wrong about it oversubscribes the exact box the gate exists to protect.
 *
 * App `e5c4e4ec6` fixed the first half derivably: the key became the model's normalized endpoint
 * ORIGIN, so several models served by ONE process stopped being several devices. The half that is
 * not derivable is several PROCESSES on one box — `:8010` (vLLM) and `:8011` (llama-server) are two
 * origins and one GPU. Nothing in a URL says so, and the tempting guess (same host ⇒ same machine)
 * is wrong behind any reverse proxy. So it is DECLARED, in a runtime-editable store behind
 * `PATCH /config` (`config/device.ts`), which is the self-healing law's own shape.
 *
 * ⚠️ **This module holds no policy — `SessionRunnerModel.deviceKeyFor` does.** That function is the
 * single override point the whole item is sequenced around: the session's declaration, this
 * registry's grouping and the derived origin all resolve there, in one function, never at a call
 * site. What lives here is the store read and the origin→device index it produces.
 *
 * Capacity and locality are declared on that same Device entry. They are not inferred from an
 * endpoint and they are not model capabilities: two endpoint processes can share one capacity.
 */
export * as DeviceRegistry from "./device-registry"

import { Context, Effect, Layer } from "effect"
import { Config } from "../config"
import type { ConfigDevice } from "../config/device"
import { makeLocationNode } from "../effect/app-node"

/** Normalized endpoint origin → the device id that claims it. */
export type EndpointMap = ReadonlyMap<string, string>

export const EMPTY_ENDPOINTS: EndpointMap = new Map()

export interface SchedulingProfile {
  readonly concurrency?: number
  readonly locality?: ConfigDevice.Locality
}

/**
 * The one normalization both sides of the comparison must agree on: `new URL(…).origin` collapses a
 * trailing slash, a `/v1` path and the scheme/host case, which are the three ways two entries for
 * one server differ in practice. `undefined` for anything unparsable — a bad registry entry is a
 * config defect, and refusing to schedule over one would be a worse defect than ignoring it.
 */
export const normalizeOrigin = (url: string): string | undefined => {
  try {
    return new URL(url).origin.toLowerCase()
  } catch {
    return undefined
  }
}

/**
 * Build the origin→device index from the `devices` config value. Pure, so the grouping algebra is
 * tested without a store.
 *
 * ⚠️ Device ids are walked in SORTED order and the first claim wins, so two entries listing the same
 * endpoint resolve deterministically instead of by object-key order. A collision is a config
 * mistake; answering it differently on two boots would turn one mistake into a scheduler that
 * regroups itself at random.
 */
export const endpointMap = (
  devices: Readonly<Record<string, { readonly endpoints: readonly string[] }>> | undefined,
): EndpointMap => {
  if (devices === undefined) return EMPTY_ENDPOINTS
  const map = new Map<string, string>()
  for (const id of Object.keys(devices).sort()) {
    for (const endpoint of devices[id]?.endpoints ?? []) {
      const origin = normalizeOrigin(endpoint)
      if (origin === undefined || map.has(origin)) continue
      map.set(origin, id)
    }
  }
  return map
}

export interface Interface {
  /**
   * The live origin→device index. Read THROUGH the settings store (ruling 3: "a settings change is
   * not a reboot"), memoized on the value's own signature so the per-turn hot path does not rebuild
   * an unchanged Map — see the layer for why that memo is the state this service is guarded on.
   */
  readonly endpoints: () => Effect.Effect<EndpointMap>
  /** Live scheduler-facing facts for a declared device id. */
  readonly profile: (deviceID: string) => Effect.Effect<SchedulingProfile | undefined>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/DeviceRegistry") {}

/**
 * ⚠️ **ONE module-scope layer object, and that is a correctness requirement rather than a style.**
 * Effect's `MemoMap` is keyed on layer OBJECT IDENTITY, and only `Layer.effect` is ever a key —
 * `provide`/`catchCause`/`unwrap` are pass-throughs. A service layer built as a FUNCTION of a
 * parameter therefore mints a fresh key per call, and every consumer that "shares" it gets its own
 * instance with its own state. That exact mistake cost this repo a day (two `:memory:` databases,
 * `Session.NotFoundError`, 11 red) and was invisible to 19 of its own tests plus a live smoke,
 * because each of them built ONE composition and so could not tell the two cases apart.
 * `device-registry.test.ts` pins it from three directions: same memo map ⇒ same object, state
 * written through one consumer is served to the other, and the CONTROL that separate memo maps must
 * NOT share.
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const config = yield* Config.Service
    // The memo. `Config.entries()` reads through the settings store on every call and returns fresh
    // objects, so a reference-keyed cache would never hit; the signature is the decoded VALUE, which
    // means a `PATCH /config` is picked up on the next turn while an unchanged registry costs one
    // stringify instead of a rebuilt Map. It is also the only mutable state this service owns, and
    // therefore the thing that makes a duplicated instance observable at all.
    let signature: string | undefined
    let map: EndpointMap = EMPTY_ENDPOINTS
    let entries: Readonly<Record<string, ConfigDevice.Info>> = {}
    const refresh = Effect.fnUntraced(function* () {
      const devices = Config.latest(yield* config.entries(), "devices")
      const next = devices === undefined ? "" : JSON.stringify(devices)
      if (next !== signature) {
        signature = next
        entries = devices ?? {}
        map = endpointMap(devices)
      }
    })
    return Service.of({
      endpoints: Effect.fn("DeviceRegistry.endpoints")(function* () {
        yield* refresh()
        return map
      }),
      profile: Effect.fn("DeviceRegistry.profile")(function* (deviceID) {
        yield* refresh()
        const entry = entries[deviceID]
        return entry === undefined ? undefined : { concurrency: entry.concurrency, locality: entry.locality }
      }),
    })
  }),
)

/** Test/embedding seam: a fixed index, with no config graph behind it. */
export const layerOf = (endpoints: EndpointMap, profiles: Readonly<Record<string, SchedulingProfile>> = {}) =>
  Layer.succeed(
    Service,
    Service.of({
      endpoints: () => Effect.succeed(endpoints),
      profile: (deviceID) => Effect.succeed(profiles[deviceID]),
    }),
  )

export const node = makeLocationNode({ service: Service, layer, deps: [Config.node] })
