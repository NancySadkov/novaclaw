import { describe, expect, test } from "bun:test"
import { createRoot, getOwner, onCleanup, type Owner } from "solid-js"
import { createDialogScope, createDialogStack, DIALOG_CLOSE_MS, nextDialogID } from "./dialog-stack"

/**
 * **A dialog must not outlive the thing it renders.**
 *
 * `dialog.show` mounts under `createRoot`, which is DETACHED: Solid hands the root the caller's
 * context and never links it to the caller's lifetime, so unmounting the component that opened a
 * dialog disposes nothing. Measured consequence: the composer's Tuning panel
 * survived a route change to another folder, kept rendering the previous chat's state, and
 * "Save as folder default" CREATED `novaclaw.json` in the folder the user had already left.
 *
 * There are no component tests in this repo — Solid JSX needs its own compiler — so the rule is
 * tested where it actually lives: over the stack's plain bookkeeping, with the render injected.
 */

type Fake = { readonly name: string }

/** A renderer that only records. `disposed` is what "the reactive root was torn down" means here. */
const fakeStack = () => {
  const disposed: string[] = []
  const closing: string[] = []
  const stack = createDialogStack<Fake, string>({
    render: ({ id }) => ({
      node: `node:${id}`,
      dispose: () => disposed.push(id),
      setClosing: () => closing.push(id),
    }),
  })
  return { stack, disposed, closing }
}

const owner = () => createRoot(() => getOwner()!) as Owner
const ids = (stack: ReturnType<typeof fakeStack>["stack"]) => stack.stack().map((item) => item.id)

describe("the dialog stack's lifetime rules", () => {
  test("discard tears down exactly one entry and leaves the rest standing", () =>
    createRoot((dispose) => {
      const { stack, disposed } = fakeStack()
      const o = owner()
      stack.push({ name: "a" }, o, undefined, "a")
      stack.push({ name: "b" }, o, undefined, "b")
      stack.push({ name: "c" }, o, undefined, "c")
      expect(ids(stack)).toEqual(["a", "b", "c"])

      stack.discard("b")
      expect(disposed).toEqual(["b"])
      expect(ids(stack)).toEqual(["a", "c"])

      // An id nobody mounted is not an error and not a second teardown.
      stack.discard("b")
      stack.discard("nope")
      expect(disposed).toEqual(["b"])
      dispose()
    }))

  test("discard does NOT run the opener's close hook — that hook belongs to a dismissal", () =>
    createRoot((dispose) => {
      const { stack, disposed, closing } = fakeStack()
      let closed = 0
      stack.push({ name: "a" }, owner(), () => closed++, "a")

      stack.discard("a")
      // The opener is the thing that just went away; calling its `restoreFocus` would reach into a
      // disposed scope. And there is nothing left to animate out of, so no exit either.
      expect(closed).toBe(0)
      expect(closing).toEqual([])
      expect(disposed).toEqual(["a"])
      dispose()
    }))

  test("close still runs the hook, plays the exit, and tears down after it", async () => {
    const done = createRoot(async (dispose) => {
      const { stack, disposed, closing } = fakeStack()
      let closed = 0
      stack.push({ name: "a" }, owner(), () => closed++, "a")

      stack.close("a")
      expect(closed).toBe(1)
      expect(closing).toEqual(["a"])
      // Still on screen while the animation plays — that is the difference from `discard`.
      expect(disposed).toEqual([])
      expect(ids(stack)).toEqual(["a"])

      await Bun.sleep(DIALOG_CLOSE_MS + 40)
      expect(disposed).toEqual(["a"])
      expect(ids(stack)).toEqual([])
      dispose()
    })
    await done
  })

  test("discarding an entry mid-close does not wedge the next close for 100 ms", async () => {
    const done = createRoot(async (dispose) => {
      const { stack, disposed } = fakeStack()
      stack.push({ name: "a" }, owner(), undefined, "a")
      stack.push({ name: "b" }, owner(), undefined, "b")

      stack.close("b") // takes the lock and arms the timer
      stack.discard("b") // the opener unmounted mid-animation

      expect(disposed).toEqual(["b"])
      expect(ids(stack)).toEqual(["a"])
      // The lock was released with the timer it belonged to. Without that, this close is swallowed.
      stack.close("a")
      await Bun.sleep(DIALOG_CLOSE_MS + 40)
      expect(disposed).toEqual(["b", "a"])
      expect(ids(stack)).toEqual([])
      dispose()
    })
    await done
  })
})

describe("a scoped dialog dies with the component that opened it", () => {
  test("scoped goes, unscoped stays — the A/B the blanket version would fail", () =>
    createRoot((disposeAll) => {
      const { stack, disposed } = fakeStack()
      const host = owner()

      // The "component" that opens the dialogs.
      let scope!: ReturnType<typeof createDialogScope>
      const unmount = createRoot((dispose) => {
        scope = createDialogScope({ discard: (id) => stack.discard(id), onDispose: onCleanup })
        return dispose
      })

      const scoped = nextDialogID()
      expect(scope.claim(scoped)).toBe(true)
      stack.push({ name: "scoped" }, host, undefined, scoped)
      // Opened WITHOUT a claim — a popover body's dialog, or one dialog opening its successor.
      stack.push({ name: "plain" }, host, undefined, "plain")
      expect(ids(stack)).toEqual([scoped, "plain"])

      unmount()

      expect(disposed).toEqual([scoped])
      expect(ids(stack)).toEqual(["plain"])
      disposeAll()
    }))

  test("a claim that lands after the owner is gone refuses to mount", () =>
    createRoot((disposeAll) => {
      const { stack, disposed } = fakeStack()
      let scope!: ReturnType<typeof createDialogScope>
      const unmount = createRoot((dispose) => {
        scope = createDialogScope({ discard: (id) => stack.discard(id), onDispose: onCleanup })
        return dispose
      })
      unmount()

      // `show` mounts inside a Solid transition, so an unmount really can land in this gap.
      const late = nextDialogID()
      expect(scope.claim(late)).toBe(false)
      expect(ids(stack)).toEqual([])
      expect(disposed).toEqual([])
      disposeAll()
    }))

  test("a dialog that closed by itself is forgotten, so teardown chases nothing", () =>
    createRoot((disposeAll) => {
      const { stack, disposed } = fakeStack()
      const host = owner()
      let scope!: ReturnType<typeof createDialogScope>
      const unmount = createRoot((dispose) => {
        scope = createDialogScope({ discard: (id) => stack.discard(id), onDispose: onCleanup })
        return dispose
      })

      const first = nextDialogID()
      scope.claim(first)
      stack.push({ name: "first" }, host, () => scope.forget(first), first)
      stack.close(first)
      expect(scope.size()).toBe(0)

      unmount()
      // The teardown had nothing to do: the entry is still mid-animation and owns its own end.
      expect(disposed).toEqual([])
      disposeAll()
    }))

  test("every id is distinct, including across a same-millisecond burst", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 5000; i++) seen.add(nextDialogID())
    expect(seen.size).toBe(5000)
  })
})
