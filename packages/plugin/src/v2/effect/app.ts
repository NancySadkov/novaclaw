import type { Effect, Scope } from "effect"
import type { Registration } from "./registration.js"

export type AppOpen =
  | { readonly type: "route"; readonly value: string }
  | { readonly type: "url"; readonly value: string }
  | { readonly type: "prompt"; readonly value: string }

/** The renderer-safe, persistent launcher descriptor a plugin may contribute. */
export interface AppDeclaration {
  readonly id?: string
  readonly title: string
  readonly icon?: string
  readonly accent?: string
  readonly subtitle?: string
  readonly open: AppOpen
}

export interface AppHooks {
  readonly declare: (items: readonly AppDeclaration[]) => Effect.Effect<Registration, never, Scope.Scope>
}
