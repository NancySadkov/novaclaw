import type { ReferenceGitSource, ReferenceLocalSource } from "@novaclaw/sdk/v2/types"
import type { Effect, Scope } from "effect"
import type { Registration } from "./registration.js"
import type { Hooks } from "./registration.js"

export interface ReferenceDraft {
  add(name: string, source: ReferenceLocalSource | ReferenceGitSource): void
  remove(name: string): void
  list(): readonly (readonly [string, ReferenceLocalSource | ReferenceGitSource])[]
}

/**
 * A reference is a NAME bound to a whole source, not a record with patchable fields, so its
 * declaration is add-or-remove rather than `set`/`append`. Forcing it into the agent's shape would
 * invent a partial-source concept the domain does not have.
 */
export type ReferenceDeclaration =
  | { readonly name: string; readonly source: ReferenceLocalSource | ReferenceGitSource }
  | { readonly name: string; readonly remove: true }

export type ReferenceHooks = Hooks<{
  transform: ReferenceDraft
}> & {
  /** The marshallable form — see `declaration.ts`. */
  readonly declare: (
    items: readonly ReferenceDeclaration[],
  ) => Effect.Effect<Registration, never, Scope.Scope>
}
