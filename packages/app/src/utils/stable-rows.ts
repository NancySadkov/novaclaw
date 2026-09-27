import { createMemo, type Accessor } from "solid-js"

/**
 * 🔴 **A polled row's identity must be a durable fact, not the object the poll happened to return.**
 *
 * Owner, 2026-09-27: *"when user clicks the workers icon in the chat screen, and tries to enter reason
 * for stopping a worker, something keeps stealing the input focus, apparently as the agent generates
 * in the background."*
 *
 * The chain, each link read out of the library rather than guessed:
 *
 * 1. `context/workers.ts` polls `GET /api/session/:id/worker` every 2 s.
 * 2. `@tanstack/solid-query` sets `defaultOptions.structuralSharing = false`
 *    (`useBaseQuery.ts`) — deliberately, because it reconciles through a Solid store instead. So each
 *    refetch hands back a **brand-new array of brand-new objects**, even when nothing changed.
 * 3. `<For>` is `mapArray`, and `mapArray` reuses a row only where `items[i] === newItems[i]`
 *    (`solid-js/dist/solid.js`). Reference equality, nothing else.
 * 4. So **every row is destroyed and recreated every two seconds**, unconditionally.
 * 5. The stop-reason `<textarea autofocus>` lives inside a row (`worker-list-dialog.tsx`). Recreating
 *    it drops focus and caret — and the fresh `autofocus` takes it straight back, so the next
 *    keystrokes land in a field the user is looking away from. The typed text survives, because it
 *    lives in the dialog's own signal; the *typing* does not.
 *
 * ⭐ **This is not a bug in one dialog.** It is a class: any list fed straight from a poll, whose rows
 * hold something live (an input, a selection, a scroll position, a playing animation), loses it every
 * tick. `shell-list-dialog.tsx` is the same shape with the same `autofocus`; the All Officers page is
 * worse, because it maps to fresh objects inside a `createMemo` and so churns every row on any change
 * to any worker.
 *
 * **The fix is to give the row a name.** `project` narrows each poll row to the fields the row
 * actually renders, and the item handed back is the PREVIOUS object when those fields are unchanged —
 * so `mapArray` sees a stable reference and keeps the DOM. A field the row never renders (`state` on
 * a worker row) therefore cannot churn the row, which is the second half of the same defect: identity
 * taken from a value the row does not show.
 */
export interface StableRowsOptions<T> {
  /** The row's own name — a session id, a job id. Two polls with the same key are the same row. */
  readonly key: (item: T) => string
  /**
   * The fields the row RENDERS, as a comparable value. Identity is decided by this and nothing else,
   * so a field the row does not show can never rebuild it.
   */
  readonly fields: (item: T) => unknown
  /** Narrow a poll row to what the row needs. Returning a fresh object here is the point. */
  readonly project: (item: T) => T
}

/** What {@link stableRowsOf} remembers about one row between polls. */
export type SeenRows<T> = Map<string, { readonly fields: unknown; readonly item: T }>

/**
 * The whole decision, as a pure function over (what we remembered, what the poll said).
 *
 * ⚠️ Pure and separate from the memo on purpose. `packages/app`'s fast unit tier resolves `solid-js`
 * through its **server** build (`test:unit` runs with no `--conditions=browser`), where reactivity is
 * inert — a memo evaluated there returns its first value forever. So the part worth unit-testing
 * cannot be the part that needs a reactive root; the memo below is three lines over this one.
 */
export function stableRowsOf<T>(seen: SeenRows<T>, rows: readonly T[], options: StableRowsOptions<T>): readonly T[] {
  const next: T[] = []
  for (const row of rows) {
    const key = options.key(row)
    const fields = options.fields(row)
    const previous = seen.get(key)
    // ⚠️ Reuse the whole previous item, not a re-projection of this one: the row's DOM is bound to
    // the object it was created from, so handing back a twin would rebuild it for no reason.
    const item =
      previous !== undefined && sameFields(previous.fields, fields) ? previous.item : options.project(row)
    seen.set(key, { fields, item })
    next.push(item)
  }
  // Forget the rows that left, or a long-lived dialog's map grows with every worker it ever saw.
  if (seen.size > next.length) {
    const live = new Set(next.map((item) => options.key(item)))
    for (const key of seen.keys()) if (!live.has(key)) seen.delete(key)
  }
  return next
}

/**
 * A poll-shaped list whose rows keep their identity while they keep their content.
 *
 * ⚠️ **The memo is load-bearing, not an optimisation.** Identity is compared by reference, so the
 * comparison has to happen inside a memo that re-runs only when the source does; recomputing it in
 * the render body would hand `<For>` a fresh array on every read and be worse than doing nothing.
 */
export function stableRows<T>(
  source: Accessor<readonly T[] | undefined>,
  options: StableRowsOptions<T>,
): Accessor<readonly T[]> {
  const seen: SeenRows<T> = new Map()
  return createMemo(() => stableRowsOf(seen, source() ?? [], options))
}

const sameFields = (left: unknown, right: unknown): boolean => {
  if (Object.is(left, right)) return true
  if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) =>
    Object.is((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
  )
}
