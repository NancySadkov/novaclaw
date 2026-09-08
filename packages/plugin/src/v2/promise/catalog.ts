import type { CatalogDraft, CatalogProviderRecord } from "../effect/catalog.js"
import type { CatalogDeclaration } from "../effect/catalog.js"
import type { Declarative, Hooks } from "./registration.js"

export type { CatalogDraft, CatalogProviderRecord }

export type CatalogHooks = Hooks<{
  transform: CatalogDraft
}> &
  /** The marshallable form — see the effect SDK's `declaration.ts`. */
  Declarative<CatalogDeclaration>
