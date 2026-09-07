import { Icon, type IconProps } from "@novaclaw/ui/v2/icon"
import { ToastV2, showToastV2 } from "@novaclaw/ui/v2/toast-v2"
import { recordToastHistory } from "./toast-history"

/**
 * The app's one toast surface. It is a *facade*, not a fork: it exists because callers name an icon
 * by NAME (`icon: "circle-check"`) while `showToastV2` takes rendered JSX, and because `variant` is
 * app semantics (success/error) rather than a v2 design-system prop.
 *
 * ⚠️ This module used to hold a runtime v1/v2 SWITCH — a module-level `v2` flag flipped by
 * `setV2Toast(true)` from an effect in `pages/layout-new.tsx`, with `showToast` routing to the v1
 * `@novaclaw/ui/toast` until it flipped. The v1 leg was already unreachable-by-design: the only
 * `<ToastRegion>` in the tree was rendered as `<ToastRegion v2 />`, so `<Toast.Region />` never
 * mounted. Both sides shared the SAME Kobalte `toaster` singleton, so any toast fired before that
 * effect ran — or from `wsl/dialog-add-server.tsx`, which imported the v1 `showToast` DIRECTLY and
 * unconditionally — rendered v1 markup (`data-component="toast"`) inside the v2 region, styled by a
 * sheet written for a region that was not there. Deleted with the v1 component (ruling 13).
 */
export type ToastVariant = "default" | "success" | "error" | "loading"

export interface ToastAction {
  label: string
  onClick: "dismiss" | (() => void)
}

export interface ToastOptions {
  title?: string
  description?: string
  icon?: IconProps["name"]
  variant?: ToastVariant
  duration?: number
  persistent?: boolean
  actions?: ToastAction[]
}

export const DEFAULT_TOAST_DURATION_MS = 7_000

export function resolveToastLifetime(options: Pick<ToastOptions, "duration" | "persistent" | "variant">) {
  const persistent = options.persistent ?? options.variant === "loading"
  return {
    persistent,
    duration: options.duration ?? DEFAULT_TOAST_DURATION_MS,
  }
}

export function ToastRegion() {
  return <ToastV2.Region />
}

export function showToast(options: ToastOptions | string) {
  const normalized: ToastOptions = typeof options === "string" ? { description: options } : options
  const lifetime = resolveToastLifetime(normalized)
  recordToastHistory({
    title: normalized.title,
    description: normalized.description,
    variant: normalized.variant ?? "default",
    time: Date.now(),
  })

  return showToastV2({
    ...normalized,
    ...lifetime,
    icon: resolveIcon(normalized.icon, normalized.variant),
    actions: normalized.actions?.map((action) => ({
      ...action,
      variant: action.onClick === "dismiss" ? "secondary" : "primary",
    })),
  })
}

function resolveIcon(icon: IconProps["name"] | undefined, variant: ToastVariant | undefined) {
  const name = icon ?? (variant === "success" ? "check" : undefined)
  if (!name) return
  return <Icon name={name} size="large" />
}
