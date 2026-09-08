import { Tabs as Kobalte } from "@kobalte/core/tabs"
import { Show, splitProps, type JSX } from "solid-js"
import { useI18n } from "../../context/i18n"
import type { ComponentProps, ParentProps, Component } from "solid-js"

export interface TabsV2Props extends ComponentProps<typeof Kobalte> {
  variant?: "normal" | "pill" | "settings"
  orientation?: "horizontal" | "vertical"
}
export interface TabsV2ListProps extends ComponentProps<typeof Kobalte.List> {}
export interface TabsV2TriggerProps extends ComponentProps<typeof Kobalte.Trigger> {
  onMiddleClick?: () => void
  /**
   * A per-tab close affordance, rendered as a SIBLING of the trigger inside the wrapper — never as a
   * child of it, because a button nested in a button is invalid HTML and swallows the outer click.
   * Mirrors v1 `tabs.tsx`'s slot exactly, and lands on the `tabs-v2-close-button` styling this
   * component's CSS already carries. Added so a v1 call site with closeable tabs has somewhere to
   * migrate TO — the fork ledger cannot shrink past a widget whose v2 twin lacks the capability.
   */
  closeButton?: JSX.Element
  /** Optional subtext shown beside the primary content (muted style) */
  subtext?: JSX.Element | string
}
export interface TabsV2CloseButtonProps extends ComponentProps<"div"> {}
export interface TabsV2ContentProps extends ComponentProps<typeof Kobalte.Content> {}

function TabsV2Root(props: TabsV2Props) {
  const [split, rest] = splitProps(props, ["class", "classList", "variant", "orientation"])
  return (
    <Kobalte
      {...rest}
      orientation={split.orientation}
      data-component="tabs-v2"
      data-variant={split.variant || "normal"}
      data-orientation={split.orientation || "horizontal"}
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    />
  )
}

function TabsV2List(props: TabsV2ListProps) {
  const [split, rest] = splitProps(props, ["class", "classList"])
  return (
    <Kobalte.List
      {...rest}
      data-slot="tabs-v2-list"
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    />
  )
}

function TabsV2Trigger(props: ParentProps<TabsV2TriggerProps>) {
  const [split, rest] = splitProps(props, ["class", "classList", "children", "onMiddleClick", "closeButton", "subtext"])
  return (
    <div
      data-slot="tabs-v2-trigger-wrapper"
      data-value={props.value}
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
      onMouseDown={(e) => {
        if (e.button === 1 && split.onMiddleClick) {
          e.preventDefault()
        }
      }}
      onAuxClick={(e) => {
        if (e.button === 1 && split.onMiddleClick) {
          e.preventDefault()
          split.onMiddleClick()
        }
      }}
    >
      <Kobalte.Trigger {...rest} data-slot="tabs-v2-trigger" data-value={props.value}>
        <span class="inline-flex items-center gap-2" data-slot="tabs-v2-trigger-content">
          {split.children}
          <Show when={split.subtext}>
            {(subtext) => (
              <span data-slot="tabs-v2-subtext" class="ml-2 text-xs text-text-weak">
                {subtext()}
              </span>
            )}
          </Show>
        </span>
      </Kobalte.Trigger>
      <Show when={split.closeButton}>{(closeButton) => closeButton()}</Show>
    </div>
  )
}

function TabsV2CloseButton(props: TabsV2CloseButtonProps) {
  const [split, rest] = splitProps(props, ["class", "classList", "onClick"])
  const i18n = useI18n()
  return (
    <div
      role="button"
      tabindex={0}
      aria-label={i18n.t("ui.tabs.close")}
      data-slot="tabs-v2-close-button"
      {...rest}
      classList={{
        [split.class ?? ""]: !!split.class,
        ...split.classList,
      }}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        if (typeof split.onClick === "function") {
          split.onClick(e)
        }
      }}
      onMouseDown={(e) => {
        e.preventDefault()
        e.stopPropagation()
      }}
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M10.8889 3.11108L3.11108 10.8889" stroke="currentColor" stroke-linejoin="round" />
        <path d="M3.11108 3.11108L10.8889 10.8889" stroke="currentColor" stroke-linejoin="round" />
      </svg>
    </div>
  )
}

function TabsV2Content(props: ParentProps<TabsV2ContentProps>) {
  const [split, rest] = splitProps(props, ["class", "classList", "children"])
  return (
    <Kobalte.Content
      {...rest}
      data-slot="tabs-v2-content"
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    >
      {split.children}
    </Kobalte.Content>
  )
}

const TabsV2SectionTitle: Component<ParentProps> = (props) => {
  return <div data-slot="tabs-v2-section-title">{props.children}</div>
}

export const TabsV2 = Object.assign(TabsV2Root, {
  List: TabsV2List,
  Trigger: TabsV2Trigger,
  CloseButton: TabsV2CloseButton,
  Content: TabsV2Content,
  SectionTitle: TabsV2SectionTitle,
})
