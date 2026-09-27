import { describe, expect, test } from "bun:test"
import { stableRowsOf, type SeenRows } from "./stable-rows"

/**
 * 🔴 **THE class, stated once: a polled row's identity was the object the poll returned.**
 *
 * `@tanstack/solid-query` disables structural sharing (`useBaseQuery.ts`), so a 2-second poll of the
 * worker list hands back a new array of new objects every time. Solid's `<For>` is `mapArray`, which
 * reuses a row only on `items[i] === newItems[i]` — reference equality. Every row was therefore
 * destroyed and recreated on every tick, taking the stop-reason `<textarea autofocus>` with it:
 * focus dropped, caret dropped, and the fresh `autofocus` grabbed it straight back. Measured as the
 * owner typing a reason and the field fighting them, 2026-09-27.
 *
 * The rendering half of the proof — that a row really does keep its DOM node across an unchanged poll
 * — is `test-browser/session-activity-dialogs.test.tsx`, because this tier resolves `solid-js` through
 * its server build and has no working reactivity. The control that matters as much as the fix: a field
 * the row does NOT render must not be able to rebuild it. `state` on a worker row is exactly that — it
 * flips `queued → busy` moments after a spawn, which under reference identity destroys the row the
 * user is typing in.
 */

interface Row {
  readonly id: string
  readonly title: string
  readonly startedAt: number
  /**
   * ⚠️ OPTIONAL, and that is part of the assertion. `state` is on the wire and absent from the
   * rendered row, so the projected item is a `Row` with no `state` — required here would be a type
   * error, which is the door closing on "the row and the wire row are the same shape".
   */
  readonly state?: string
}

const row = (id: string, over: Partial<Row> = {}): Row => ({ id, title: id, startedAt: 1, state: "busy", ...over })

/**
 * What `WorkerListDialog` renders, and therefore what a row's identity may depend on. `state` is
 * deliberately absent: it is on the wire and absent from the row, which is the whole point.
 */
const options = {
  key: (item: Row) => item.id,
  fields: ({ id, title, startedAt }: Row) => ({ id, title, startedAt }),
  project: ({ id, title, startedAt }: Row): Row => ({ id, title, startedAt }),
}

/** One poll's worth of memory, plus the list it produced — the whole helper, with no reactivity. */
const poll = () => {
  const seen: SeenRows<Row> = new Map()
  return { answer: (rows: readonly Row[]) => stableRowsOf(seen, rows, options), seen }
}

describe("a polled list keeps its rows' identity", () => {
  test("an UNCHANGED poll returns the very same items, so <For> reuses the rows", () => {
    // The regression itself: same workers, same values, new objects — as a JSON poll always produces.
    const { answer } = poll()
    const before = answer([row("a", { title: "Audit", state: "queued" })])
    const after = answer([row("a", { title: "Audit", state: "queued" })])
    expect(after).toHaveLength(1)
    expect(after[0]).toBe(before[0])
  })

  test("a field the row does NOT render cannot rebuild it", () => {
    // 🔴 The second half of the same defect. `state` flips `queued → busy` moments after a spawn, and
    // a row keyed on the whole object is destroyed by it — while the user is typing into that row.
    const { answer } = poll()
    const before = answer([row("a", { title: "Audit", state: "queued" })])
    const after = answer([row("a", { title: "Audit", state: "busy" })])
    expect(after[0]).toBe(before[0])
    expect(after[0]).not.toHaveProperty("state")
  })

  test("a field the row DOES render does rebuild it", () => {
    // The negative control. A helper that ignored every change would pass the two above and freeze
    // the list, which is its own silent lie.
    const { answer } = poll()
    const before = answer([row("a", { title: "Audit" })])
    const after = answer([row("a", { title: "Audit the ledger" })])
    expect(after[0]).not.toBe(before[0])
    expect(after[0]?.title).toBe("Audit the ledger")
  })

  test("rows are tracked by their own key, so a worker leaving does not renamesake the rest", () => {
    const { answer } = poll()
    const before = answer([row("a"), row("b"), row("c")])
    const after = answer([row("a"), row("c")])
    expect(after[0]).toBe(before[0])
    expect(after[1]).not.toBe(before[1])
    expect(after.map((item) => item.id)).toEqual(["a", "c"])
  })

  test("an absent list is an empty list, never a stale one", () => {
    const { answer } = poll()
    answer([row("a")])
    expect(answer([])).toEqual([])
  })

  test("a list that empties and refills hands back FRESH rows for the returning worker", () => {
    // Otherwise a returning id would resurrect the item captured before it left, with whatever title
    // it had then — a list that quietly rewrites history.
    const { answer } = poll()
    const first = answer([row("a", { title: "first" })])[0]
    expect(answer([])).toEqual([])
    expect(answer([row("a", { title: "first" })])[0]).not.toBe(first)
  })

  test("a long churn of leaving and returning rows leaves the survivors alone and forgets the rest", () => {
    // The map holds one entry per key it has seen; the live list is the bound. What is observable is
    // that a survivor is never rebuilt by somebody else's churn, and that the map does not grow.
    const { answer, seen } = poll()
    const [survivor] = answer([row("a"), row("b"), row("c"), row("d")])
    for (const gone of ["b", "c", "d", "x", "y"]) {
      const during = answer([row("a"), row(gone)])
      expect(during[0]).toBe(survivor)
      answer([row("a")])
      expect(seen.size).toBe(1)
    }
  })
})
