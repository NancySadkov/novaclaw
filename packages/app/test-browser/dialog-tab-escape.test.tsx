import { afterEach, expect, test } from "bun:test"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { DialogV2 } from "@novaclaw/ui/v2/dialog-v2"
import { TabsV2 } from "@novaclaw/ui/v2/tabs-v2"

let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  document.body.innerHTML = ""
})
const settle = () => new Promise((resolve) => setTimeout(resolve, 25))

test("Escape from a focused tab dismisses its dialog even though the tablist consumes the key", async () => {
  const host = document.createElement("div")
  document.body.append(host)
  const [opened, setOpened] = createSignal(true)
  dispose = render(
    () => (
      <Kobalte open={opened()} onOpenChange={setOpened}>
        <Kobalte.Portal>
          <DialogV2>
            <TabsV2 defaultValue="context">
              <TabsV2.List>
                <TabsV2.Trigger value="context">Context</TabsV2.Trigger>
              </TabsV2.List>
              <TabsV2.Content value="context">Officer statistics</TabsV2.Content>
            </TabsV2>
          </DialogV2>
        </Kobalte.Portal>
      </Kobalte>
    ),
    host,
  )
  await settle()
  const tab = document.querySelector<HTMLButtonElement>('[role="tab"]')!
  tab.focus()
  tab.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
  await settle()
  expect(opened()).toBe(false)
  expect(document.querySelector('[role="dialog"]')?.hasAttribute("data-closed")).toBe(true)
})

test("Escape dismisses a nested tabbed dialog without dismissing its parent", async () => {
  const host = document.createElement("div")
  document.body.append(host)
  const [outerOpen, setOuterOpen] = createSignal(true)
  const [innerOpen, setInnerOpen] = createSignal(false)
  dispose = render(
    () => (
      <Kobalte open={outerOpen()} onOpenChange={setOuterOpen}>
        <Kobalte.Portal>
          <DialogV2>
            <button onClick={() => setInnerOpen(true)}>Open nested</button>
            <Kobalte open={innerOpen()} onOpenChange={setInnerOpen}>
              <Kobalte.Portal>
                <DialogV2>
                  <TabsV2 defaultValue="details">
                    <TabsV2.List>
                      <TabsV2.Trigger value="details">Nested details</TabsV2.Trigger>
                    </TabsV2.List>
                    <TabsV2.Content value="details">Nested body</TabsV2.Content>
                  </TabsV2>
                </DialogV2>
              </Kobalte.Portal>
            </Kobalte>
          </DialogV2>
        </Kobalte.Portal>
      </Kobalte>
    ),
    host,
  )
  await settle()
  document.querySelector<HTMLButtonElement>("button")!.click()
  await settle()
  const tab = document.querySelector<HTMLButtonElement>('[role="tab"]')!
  tab.focus()
  tab.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }))
  await settle()
  expect(innerOpen()).toBe(false)
  expect(outerOpen()).toBe(true)
  expect(document.querySelectorAll('[role="dialog"][data-expanded]').length).toBe(1)
})
