import { describe, expect, test } from "bun:test"
import { createRefCountMap } from "./refcount"
import { withTransientOwner } from "./transient-owner"

/**
 * The invariant: **N acquisitions from a callback with no Solid owner leave the refcount at zero.**
 *
 * The negative control is the pre-fix call shape — the same acquisition made directly. It no longer
 * *leaks*, because `createRefCountMap` now REFUSES an ownerless caller outright; the control asserts
 * that refusal instead. It still does the job a control has to do: a `withTransientOwner` that did
 * nothing but call `work()` would raise the very same error in the first case, so the pair separates
 * a helper that establishes a real owner from one that only looks like it does.
 */
describe("withTransientOwner", () => {
  const harness = () => {
    const removed: string[] = []
    const map = createRefCountMap(
      (key) => key,
      (key) => removed.push(key),
    )
    return { removed, map }
  }

  test("N ownerless acquisitions settle back to zero", async () => {
    const { removed, map } = harness()

    for (let i = 0; i < 5; i += 1) {
      await withTransientOwner(async () => {
        const value = map("/project")
        await Promise.resolve()
        return value
      })
    }

    expect(removed).toEqual(["/project", "/project", "/project", "/project", "/project"])
  })

  test("NEGATIVE CONTROL: the same acquisition made directly is refused, and takes nothing", () => {
    const { removed, map } = harness()

    // The leak this helper exists to close is no longer reachable: an ownerless acquisition once
    // took a reference nothing could give back, silently. It now throws, so the reference is never
    // taken at all and there is nothing to release.
    expect(() => map("/project")).toThrow("acquired with no owner")
    expect(removed).toEqual([])
  })

  test("a rejected unit of work still releases", async () => {
    const { removed, map } = harness()

    await expect(
      withTransientOwner(async () => {
        map("/project")
        await Promise.resolve()
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")

    expect(removed).toEqual(["/project"])
  })

  test("a synchronous throw releases and rejects rather than stranding the root", async () => {
    const { removed, map } = harness()

    await expect(
      withTransientOwner(() => {
        map("/project")
        throw new Error("acquire failed")
      }),
    ).rejects.toThrow("acquire failed")

    expect(removed).toEqual(["/project"])
  })

  test("overlapping acquisitions hold the resource until the LAST one settles", async () => {
    const { removed, map } = harness()
    let releaseFirst = () => {}
    const first = withTransientOwner(async () => {
      map("/project")
      await new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
    })
    const second = withTransientOwner(async () => {
      map("/project")
      await Promise.resolve()
    })

    await second
    expect(removed).toEqual([])
    releaseFirst()
    await first
    expect(removed).toEqual(["/project"])
  })
})
