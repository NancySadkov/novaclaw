import { useDialog } from "@novaclaw/ui/context/dialog"
import { ServerConnection } from "@/context/server"
import { useSettings } from "@/context/settings"
import { lazy } from "solid-js"
import { DialogSelectDirectory } from "./dialog-select-directory"

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
  const settings = useSettings()
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
    if (settings.general.newLayoutDesigns()) {
      dialog.show(() => <DialogSelectDirectoryV2 {...input} onSelect={onSelect} />, cancel)
      return
    }
    dialog.show(() => <DialogSelectDirectory {...input} onSelect={onSelect} />, cancel)
  }
}
