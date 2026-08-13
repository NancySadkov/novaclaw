export * as ProviderCapabilityStore from "./provider-capability-store"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "./effect/app-node"
import { ProviderCapability } from "./provider-capability"
import { SettingsConfigStore } from "./settings-config-store"

/**
 * WHAT WE MEASURED about an endpoint, remembered.
 *
 * `ProviderCapability` decides what an endpoint can do; this is where that answer survives the
 * request that produced it. Without it every verdict is per-probe: the Settings screen learns an
 * endpoint needs prompted tools, tells the user, and the very next turn goes out on the native
 * channel again because nothing wrote it down.
 *
 * ## Why `runtime_setting` and not the provider config
 *
 * 🔴 **A measurement and a user's choice must stay distinguishable**, and putting the verdict in
 * `providers.<id>.models.<m>` would merge them. A re-test would silently overwrite a deliberate
 * operator decision, and nobody reading the config afterwards could tell which lines they had
 * written and which the machine had. So the two live apart, with the precedence the self-healing law
 * asks for (AGENTS.md: *"defaults ship in code, but a store override always wins"*):
 *
 *     the protocol's native default  <  what we MEASURED (here)  <  what the OPERATOR set (config)
 *
 * ⚠️ It is durable rather than process-local, and the difference is behavioural. `ProbeWindow` is
 * deliberately runtime-only because its fact costs one GET to re-derive; this one costs three
 * completions, and — more importantly — a verdict that vanished on restart would make the same
 * instance drive the same endpoint differently before and after a reboot, with nothing on screen
 * that changed.
 *
 * ## Staleness
 *
 * Keyed on `ProviderCapability.fingerprint` — endpoint, model, protocol, TEMPLATE. A server reloaded
 * with a different chat template is the same URL and the same model name with a different tool
 * channel, so a key that ignored it would hand the runner a rung that no longer works. A fingerprint
 * that no longer matches is simply absent: no entry, no claim.
 */

const KEY = "provider_capability"

export interface Entry {
  readonly choice: ProviderCapability.Choice
  readonly rationale: string
  /** Epoch millis. Kept so a surface can say HOW OLD the answer is rather than implying it is fresh. */
  readonly measuredAt: number
}

export interface Interface {
  /** The recorded verdict for this fingerprint, or `undefined` when nothing was measured. */
  readonly get: (fingerprint: string) => Effect.Effect<Entry | undefined>
  readonly put: (fingerprint: string, entry: Entry) => Effect.Effect<void>
  /** Everything recorded, for a surface that lists what this instance knows. */
  readonly all: () => Effect.Effect<Record<string, Entry>>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/ProviderCapabilityStore") {}

const CHOICES: ReadonlySet<string> = new Set<ProviderCapability.Choice>(["native", "prompted", "chat-only", "unknown"])

/**
 * Read one stored value defensively.
 *
 * ⚠️ A row that does not decode is DROPPED, never repaired into a default. This store's whole
 * purpose is to say what was measured, and inventing `native` for a corrupt row would be a claim
 * nobody made — the runner would then take the native rung on the strength of a parse failure.
 */
const decode = (value: unknown): Entry | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const row = value as Record<string, unknown>
  if (typeof row["choice"] !== "string" || !CHOICES.has(row["choice"])) return undefined
  if (typeof row["measuredAt"] !== "number") return undefined
  return {
    choice: row["choice"] as ProviderCapability.Choice,
    rationale: typeof row["rationale"] === "string" ? row["rationale"] : "",
    measuredAt: row["measuredAt"],
  }
}

export const decodeAll = (stored: unknown): Record<string, Entry> => {
  if (typeof stored !== "object" || stored === null) return {}
  const out: Record<string, Entry> = {}
  for (const [fingerprint, value] of Object.entries(stored as Record<string, unknown>)) {
    const entry = decode(value)
    if (entry !== undefined) out[fingerprint] = entry
  }
  return out
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const settings = yield* SettingsConfigStore.Service

    const all = Effect.fn("ProviderCapabilityStore.all")(function* () {
      return decodeAll((yield* settings.all())[KEY])
    })

    return Service.of({
      all,
      get: Effect.fn("ProviderCapabilityStore.get")(function* (fingerprint: string) {
        return (yield* all())[fingerprint]
      }),
      put: Effect.fn("ProviderCapabilityStore.put")(function* (fingerprint: string, entry: Entry) {
        // Read-modify-write of the whole map. The map holds one row per model an instance has
        // probed — single digits — so a targeted update would buy nothing and cost a second shape
        // that has to agree with `decodeAll`.
        yield* settings.set(KEY, { ...(yield* all()), [fingerprint]: entry })
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [SettingsConfigStore.node] })
