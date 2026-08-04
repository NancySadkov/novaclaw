import { Select as Kobalte } from "@kobalte/core/select"
import { createMemo, onCleanup, splitProps, type ComponentProps, type JSX } from "solid-js"
import { Button, ButtonProps } from "./button"
import { Icon } from "./icon"
import { selectGroups, selectIsGrouped } from "./select-groups"

export type SelectProps<T> = Omit<ComponentProps<typeof Kobalte<T>>, "value" | "onSelect" | "children"> & {
  placeholder?: string
  options: T[]
  current?: T
  value?: (x: T) => string
  label?: (x: T) => string
  groupBy?: (x: T) => string
  valueClass?: ComponentProps<"div">["class"]
  onSelect?: (value: T | undefined) => void
  onHighlight?: (value: T | undefined) => (() => void) | void
  class?: ComponentProps<"div">["class"]
  classList?: ComponentProps<"div">["classList"]
  children?: (item: T | undefined) => JSX.Element
  triggerStyle?: JSX.CSSProperties
  triggerVariant?: "settings"
  triggerProps?: Record<string, string | number | boolean | undefined>
}

export function Select<T>(props: SelectProps<T> & Omit<ButtonProps, "children">) {
  const [local, others] = splitProps(props, [
    "class",
    "classList",
    "placeholder",
    "options",
    "current",
    "value",
    "label",
    "groupBy",
    "valueClass",
    "onSelect",
    "onHighlight",
    "onOpenChange",
    "children",
    "triggerStyle",
    "triggerVariant",
    "triggerProps",
  ])

  const state = {
    key: undefined as string | undefined,
    cleanup: undefined as (() => void) | void,
  }

  const stop = () => {
    state.cleanup?.()
    state.cleanup = undefined
    state.key = undefined
  }

  const keyFor = (item: T) => (local.value ? local.value(item) : (item as string))

  const move = (item: T | undefined) => {
    if (!local.onHighlight) return
    if (!item) {
      stop()
      return
    }

    const key = keyFor(item)
    if (state.key === key) return
    state.cleanup?.()
    state.cleanup = local.onHighlight(item)
    state.key = key
  }

  onCleanup(stop)

  const grouped = createMemo(() => selectGroups(local.options, local.groupBy))

  return (
    // @ts-ignore
    <Kobalte<T, { category: string; options: T[] }>
      {...others}
      data-component="select"
      data-trigger-style={local.triggerVariant}
      placement={local.triggerVariant === "settings" ? "bottom-end" : "bottom-start"}
      gutter={4}
      value={local.current}
      // ⚠️ Only hand Kobalte the GROUPED shape when there is something to group by. `grouped()` always
      // wraps — with no `groupBy` every option lands under a single `""` category — and pairing that
      // with `optionGroupChildren="options"` told Kobalte to read ordinary options as a SECTION whose
      // children live under a key they do not have, so the control rendered EMPTY. It broke the
      // Settings and model selectors and the thinking-level control: surfaces a normal person uses,
      // failing silently rather than loudly. Ported from
      // https://github.com/NancySadkov/novaclaw/pull/12 by @DassaultFalconKing.
      options={selectIsGrouped(local.groupBy) ? grouped() : local.options}
      optionValue={(x) => (local.value ? local.value(x) : (x as string))}
      optionTextValue={(x) => (local.label ? local.label(x) : (x as string))}
      optionGroupChildren={selectIsGrouped(local.groupBy) ? "options" : undefined}
      placeholder={local.placeholder}
      sectionComponent={(local) => (
        <Kobalte.Section data-slot="select-section">{local.section.rawValue.category}</Kobalte.Section>
      )}
      itemComponent={(itemProps) => (
        <Kobalte.Item
          {...itemProps}
          data-slot="select-select-item"
          classList={{
            ...local.classList,
            [local.class ?? ""]: !!local.class,
          }}
          onPointerEnter={() => move(itemProps.item.rawValue)}
          onPointerMove={() => move(itemProps.item.rawValue)}
          onFocus={() => move(itemProps.item.rawValue)}
        >
          <Kobalte.ItemLabel data-slot="select-select-item-label">
            {local.children
              ? local.children(itemProps.item.rawValue)
              : local.label
                ? local.label(itemProps.item.rawValue)
                : (itemProps.item.rawValue as string)}
          </Kobalte.ItemLabel>
          <Kobalte.ItemIndicator data-slot="select-select-item-indicator">
            <Icon name="check-small" size="small" />
          </Kobalte.ItemIndicator>
        </Kobalte.Item>
      )}
      onChange={(v) => {
        local.onSelect?.(v ?? undefined)
        stop()
      }}
      onOpenChange={(open) => {
        local.onOpenChange?.(open)
        if (!open) stop()
      }}
    >
      <Kobalte.Trigger
        {...local.triggerProps}
        disabled={props.disabled}
        data-slot="select-select-trigger"
        as={Button}
        size={props.size}
        variant={props.variant}
        style={local.triggerStyle}
        classList={{
          ...local.classList,
          [local.class ?? ""]: !!local.class,
        }}
      >
        <Kobalte.Value<T> data-slot="select-select-trigger-value" class={local.valueClass}>
          {(state) => {
            const selected = state.selectedOption() ?? local.current
            if (!selected) return local.placeholder || ""
            if (local.label) return local.label(selected)
            return selected as string
          }}
        </Kobalte.Value>
        <Kobalte.Icon data-slot="select-select-trigger-icon">
          <Icon name={local.triggerVariant === "settings" ? "selector" : "chevron-down"} size="small" />
        </Kobalte.Icon>
      </Kobalte.Trigger>
      <Kobalte.Portal>
        <Kobalte.Content
          classList={{
            ...local.classList,
            [local.class ?? ""]: !!local.class,
          }}
          data-component="select-content"
          data-trigger-style={local.triggerVariant}
        >
          <Kobalte.Listbox data-slot="select-select-content-list" />
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}
