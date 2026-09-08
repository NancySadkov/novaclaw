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
 * ## Staleness, and why the fingerprint is not the KEY
 *
 * 🔴 **The key is `providerID/modelID`; the fingerprint is a FIELD.** Keying on the fingerprint reads
 * better and is a trap: the writer (the probe handler, holding provider config) and the reader (model
 * resolution, holding a catalog model) derive it from different inputs, so they can disagree — and a
 * disagreement makes every lookup miss. That failure is SILENT and green: no entry means "not
 * measured", which falls back to the protocol default, which is exactly what the system did before
 * this store existed. Nothing would fail; the store would simply never be read.
 *
 * Both sides trivially agree on provider and model id, so the lookup cannot miss. Staleness then
 * becomes an explicit comparison of the stored fingerprint against the current one, which can only
 * ever be too conservative: a mismatch discards a measurement and re-measures, and the worst case is
 * the behaviour before the store.
 *
 * ⚠️ **`template` is part of `fingerprint`'s shape and NOTHING SUPPLIES IT TODAY.** A server reloaded
 * with a different chat template is the same URL, the same model name and possibly a different tool
 * channel — the case the field exists for — and it is currently NOT detected, because neither the
 * probe nor the resolver can see the template through an OpenAI-compatible endpoint. Said plainly
 * here rather than implied away: the protection is designed, not in force.
 */

const KEY = "provider_capability"

export interface Entry {
  readonly choice: ProviderCapability.Choice
  readonly rationale: string
  /** Epoch millis. Kept so a surface can say HOW OLD the answer is rather than implying it is fresh. */
  readonly measuredAt: number
  /** What the measurement was ABOUT (`ProviderCapability.fingerprint`). Compared, never keyed on. */
  readonly fingerprint: string
  /**
   * WHICH serving process answered, from the response's own `system_fingerprint`.
   *
   * Measured stable across calls to one server and different between two servers on the same vLLM
   * build, so it identifies a process rather than a build. A URL can stay identical while the thing
   * behind it is restarted or reloaded — the case `endpoint` cannot see and `template` was meant to.
   *
   * ⚠️ Recorded, not yet COMPARED automatically. The comparison needs the fingerprint of a live
   * turn, which only arrives on a response, and the runner discards its finish event today. Until
   * that hook exists this is provenance a person can read, not a staleness check.
   */
  readonly servedBy?: string
  /**
   * The endpoint the measurement was taken from, as its own field.
   *
   * ⚠️ It is already inside `fingerprint`, and duplicating it is deliberate: a SURFACE has to be
   * able to say *"this endpoint changed since it was tested"*, and the only alternative is parsing
   * the fingerprint — coupling a display to an opaque equality token whose format exists to be
   * compared, not read. The server keeps comparing fingerprints; the client compares a field it
   * understands.
   */
  readonly endpoint: string
}

/** The lookup key. Both sides know these two, so a lookup cannot miss for want of agreement. */
export const key = (providerID: string, modelID: string) => `${providerID}/${modelID}`

export interface Interface {
  /**
   * The recorded verdict for this model, or `undefined` when nothing was measured.
   *
   * `fingerprint` is what the CALLER believes it is asking about. A stored entry that does not match
   * it is discarded rather than returned: it was measured about a different endpoint, model,
   * protocol or template, and answering with it would be a claim about something else.
   */
  readonly get: (providerID: string, modelID: string, fingerprint: string) => Effect.Effect<Entry | undefined>
  readonly put: (providerID: string, modelID: string, entry: Entry) => Effect.Effect<void>
  /**
   * Discard this model's verdict if a live turn was served by a DIFFERENT process.
   *
   * 🔴 The case `endpoint` cannot see: a server restarted or reloaded under the same URL. Its tool
   * channel may have changed with its chat template, and a verdict measured before it is a claim
   * about a process that is gone. Discarding is the conservative direction — the model falls back to
   * the protocol default and Settings says "not tested", which is true.
   *
   * ⚠️ Only acts when BOTH identities are known and DIFFER. An endpoint that reports none, or a
   * verdict recorded before the field existed, must not be discarded on every turn — that would
   * re-measure forever and read as a probe that never sticks.
   */
  readonly forgetIfMoved: (providerID: string, modelID: string, servedBy: string) => Effect.Effect<boolean>
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
  // A row with no fingerprint cannot be checked for staleness, and a measurement we cannot place is
  // one we must not act on.
  if (typeof row["fingerprint"] !== "string") return undefined
  return {
    choice: row["choice"] as ProviderCapability.Choice,
    rationale: typeof row["rationale"] === "string" ? row["rationale"] : "",
    measuredAt: row["measuredAt"],
    fingerprint: row["fingerprint"],
    // Empty rather than dropped: a row written before this field existed is still a real
    // measurement, and losing it would re-measure every endpoint for a display detail.
    endpoint: typeof row["endpoint"] === "string" ? row["endpoint"] : "",
    ...(typeof row["servedBy"] === "string" && row["servedBy"].length > 0 ? { servedBy: row["servedBy"] } : {}),
  }
}

export const decodeAll = (stored: unknown): Record<string, Entry> => {
  if (typeof stored !== "object" || stored === null) return {}
  const out: Record<string, Entry> = {}
  for (const [rowKey, value] of Object.entries(stored as Record<string, unknown>)) {
    const entry = decode(value)
    if (entry !== undefined) out[rowKey] = entry
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

    /**
     * 🔴 The read and write stay inside the key/value store's BEGIN IMMEDIATE transaction. This is
     * cross-process safe, unlike the old in-process semaphore: isolated session workers can probe
     * different models without replacing one another's verdicts.
     */
    const mutate = (change: (stored: Record<string, Entry>) => Record<string, Entry> | undefined) => {
      let changed = false
      return settings
        .update(KEY, (raw) => {
          const next = change(decodeAll(raw))
          if (next === undefined) return raw
          changed = true
          return next
        })
        .pipe(Effect.map(() => changed))
    }

    return Service.of({
      all,
      get: Effect.fn("ProviderCapabilityStore.get")(function* (
        providerID: string,
        modelID: string,
        fingerprint: string,
      ) {
        const entry = (yield* all())[key(providerID, modelID)]
        return entry?.fingerprint === fingerprint ? entry : undefined
      }),
      forgetIfMoved: Effect.fn("ProviderCapabilityStore.forgetIfMoved")(function* (
        providerID: string,
        modelID: string,
        servedBy: string,
      ) {
        const rowKey = key(providerID, modelID)
        return yield* mutate((stored) => {
          const entry = stored[rowKey]
          // Unknown on either side is not evidence of a move. Equal is not a move either.
          if (entry?.servedBy === undefined || entry.servedBy === servedBy) return undefined
          const { [rowKey]: _dropped, ...rest } = stored
          return rest
        })
      }),
      put: Effect.fn("ProviderCapabilityStore.put")(function* (providerID: string, modelID: string, entry: Entry) {
        // The whole map is rewritten, not a targeted key: it holds one row per model an instance has
        // probed — single digits — so a partial write would buy nothing and cost a second shape that
        // has to agree with `decodeAll`. That was always a correct answer about SIZE and never one
        // about CONCURRENCY, which is what `mutate` is for.
        yield* mutate((stored) => ({ ...stored, [key(providerID, modelID)]: entry }))
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [SettingsConfigStore.node] })
