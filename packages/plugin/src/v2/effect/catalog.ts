import type { ModelV2Info, ProviderV2Info } from "@novaclaw/sdk/v2/types"
import type { Effect, Scope } from "effect"
import type { ArrayFields } from "./declaration.js"
import type { Registration } from "./registration.js"
import type { Hooks } from "./registration.js"

export interface CatalogProviderRecord {
  readonly provider: ProviderV2Info
  readonly models: ReadonlyMap<string, ModelV2Info>
}

export interface CatalogDraft {
  readonly provider: {
    list(): readonly CatalogProviderRecord[]
    get(providerID: string): CatalogProviderRecord | undefined
    update(providerID: string, update: (provider: ProviderV2Info) => void): void
    remove(providerID: string): void
  }
  readonly model: {
    get(providerID: string, modelID: string): ModelV2Info | undefined
    update(providerID: string, modelID: string, update: (model: ModelV2Info) => void): void
    remove(providerID: string, modelID: string): void
    readonly default: {
      get(): { providerID: string; modelID: string } | undefined
      set(providerID: string, modelID: string): void
    }
  }
}

/**
 * 🔴 **The catalog is the one facet with a NESTED domain, so its declaration is a tagged union
 * rather than a copy of the agent's shape.**
 *
 * A model is identified by a pair — its provider AND its own id — and the default model is a
 * property of the catalog rather than of any record in it. Flattening those into one `id` field
 * would either lose the provider or invent a composite key that nothing else in the tree uses, and
 * a key only one module understands is the second source of truth this codebase keeps finding.
 *
 * The `kind` tag is the closed vocabulary: three shapes, each with its own required fields, and a
 * fourth is a decision somebody makes rather than a field quietly accepting more.
 */
export type CatalogDeclaration =
  | {
      readonly kind: "provider"
      readonly id: string
      readonly set?: Partial<ProviderV2Info>
      readonly append?: ArrayFields<ProviderV2Info>
      readonly remove?: true
    }
  | {
      readonly kind: "model"
      readonly provider: string
      readonly id: string
      readonly set?: Partial<ModelV2Info>
      readonly append?: ArrayFields<ModelV2Info>
      readonly remove?: true
    }
  /** The default is a property OF the catalog, not of a record in it — hence its own shape. */
  | { readonly kind: "default-model"; readonly provider: string; readonly id: string }

export type CatalogHooks = Hooks<{
  transform: CatalogDraft
}> & {
  /** The marshallable form — see `declaration.ts`. */
  readonly declare: (items: readonly CatalogDeclaration[]) => Effect.Effect<Registration, never, Scope.Scope>
}
