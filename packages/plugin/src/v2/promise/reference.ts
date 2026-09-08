import type { ReferenceDraft } from "../effect/reference.js"
import type { ReferenceDeclaration } from "../effect/reference.js"
import type { Declarative, Hooks } from "./registration.js"

export type { ReferenceDraft }

export type ReferenceHooks = Hooks<{
  transform: ReferenceDraft
}> &
  /** The marshallable form — see the effect SDK's `declaration.ts`. */
  Declarative<ReferenceDeclaration>
