import { render } from "solid-js/web"
import { DialogProvider, useDialog } from "@novaclaw/ui/context/dialog"
import { Dialog } from "@novaclaw/ui/v2/dialog-v2"
import { SelectV2 } from "@novaclaw/ui/v2/select-v2"
import { Popover } from "@novaclaw/ui/popover"

export function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  const Open = () => {
    const dialog = useDialog()
    return (
      <button
        onClick={() =>
          dialog.show(() => (
            <Dialog>
              <button
                onClick={() =>
                  dialog.push(() => (
                    <Dialog>
                      <SelectV2 aria-label="Stacked choice" options={["One", "Two"]} current="One" />
                    </Dialog>
                  ))
                }
              >
                Open stacked dialog
              </button>
              <Popover title="Nested controls" triggerAs="button" trigger="Open nested popover">
                <SelectV2 aria-label="Nested choice" options={["One", "Two"]} current="One" />
              </Popover>
            </Dialog>
          ))
        }
      >
        Open layer fixture
      </button>
    )
  }
  const dispose = render(
    () => (
      <DialogProvider>
        <Open />
      </DialogProvider>
    ),
    host,
  )
  return () => {
    dispose()
    host.remove()
  }
}
