export * as ModelRouteProfileStore from "./model-route-profile-store"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "../../effect/app-node"
import { SettingsConfigStore } from "../../settings-config-store"
import { PromptCalibration } from "./prompt-calibration"

export const SETTINGS_KEY = "provider_route_profile"

export interface Scope {
  readonly providerID: string
  /** The model identifier written onto the provider request, not a catalog alias. */
  readonly wireModelID: string
  /** Actual endpoint/base URL. A scheduled device name is not a serving identity. */
  readonly serverKey: string
  readonly routeID: string
  readonly protocolID: string
}

export interface Tunables {
  readonly imagePatchPixels?: number
  readonly prefixCacheRetentionTokens?: number
}

export interface Profile extends Tunables {
  readonly promptRatios: readonly number[]
  /** `reported / anchored-estimate` residuals; never substitute whole-request heuristic ratios. */
  readonly promptResidualRatios: readonly number[]
  /** Serving-process identity reported by the provider, when the wire exposes one. */
  readonly servedBy?: string
}

export interface ProfileUpdate extends Tunables {
  readonly promptRatios?: readonly number[]
  readonly promptResidualRatios?: readonly number[]
  readonly servedBy?: string
}

export interface Resolved extends Tunables {
  readonly promptFactor: number
  readonly promptResidualRatios: readonly number[]
  /** Current provider-reported serving process, when known. */
  readonly servedBy?: string
}

export interface ResolveInput {
  readonly declared?: Tunables
  readonly discovered?: Tunables
  readonly safeDefault?: Tunables
}

export interface Interface {
  readonly read: (scope: Scope) => Effect.Effect<Profile | undefined>
  readonly factor: (scope: Scope) => Effect.Effect<number>
  readonly observe: (
    scope: Scope,
    observation: PromptCalibration.Observation & { readonly anchoredEstimatedTokens?: number },
    servedBy?: string,
  ) => Effect.Effect<boolean>
  readonly put: (scope: Scope, profile: ProfileUpdate) => Effect.Effect<void>
  readonly resolve: (scope: Scope, input: ResolveInput) => Effect.Effect<Resolved>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/ModelRouteProfileStore") {}

/** Collision-free serialized identity for the exact provider wire route. */
export const normalizeServerKey = (serverKey: string): string =>
  serverKey.length > 1 ? serverKey.replace(/\/+$/, "") : serverKey

export const key = (scope: Scope): string =>
  JSON.stringify([
    scope.providerID,
    scope.wireModelID,
    normalizeServerKey(scope.serverKey),
    scope.routeID,
    scope.protocolID,
  ])

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

const positive = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined

const decode = (value: unknown): Profile | undefined => {
  const row = record(value)
  if (row === undefined) return undefined
  const promptRatios = Array.isArray(row["promptRatios"])
    ? PromptCalibration.retainNewest(row["promptRatios"].filter((value): value is number => typeof value === "number"))
    : []
  const promptResidualRatios = Array.isArray(row["promptResidualRatios"])
    ? PromptCalibration.retainNewest(
        row["promptResidualRatios"].filter((value): value is number => typeof value === "number"),
      )
    : []
  const imagePatchPixels = positive(row["imagePatchPixels"])
  const prefixCacheRetentionTokens = positive(row["prefixCacheRetentionTokens"])
  const servedBy =
    typeof row["servedBy"] === "string" && row["servedBy"].trim().length > 0 ? row["servedBy"] : undefined
  if (
    promptRatios.length === 0 &&
    promptResidualRatios.length === 0 &&
    imagePatchPixels === undefined &&
    prefixCacheRetentionTokens === undefined &&
    servedBy === undefined
  )
    return undefined
  return {
    promptRatios,
    promptResidualRatios,
    ...(imagePatchPixels === undefined ? {} : { imagePatchPixels }),
    ...(prefixCacheRetentionTokens === undefined ? {} : { prefixCacheRetentionTokens }),
    ...(servedBy === undefined ? {} : { servedBy }),
  }
}

export const decodeAll = (value: unknown): Record<string, Profile> => {
  const rows = record(value)
  if (rows === undefined) return {}
  const result: Record<string, Profile> = {}
  for (const [rowKey, value] of Object.entries(rows)) {
    const profile = decode(value)
    if (profile !== undefined) result[rowKey] = profile
  }
  return result
}

const firstPositive = (...values: readonly (number | undefined)[]): number | undefined => {
  for (const value of values) {
    const decoded = positive(value)
    if (decoded !== undefined) return decoded
  }
  return undefined
}

export const resolveProfile = (persisted: Profile | undefined, input: ResolveInput): Resolved => ({
  promptFactor: PromptCalibration.factorOf(persisted?.promptRatios ?? []),
  promptResidualRatios: persisted?.promptResidualRatios ?? [],
  ...(persisted?.servedBy === undefined ? {} : { servedBy: persisted.servedBy }),
  ...(() => {
    const imagePatchPixels = firstPositive(
      input.declared?.imagePatchPixels,
      input.discovered?.imagePatchPixels,
      persisted?.imagePatchPixels,
      input.safeDefault?.imagePatchPixels,
    )
    return imagePatchPixels === undefined ? {} : { imagePatchPixels }
  })(),
  ...(() => {
    const prefixCacheRetentionTokens = firstPositive(
      input.declared?.prefixCacheRetentionTokens,
      input.discovered?.prefixCacheRetentionTokens,
      persisted?.prefixCacheRetentionTokens,
      input.safeDefault?.prefixCacheRetentionTokens,
    )
    return prefixCacheRetentionTokens === undefined ? {} : { prefixCacheRetentionTokens }
  })(),
})

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const settings = yield* SettingsConfigStore.Service

    const all = Effect.fn("ModelRouteProfileStore.all")(function* () {
      return decodeAll((yield* settings.all())[SETTINGS_KEY])
    })
    const read = Effect.fn("ModelRouteProfileStore.read")(function* (scope: Scope) {
      return (yield* all())[key(scope)]
    })
    /**
     * 🔴 The read and write stay inside the key/value store's BEGIN IMMEDIATE transaction. This is
     * cross-process safe, unlike the old in-process semaphore: concurrent route calibrations cannot
     * replace one another's profiles.
     */
    const mutate = (scope: Scope, change: (current: Profile | undefined) => Profile | undefined) =>
      settings.update(SETTINGS_KEY, (raw) => {
        const stored = decodeAll(raw)
        const next = change(stored[key(scope)])
        if (next === undefined) return raw
        const normalized = decode(next)
        return normalized === undefined ? raw : { ...stored, [key(scope)]: normalized }
      })

    return Service.of({
      read,
      factor: Effect.fn("ModelRouteProfileStore.factor")(function* (scope: Scope) {
        return PromptCalibration.factorOf((yield* read(scope))?.promptRatios ?? [])
      }),
      observe: Effect.fn("ModelRouteProfileStore.observe")(
        (
          scope: Scope,
          observation: PromptCalibration.Observation & { readonly anchoredEstimatedTokens?: number },
          servedBy?: string,
        ) =>
          Effect.gen(function* () {
            const ratio = PromptCalibration.observationRatio(observation)
            const residualRatio =
              observation.anchoredEstimatedTokens === undefined
                ? undefined
                : PromptCalibration.observationRatio({
                    estimatedTokens: observation.anchoredEstimatedTokens,
                    reportedTokens: observation.reportedTokens,
                  })
            if (ratio === undefined) return false
            const liveServedBy = servedBy !== undefined && servedBy.trim().length > 0 ? servedBy : undefined
            yield* mutate(scope, (current) => {
              const moved =
                current?.servedBy !== undefined && liveServedBy !== undefined && current.servedBy !== liveServedBy
              const base = moved ? undefined : current
              return {
                ...base,
                promptRatios: PromptCalibration.retainNewest([...(base?.promptRatios ?? []), ratio]),
                promptResidualRatios:
                  residualRatio === undefined
                    ? (base?.promptResidualRatios ?? [])
                    : PromptCalibration.retainNewest([...(base?.promptResidualRatios ?? []), residualRatio]),
                ...(liveServedBy === undefined ? {} : { servedBy: liveServedBy }),
              }
            })
            return true
          }),
      ),
      put: Effect.fn("ModelRouteProfileStore.put")((scope: Scope, update: ProfileUpdate) => {
        const liveServedBy =
          update.servedBy !== undefined && update.servedBy.trim().length > 0 ? update.servedBy : undefined
        return mutate(scope, (current) => {
          const moved =
            current?.servedBy !== undefined && liveServedBy !== undefined && current.servedBy !== liveServedBy
          // A route key identifies the address and wire, not the process currently behind it. A
          // discovery made after a same-URL restart must not preserve the predecessor's tokenizer,
          // image, or prefix-retention measurements. `observe` applies the same boundary to prompt
          // ratios; `put` is the path used by non-prompt discoveries.
          const base = moved ? undefined : current
          return {
            ...base,
            ...(positive(update.imagePatchPixels) === undefined ? {} : { imagePatchPixels: update.imagePatchPixels }),
            ...(positive(update.prefixCacheRetentionTokens) === undefined
              ? {}
              : { prefixCacheRetentionTokens: update.prefixCacheRetentionTokens }),
            ...(liveServedBy === undefined ? {} : { servedBy: liveServedBy }),
            promptRatios:
              update.promptRatios === undefined
                ? (base?.promptRatios ?? [])
                : PromptCalibration.retainNewest(update.promptRatios),
            promptResidualRatios:
              update.promptResidualRatios === undefined
                ? (base?.promptResidualRatios ?? [])
                : PromptCalibration.retainNewest(update.promptResidualRatios),
          }
        })
      }),
      resolve: Effect.fn("ModelRouteProfileStore.resolve")(function* (scope: Scope, input: ResolveInput) {
        return resolveProfile(yield* read(scope), input)
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [SettingsConfigStore.node] })
