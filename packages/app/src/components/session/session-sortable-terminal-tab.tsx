import type { JSX } from "solid-js"
import { Show, createEffect, onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { createSortable } from "@thisbeyond/solid-dnd"
import { Icon as IconV2 } from "@novaclaw/ui/v2/icon"
import { IconButtonV2 } from "@novaclaw/ui/v2/icon-button-v2"
import { TabsV2 } from "@novaclaw/ui/v2/tabs-v2"
import { DropdownMenu } from "@novaclaw/ui/dropdown-menu"
import { Icon } from "@novaclaw/ui/v2/icon"
import { isDefaultTitle as isDefaultTerminalTitle } from "@/context/terminal-title"
import { useTerminal, type LocalPTY } from "@/context/terminal"
import { useLanguage } from "@/context/language"
import { focusTerminalById } from "@/pages/session/helpers"

export function SortableTerminalTab(props: { terminal: LocalPTY; onClose?: () => void }): JSX.Element {
  const terminal = useTerminal()
  const language = useLanguage()
  const sortable = createSortable(props.terminal.id)
  const [store, setStore] = createStore({
    editing: false,
    title: props.terminal.title,
    menuOpen: false,
    menuPosition: { x: 0, y: 0 },
    blurEnabled: false,
  })
  let input: HTMLInputElement | undefined
  let blurFrame: number | undefined
  let editRequested = false

  const isDefaultTitle = () => {
    const number = props.terminal.titleNumber
    if (!Number.isFinite(number) || number <= 0) return false
    return isDefaultTerminalTitle(props.terminal.title, number)
  }

  const label = () => {
    language.locale()
    if (props.terminal.title && !isDefaultTitle()) return props.terminal.title

    const number = props.terminal.titleNumber
    if (Number.isFinite(number) && number > 0) return language.t("terminal.title.numbered", { number })
    if (props.terminal.title) return props.terminal.title
    return language.t("terminal.title")
  }

  const close = () => {
    const count = terminal.all().length
    void terminal.close(props.terminal.id)
    if (count === 1) {
      props.onClose?.()
    }
  }

  const focus = () => {
    if (store.editing) return
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    focusTerminalById(props.terminal.id)
  }

  const edit = (e?: Event) => {
    if (e) {
      e.stopPropagation()
      e.preventDefault()
    }

    setStore("blurEnabled", false)
    setStore("title", props.terminal.title)
    setStore("editing", true)
  }

  const save = () => {
    if (!store.blurEnabled) return

    const value = store.title.trim()
    if (value && value !== props.terminal.title) {
      terminal.update({ id: props.terminal.id, title: value })
    }
    setStore("editing", false)
  }

  const keydown = (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault()
      save()
      return
    }
    if (e.key === "Escape") {
      e.preventDefault()
      setStore("editing", false)
    }
  }

  const menu = (e: MouseEvent) => {
    e.preventDefault()
    setStore("menuPosition", { x: e.clientX, y: e.clientY })
    setStore("menuOpen", true)
  }

  createEffect(() => {
    if (!store.editing) return
    if (!input) return
    input.focus()
    input.select()
    if (blurFrame !== undefined) cancelAnimationFrame(blurFrame)
    blurFrame = requestAnimationFrame(() => {
      blurFrame = undefined
      setStore("blurEnabled", true)
    })
  })

  onCleanup(() => {
    if (blurFrame === undefined) return
    cancelAnimationFrame(blurFrame)
  })

  return (
    <div
      use:sortable
      class="outline-none focus:outline-none focus-visible:outline-none"
      classList={{
        "h-full": true,
        "opacity-0": sortable.isActiveDraggable,
      }}
    >
      <div class="relative h-full">
        {/* v1's `classes={{ button }}` has no v2 equivalent and needs none (ruling 13 — no shim):
            every rule it asked for is already v2's own. `[data-slot="tabs-v2-trigger"]` declares
            `outline: none` and its `:is(:focus, :focus-visible)` rule declares
            `outline: none; box-shadow: none`, and the default variant draws no border or ring. */}
        <TabsV2.Trigger
          value={props.terminal.id}
          onClick={focus}
          onMouseDown={(e) => e.preventDefault()}
          onContextMenu={menu}
          class="!shadow-none"
          closeButton={
            <IconButtonV2
              icon={<IconV2 name="close" />}
              variant="ghost-muted"
              onClick={(e) => {
                e.stopPropagation()
                close()
              }}
              aria-label={language.t("terminal.close")}
            />
          }
        >
          <span onDblClick={edit} classList={{ invisible: store.editing }}>
            {label()}
          </span>
        </TabsV2.Trigger>
        <Show when={store.editing}>
          <div class="absolute inset-0 flex items-center px-3 bg-muted z-10 pointer-events-auto">
            <input
              ref={input}
              type="text"
              value={store.title}
              onInput={(e) => setStore("title", e.currentTarget.value)}
              onBlur={save}
              onKeyDown={keydown}
              onMouseDown={(e) => e.stopPropagation()}
              class="bg-transparent border-none outline-none text-sm min-w-0 flex-1"
            />
          </div>
        </Show>
        <DropdownMenu open={store.menuOpen} onOpenChange={(open) => setStore("menuOpen", open)}>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              class="fixed"
              style={{
                left: `${store.menuPosition.x}px`,
                top: `${store.menuPosition.y}px`,
              }}
              onCloseAutoFocus={(e) => {
                if (!editRequested) return
                e.preventDefault()
                editRequested = false
                requestAnimationFrame(() => edit())
              }}
            >
              <DropdownMenu.Item onSelect={() => (editRequested = true)}>
                <Icon name="edit" class="w-4 h-4 mr-2" size="large" />
                {language.t("common.rename")}
              </DropdownMenu.Item>
              <DropdownMenu.Item onSelect={close}>
                <Icon name="close" class="w-4 h-4 mr-2" size="large" />
                {language.t("common.close")}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu>
      </div>
    </div>
  )
}
