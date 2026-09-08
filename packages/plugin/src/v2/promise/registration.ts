export interface Registration {
  readonly dispose: () => Promise<void>
}

export interface Reload {
  readonly reload: () => Promise<void>
}

export type Hooks<Spec> = {
  readonly [Name in keyof Spec]: (callback: (input: Spec[Name]) => Promise<void> | void) => Promise<Registration>
}

/**
 * The promise-shaped counterpart of the effect SDK's `Declarative`. Generic over the ITEM rather
 * than the entity, because the five contributable facets do not share one declaration shape: an
 * entity with patchable fields, a name bound to a whole source, and an append-only list are three
 * different domains, and a single generic would have flattened them into a lie.
 */
export type Declarative<Item> = {
  readonly declare: (items: readonly Item[]) => Promise<Registration>
}
