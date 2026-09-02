import { createMemo, type Accessor } from "solid-js"
import type { SettledResource } from "@/utils/settled-resource"

/**
 * **The three-state list result: `loaded` / `empty` / `failed`, and the two states that are neither.**
 *
 * 🔴 Ruling 2: *an unavailable subsystem names itself instead of rendering empty.* Every viewer in
 * this app that renders a list has to answer the same question — *is there nothing, or did I not
 * find out?* — and until this type existed each one answered it in its own render expression, which
 * is why so many of them printed the same sentence on both branches. `trash.tsx` computed the
 * distinction and then discarded it, rendering `"Trash is empty."` whether the listing was empty or
 * had failed; four more pages folded a rejected list into `[]` and invited the user to add their
 * first item over data they already had.
 *
 * ⚠️ **Calendar's was the one with teeth.** *"No tasks yet — add one below"* over a schedule list
 * that failed to load is not merely wrong, it is an INVITATION: the schedules are still firing
 * server-side, and the screen is asking the user to create them again.
 *
 * **Five arms, because a list viewer really does have five things to say:**
 *
 * | kind | the screen says |
 * |---|---|
 * | `idle` | nothing has been asked yet (no connection, no folder) |
 * | `loading` | asking |
 * | `failed` | we asked and got no answer — **name the fault** |
 * | `empty` | we asked, and there is genuinely nothing |
 * | `loaded` | here it is |
 *
 * ⚠️ `idle` and `loading` are separate arms even though most viewers render them the same way. They
 * are different facts, and a viewer that wants to say *"pick a folder first"* needs to be able to;
 * collapsing them in the type would take that away from every future caller to save one line in the
 * present ones.
 */
export type ListState<T> =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "failed" }
  | { readonly kind: "empty" }
  | { readonly kind: "loaded"; readonly items: readonly T[] }

export interface ListStateInput<T> {
  readonly idle?: boolean
  readonly loading?: boolean
  readonly failed?: boolean
  readonly items?: readonly T[] | undefined
}

/**
 * The state machine itself, as a pure function so it can be exercised without a reactive root.
 *
 * Precedence — **failed > loading > idle > items** — and it matches `SettledResource.state`
 * deliberately, so the two helpers cannot come to disagree about what a screen is showing.
 *
 * ⚠️ **A settled read that produced `undefined` is `failed`, not `empty`.** A list fetcher that
 * answers reports `[]` for "there is nothing"; `undefined` at that point means the answer never
 * arrived, and calling it empty is the whole defect this file is named after. `[]` is the only
 * spelling of empty.
 */
export function listStateOf<T>(input: ListStateInput<T>): ListState<T> {
  if (input.failed) return { kind: "failed" }
  if (input.loading) return { kind: "loading" }
  if (input.idle) return { kind: "idle" }
  const items = input.items
  if (items === undefined) return { kind: "failed" }
  if (items.length === 0) return { kind: "empty" }
  return { kind: "loaded", items }
}

export interface ListStateOptions<T> {
  /**
   * The items to render, when they are a DERIVATION of the resource rather than the resource
   * itself — a filtered or grouped view. Defaults to the resource's own value.
   *
   * ⚠️ A viewer with a search box has two empties: *nothing exists* and *nothing matches*. Only the
   * second one belongs here; the first is a question about the unfiltered resource, and the viewer
   * still has to answer it in its own copy.
   */
  readonly items?: () => readonly T[] | undefined
  /**
   * An UPSTREAM failure this list should report as its own — a prerequisite read that answered with
   * a placeholder instead of rejecting (`answeredNothing`), or a sibling resource this one is keyed
   * on. Without it such a list sits at `idle` forever, showing a spinner nothing will ever resolve.
   */
  readonly failedWhen?: () => boolean
}

/** Bind a {@link ListState} to a {@link SettledResource}. */
export function createListState<T>(
  resource: SettledResource<readonly T[]>,
  options?: ListStateOptions<T>,
): Accessor<ListState<T>> {
  return createMemo(() =>
    listStateOf<T>({
      failed: resource.failed || (options?.failedWhen?.() ?? false),
      loading: resource.loading,
      idle: resource.idle,
      items: options?.items ? options.items() : resource(),
    }),
  )
}
