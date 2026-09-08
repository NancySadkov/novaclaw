import {
  createContext,
  createRoot,
  getOwner,
  onCleanup,
  type Owner,
  type ParentProps,
  runWithOwner,
  useContext,
  type JSX,
  startTransition,
  For,
  createSignal,
} from "solid-js"
import { DialogPortalContext } from "./dialog-portal"
import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { createDialogScope, createDialogStack, nextDialogID } from "./dialog-stack"

type DialogElement = () => JSX.Element

const Context = createContext<ReturnType<typeof init>>()

function init() {
  /**
   * The bookkeeping lives in `dialog-stack.ts`; only the MOUNT is here, because only the mount
   * needs JSX. `createRoot` is the whole reason that split exists — see that file's header.
   */
  const stack = createDialogStack<DialogElement, JSX.Element>({
    render: ({ id, layer, element, owner }) => {
      const zIndex = 50 + layer * 10
      let dispose: (() => void) | undefined
      let setClosing: ((closing: boolean) => void) | undefined

      const node = runWithOwner(owner, () =>
        createRoot((d: () => void) => {
          dispose = d
          const [portal, setPortal] = createSignal<HTMLElement>()
          const [closing, setClosingSignal] = createSignal(false)
          setClosing = setClosingSignal
          return (
            <Kobalte
              modal
              open={!closing()}
              onOpenChange={(open: boolean) => {
                if (open) return
                stack.close(id)
              }}
            >
              <Kobalte.Portal>
                <Kobalte.Overlay
                  data-component="dialog-overlay"
                  style={{ "z-index": String(zIndex) }}
                  onClick={() => stack.close(id)}
                />
                <div
                  ref={setPortal}
                  data-dialog-layer={layer}
                  style={{
                    position: "fixed",
                    inset: "0",
                    "z-index": String(zIndex),
                    display: "flex",
                    "align-items": "center",
                    "justify-content": "center",
                    "pointer-events": "none",
                  }}
                >
                  <DialogPortalContext.Provider value={portal}>{element()}</DialogPortalContext.Provider>
                </div>
              </Kobalte.Portal>
            </Kobalte>
          )
        }),
      )

      if (!dispose || !setClosing) return undefined
      return { node, dispose, setClosing }
    },
  })

  // Kobalte owns Escape through its topmost dismissable layer. A window capture listener here
  // would close the dialog before a nested select, popover or menu can consume the same key.

  return stack
}

export function DialogProvider(props: ParentProps) {
  const ctx = init()
  return (
    <Context.Provider value={ctx}>
      {props.children}
      <div data-component="dialog-stack">
        <For each={ctx.stack()}>{(item) => item.node}</For>
      </div>
    </Context.Provider>
  )
}

export function useDialog() {
  const ctx = useContext(Context)
  const owner = getOwner()

  if (!owner) {
    throw new Error("useDialog must be used within a DialogProvider")
  }
  if (!ctx) {
    throw new Error("useDialog must be used within a DialogProvider")
  }

  /**
   * The caller's claim on the dialogs it opens with {@link showScoped}. Registered at HOOK time,
   * which is component setup — `onCleanup` inside a click handler would attach to nothing.
   */
  const scope = createDialogScope({ discard: (id) => ctx.discard(id), onDispose: onCleanup })

  return {
    get active() {
      return ctx.stack().at(-1)
    },
    show(element: DialogElement, onClose?: () => void) {
      const base = ctx.stack().at(-1)?.owner ?? owner
      return startTransition(() => ctx.show(element, base, onClose))
    },
    /**
     * `show`, with the dialog's LIFE BOUND to the calling component: when that component goes, so
     * does the dialog.
     *
     * 🔴 Reach for this whenever the dialog renders state the caller OWNS. `dialog.show` mounts a
     * detached root, so an ordinary dialog keeps rendering a frozen copy of that state after the
     * caller unmounts — and a button in it then acts on the frozen copy. Measured: the composer's
     * Tuning panel survived a route change to another folder and its "Save as folder default"
     * wrote `novaclaw.json` into the folder the user had left.
     *
     * ⚠️ It is opt-in, and `dialog-stack.ts` records the two shapes that make the blanket version
     * wrong (a popover body that unmounts on click; a dialog that opens its own successor).
     */
    showScoped(element: DialogElement, onClose?: () => void) {
      const base = ctx.stack().at(-1)?.owner ?? owner
      const id = nextDialogID()
      if (!scope.claim(id)) return
      return startTransition(() =>
        ctx.show(
          element,
          base,
          () => {
            scope.forget(id)
            onClose?.()
          },
          id,
        ),
      )
    },
    push(element: DialogElement, onClose?: () => void) {
      const base = ctx.stack().at(-1)?.owner ?? owner
      return startTransition(() => ctx.push(element, base, onClose))
    },
    close() {
      ctx.close()
    },
  }
}
