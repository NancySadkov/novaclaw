import type { Effect, Scope } from "effect"
import type { Registration } from "./registration.js"

/**
 * 🔴 **The marshallable half of the plugin contract: a plugin says WHAT it contributes, as data.**
 *
 * The registration API is otherwise a mutation callback —
 * `ctx.agent.transform((draft) => draft.update(id, (agent) => { … }))` — and a closure cannot cross
 * a process boundary. That, and not the number of services a plugin can reach, is what forecloses
 * running a plugin host inside a sandbox: measured 2026-09-04, every external plugin in the tree is
 * exactly one such callback. A declaration is data, so the same contribution can arrive over a
 * transport from a confined process without the plugin being written differently.
 *
 * ⚠️ **A CLOSED op vocabulary, deliberately, and the reason is principle 13's** — *"it may name a
 * policy ID and may never carry a command… the closed vocabulary is the security property: an open
 * one is `permissionMode` in a config file with extra steps."* Three ops cover every use in the
 * tree, and a fourth is a decision somebody makes on purpose rather than a callback smuggling
 * arbitrary behaviour through a field.
 *
 * ⚠️ **`set` REPLACES and `append` EXTENDS, and the split exists because it is otherwise unknowable.**
 * A patch that merged arrays would let a plugin silently grow a permission list; one that replaced
 * them would let a plugin silently drop another's contribution. Saying which is which at the call
 * site is the only version a reader can check.
 */
export interface Declaration<T> {
  /** Which entity this is about. */
  readonly id: string
  /** Fields to REPLACE wholesale. Anything not named is untouched. */
  readonly set?: Partial<T>
  /** Array fields to EXTEND. Naming a non-array field here is a type error. */
  readonly append?: ArrayFields<T>
  /** Remove the entity. Exclusive with the other two: a removal that also patched would be a lie. */
  readonly remove?: true
}

/** The array-valued fields of `T`, each optional — the only fields `append` can name. */
export type ArrayFields<T> = {
  readonly [K in keyof T as T[K] extends readonly unknown[] | undefined ? K : never]?: T[K]
}

/**
 * The declarative counterpart of {@link Hooks}. One call, one data argument, no closure — which is
 * the whole property being bought.
 */
export type Declarative<T> = {
  /** Apply these declarations in order. Later ones win over earlier ones for the same field. */
  readonly declare: (items: readonly Declaration<T>[]) => Effect.Effect<Registration, never, Scope.Scope>
}
