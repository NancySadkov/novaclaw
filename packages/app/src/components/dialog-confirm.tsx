import { type JSX } from "solid-js"
import { Dialog } from "@novaclaw/ui/v2/dialog-v2"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { useLanguage } from "@/context/language"

export interface ConfirmOptions {
  title: string
  description: string | JSX.Element
  confirmLabel?: string
  cancelLabel?: string
  /** Style the confirm button as destructive (red). */
  destructive?: boolean
}

// A small reusable confirm dialog (uix.md §3.4 — destructive actions must confirm before they fire).
// Promise-based: resolves true on confirm, false on cancel/dismiss (overlay/Escape). Uses dialog.push
// so it STACKS on top of an open dialog (e.g. Settings) instead of replacing it, then closes itself.
export function useConfirm() {
  const dialog = useDialog()
  const language = useLanguage()
  return (options: ConfirmOptions) =>
    new Promise<boolean>((resolve) => {
      let done = false
      const settle = (value: boolean) => {
        if (done) return
        done = true
        resolve(value)
      }
      dialog.push(
        () => (
          <Dialog size="content">
            <div class="flex flex-col gap-4 px-7 py-6 min-w-[21rem] max-w-[27rem]">
              <div class="flex flex-col gap-1.5">
                <span class="text-[15px] font-semibold text-v2-text-text-base">{options.title}</span>
                <span class="text-[13px] text-v2-text-text-muted leading-relaxed">{options.description}</span>
              </div>
              <div class="flex items-center justify-end gap-2">
                <ButtonV2
                  size="normal"
                  variant="ghost-muted"
                  onClick={() => {
                    settle(false)
                    dialog.close()
                  }}
                >
                  {options.cancelLabel ?? language.t("common.cancel")}
                </ButtonV2>
                <ButtonV2
                  size="normal"
                  variant={options.destructive ? "danger" : "gold"}
                  autofocus
                  onClick={() => {
                    settle(true)
                    dialog.close()
                  }}
                >
                  {options.confirmLabel ?? language.t("common.confirm")}
                </ButtonV2>
              </div>
            </div>
          </Dialog>
        ),
        () => settle(false),
      )
    })
}
