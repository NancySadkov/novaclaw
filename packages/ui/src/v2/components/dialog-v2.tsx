import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { type ComponentProps, type JSXElement, type ParentProps, Show, children, splitProps } from "solid-js"
import { useI18n } from "../../context/i18n"

export interface DialogProps extends ParentProps {
  /** "content" hugs the children in BOTH axes and centers them (tour/placeholder-style cards);
   *  the other sizes are fixed boxes. `fit` only relaxes height and keeps the fixed width. */
  size?: "normal" | "large" | "x-large" | "content" | "full"
  variant?: "default" | "settings"
  class?: ComponentProps<"div">["class"]
  classList?: ComponentProps<"div">["classList"]
  fit?: boolean
}

export interface DialogHeaderProps extends ParentProps {
  /**
   * Accessible name of the close button. Defaults to the localized `ui.common.close`.
   *
   * ⚠️ It used to default to the literal string `"Close"`, which shipped an English-only accessible
   * name on every v2 dialog that renders a close button — the project/file picker
   * (`dialog-select-directory-v2.tsx`) among them — while the v1 `Dialog` it replaces had localized
   * the same button since it was written. Found while migrating v1's nine call sites here
   * (2026-08-08); the migration would otherwise have carried eight more dialogs into the defect.
   */
  closeLabel?: string
  hideClose?: boolean
}

export interface DialogTitleGroupProps {
  title?: JSXElement
  description: JSXElement
}

export function DialogFooter(props: ParentProps) {
  return <div data-slot="dialog-footer">{props.children}</div>
}

export function DialogBody(props: ParentProps & { class?: ComponentProps<"div">["class"] }) {
  const [local] = splitProps(props, ["class", "children"])
  return (
    <div data-slot="dialog-body" class={local.class}>
      {local.children}
    </div>
  )
}

export function DialogTitle(props: ParentProps) {
  return <Kobalte.Title data-slot="dialog-header-title">{props.children}</Kobalte.Title>
}

export function DialogTitleGroup(props: DialogTitleGroupProps) {
  const title = children(() => props.title)
  const description = children(() => props.description)

  return (
    <div data-slot="dialog-title-group">
      <Show when={title()}>{(t) => <Kobalte.Title data-slot="dialog-title">{t()}</Kobalte.Title>}</Show>
      <Kobalte.Description data-slot="dialog-description">{description()}</Kobalte.Description>
    </div>
  )
}

export function DialogHeader(props: DialogHeaderProps) {
  const i18n = useI18n()
  const [local] = splitProps(props, ["closeLabel", "hideClose", "children"])
  const hideClose = () => local.hideClose === true

  return (
    <div data-slot="dialog-header" data-hide-close={hideClose() ? "" : undefined}>
      {local.children}
      {!hideClose() && (
        <Kobalte.CloseButton data-slot="dialog-close-button" aria-label={local.closeLabel ?? i18n.t("ui.common.close")}>
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            aria-hidden="true"
          >
            <path
              d="M12.4446 3.55469L3.55566 12.4436M3.55566 3.55469L12.4446 12.4436"
              stroke="currentColor"
              stroke-linejoin="round"
            />
          </svg>
        </Kobalte.CloseButton>
      )}
    </div>
  )
}

export function Dialog(props: DialogProps) {
  const [local] = splitProps(props, ["size", "variant", "class", "classList", "fit", "children"])

  return (
    <div
      data-component="dialog-v2"
      data-variant={local.variant === "settings" ? "settings" : undefined}
      data-fit={local.fit ? true : undefined}
      data-size={local.size || "normal"}
    >
      <div data-slot="dialog-container">
        <Kobalte.Content
          data-slot="dialog-content"
          classList={{
            ...local.classList,
            [local.class ?? ""]: !!local.class,
          }}
          onOpenAutoFocus={(e) => {
            const target = e.currentTarget as HTMLElement | null
            const autofocusEl = target?.querySelector("[autofocus]") as HTMLElement | null
            if (autofocusEl) {
              e.preventDefault()
              autofocusEl.focus()
            }
          }}
        >
          {local.children}
        </Kobalte.Content>
      </div>
    </div>
  )
}

export const DialogV2 = Dialog
