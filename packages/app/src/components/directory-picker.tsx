import { useDialog } from "@novaclaw/ui/context/dialog"
import { ServerConnection } from "@/context/server"
import { lazy } from "solid-js"

const DialogSelectDirectoryV2 = lazy(() =>
  import("./dialog-select-directory-v2").then((module) => ({ default: module.DialogSelectDirectoryV2 })),
)

type DirectoryPickerInput = {
  server: ServerConnection.Any
  title?: string
  multiple?: boolean
  /**
   * Turns the folder picker into a SAVE-AS: shows a filename field seeded with `initial`, and reports the
   * final name through `onFilename`. Without it the dialog is folder-only, exactly as before.
   *
   * Added because "Export as Markdown" opened a folder picker with nowhere to type a name, so it read as
   * broken even though the server was naming the file sensibly (owner 2026-07-26).
   */
  filename?: { initial: string; onFilename: (name: string) => void }
  onSelect: (result: string | string[] | null) => void
}

export function useDirectoryPicker() {
  const dialog = useDialog()

  // Always browse the SERVER host's filesystem via our own modal (V2 dialog) — never the client-native
  // OS dialog. NovaClaw's files live where the server RUNS (headless Spark / phone / local), not on the
  // client. B9/FS-2 (plan.md M1): the native branch + desktop gate were removed so web, desktop, and
  // future mobile all get the same in-app picker. The Electron `openDirectoryPickerDialog` IPC stays in
  // place, just unreferenced, in case B9-final wants it behind a setting.
  return (input: DirectoryPickerInput) => {
    let selected = false
    const onSelect = (result: string | string[] | null) => {
      selected = result !== null
      input.onSelect(result)
    }
    const cancel = () => {
      if (!selected) input.onSelect(null)
    }
    /**
     * 🔴 `push`, never `show`. A picker is a MODAL UTILITY — the opener stays put and waits, the way
     * a message box does. `show` REPLACES the stack, and `dialog-stack.ts` says what that costs:
     * *"The displaced roots are torn down, not closed — nobody dismissed them."* Opened from inside
     * the agent-config dialog that meant the opener was DESTROYED before the user had picked
     * anything, so `onSelect` wrote `setDirectory(picked)` into a disposed reactive root and the
     * dialog's own close hook never ran — the folder silently stayed unchanged and nothing reported
     * a failure (owner, 2026-09-01).
     *
     * ⚠️ Safe at the call sites that open from a PAGE rather than a dialog: with an empty stack
     * `push` and `show` do the same thing — nothing to displace, and `layer` is `stack().length`,
     * which is 0.
     */
    dialog.push(() => <DialogSelectDirectoryV2 {...input} onSelect={onSelect} />, cancel)
  }
}
