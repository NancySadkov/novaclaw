import { createSignal, onCleanup, type Owner } from "solid-js"

/**
 * The dialog stack's BOOKKEEPING, with the rendering handed in.
 *
 * ⚠️ Extracted from `dialog.tsx` because the part that can be got wrong quietly has nothing to do
 * with JSX. A dialog mounts under `createRoot`, which is **detached**: Solid gives the root the
 * calling owner's *context* and never adds it to that owner's `owned` list, so disposing the
 * component that opened a dialog disposes nothing at all. That is invisible in a component test —
 * there are none in this repo, since Solid JSX needs its compiler — and it is what produced a
 * measured WRITE to the wrong folder (the Tune dialog survived a route change,
 * kept the previous chat's state, and "Save as folder default" created `novaclaw.json` in the
 * folder the user had already left).
 *
 * So the stack lives here, as plain data over injected `dispose` handles, and the lifetime rules
 * below are assertable without a DOM.
 */

/** What the renderer hands back for one mounted dialog. */
export interface DialogRendered<Node> {
  readonly node: Node
  /** Tear the dialog's reactive root down. */
  readonly dispose: () => void
  /** Drive the exit animation; the entry is disposed once it has played. */
  readonly setClosing: (closing: boolean) => void
}

export interface DialogMountInput<Element> {
  readonly id: string
  /** 0 for a replacing `show`, N for the Nth stacked `push` — the renderer turns it into a z-index. */
  readonly layer: number
  readonly element: Element
  readonly owner: Owner
}

export interface DialogEntry<Element, Node> extends DialogRendered<Node> {
  readonly id: string
  readonly owner: Owner
  readonly onClose?: () => void
  readonly element: Element
}

/** How long the exit animation is given before the root is torn down. */
export const DIALOG_CLOSE_MS = 100

let counter = 0
/** Ids are minted here so a caller can hold one BEFORE the dialog mounts — see `dialog-scope.ts`. */
export const nextDialogID = () => `${(counter++).toString(36)}${Math.random().toString(36).slice(2)}`

export function createDialogStack<Element, Node>(input: {
  readonly render: (mount: DialogMountInput<Element>) => DialogRendered<Node> | undefined
}) {
  const [stack, setStack] = createSignal<DialogEntry<Element, Node>[]>([])
  /**
   * The close in flight: its id as well as its timer.
   *
   * ⚠️ The id is not decoration. `discard` can take an entry out from under a pending close (the
   * component that owns it unmounted mid-animation), and a timer that then fires would drop the
   * `lock` on a stack it no longer describes — which swallows the NEXT close for 100 ms.
   */
  const pending = { id: undefined as string | undefined, timer: undefined as ReturnType<typeof setTimeout> | undefined }
  const lock = { value: false }

  const clearPending = () => {
    if (pending.timer !== undefined) clearTimeout(pending.timer)
    pending.timer = undefined
    pending.id = undefined
  }

  onCleanup(clearPending)

  const remove = (id: string) => setStack((items) => items.filter((item) => item.id !== id))

  /** Dismiss the way a USER dismisses: run the close hook, play the animation, then tear down. */
  const close = (id?: string) => {
    const items = stack()
    const current = id ? items.find((item) => item.id === id) : items.at(-1)
    if (!current || lock.value) return
    lock.value = true
    current.onClose?.()
    current.setClosing(true)

    clearPending()
    pending.id = current.id
    pending.timer = setTimeout(() => {
      pending.timer = undefined
      pending.id = undefined
      current.dispose()
      remove(current.id)
      lock.value = false
    }, DIALOG_CLOSE_MS)
  }

  /**
   * Tear ONE dialog down at once, because the thing it was rendering is gone.
   *
   * 🔴 **`onClose` is deliberately NOT run.** That hook belongs to the opener — the composer's is
   * `restoreFocus` — and the opener is the very thing that just unmounted. Calling it would reach
   * into a disposed scope to restore focus to an element that is no longer in the document. A user
   * dismissal runs it; a lifetime end does not, and the two are different events.
   *
   * ⚠️ No exit animation either: there is nothing left to animate out of, and waiting 100 ms would
   * leave a modal on screen bound to dead state for exactly as long as it takes to click a button
   * in it.
   */
  const discard = (id: string) => {
    const current = stack().find((item) => item.id === id)
    if (!current) return
    if (pending.id === id) {
      clearPending()
      lock.value = false
    }
    current.dispose()
    remove(id)
  }

  const mount = (element: Element, owner: Owner, onClose: (() => void) | undefined, layer: number, id: string) => {
    const rendered = input.render({ id, layer, element, owner })
    if (!rendered) return
    setStack((items) => [...items, { id, owner, onClose, element, ...rendered }])
  }

  /** Stack a dialog ON TOP of whatever is open. */
  const push = (element: Element, owner: Owner, onClose?: () => void, id: string = nextDialogID()) => {
    clearPending()
    lock.value = false
    mount(element, owner, onClose, stack().length, id)
  }

  /** REPLACE whatever is open. The displaced roots are torn down, not closed — nobody dismissed them. */
  const show = (element: Element, owner: Owner, onClose?: () => void, id: string = nextDialogID()) => {
    for (const item of stack()) item.dispose()
    setStack([])
    clearPending()
    lock.value = false
    mount(element, owner, onClose, 0, id)
  }

  return { stack, close, discard, show, push }
}

export type DialogStack<Element, Node> = ReturnType<typeof createDialogStack<Element, Node>>

/**
 * A caller's claim on the dialogs it opened, so they can be torn down when IT goes away.
 *
 * 🔴 **Why this is opt-in rather than the rule for every dialog**, which is the shape that first
 * suggested itself: a dialog is not always opened by the component that should own it. A popover
 * body opens one and then unmounts as the popover closes; a dialog opens its successor through
 * `show`, which disposes the caller's own root before the successor mounts. Binding every dialog to
 * its opener would close both — the regression in the opposite direction from the one being fixed.
 *
 * So the caller states the binding where it holds. The Tuning panel is the case that forced it: the
 * panel renders `ComposerFeaturesControlState`, which the composer's memo owns, so a panel that
 * outlives its composer renders — and WRITES with — a frozen copy of a chat the user has left.
 *
 * @param onDispose the caller's own teardown hook (`onCleanup`), injected so the rule is assertable
 * without mounting a component.
 */
export function createDialogScope(input: {
  readonly discard: (id: string) => void
  readonly onDispose: (fn: () => void) => void
}) {
  const owned = new Set<string>()
  let released = false
  input.onDispose(() => {
    released = true
    // A copy: `discard` reaches back into the stack, and this set is the thing being iterated.
    for (const id of [...owned]) input.discard(id)
    owned.clear()
  })
  return {
    /**
     * Claim an id before the dialog mounts.
     *
     * ⚠️ Returns `false` when the owner is ALREADY gone, and the caller must not mount: a dialog
     * opened out of a disposed scope would be born with nothing left to tear it down. This is
     * reachable — `show()` mounts inside a Solid transition, so an unmount can land between the
     * claim and the mount.
     */
    claim(id: string) {
      if (released) {
        input.discard(id)
        return false
      }
      owned.add(id)
      return true
    },
    /** The dialog ended by itself. Stop holding the id, so teardown does not chase a stale one. */
    forget(id: string) {
      owned.delete(id)
    },
    /** For the test, and for nothing else. */
    size: () => owned.size,
  }
}
