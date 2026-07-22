import { createSignal, type JSX } from "solid-js"
import { Popover as KobaltePopover } from "@kobalte/core/popover"
import { Icon } from "@novaclaw/ui/icon"
import { Switch as SwitchToggle } from "@novaclaw/ui/v2/switch-v2"
import { TooltipV2 } from "@novaclaw/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"

export type ComposerFeature = "introspection" | "quality" | "affective"
export type ComposerMode = "interactive" | "auto-prompting" | "goal-oriented"

export type ComposerFeaturesControlState = {
  current: Record<ComposerFeature, boolean>
  mode: ComposerMode
  style: JSX.CSSProperties | undefined
  set: (feature: ComposerFeature, enabled: boolean) => void
  setMode: (value: ComposerMode) => void
  onClose: () => void
}

const COMPOSER_FEATURES: readonly ComposerFeature[] = ["introspection", "quality", "affective"]
const COMPOSER_MODES: readonly ComposerMode[] = ["interactive", "auto-prompting", "goal-oriented"]

/**
 * The per-chat Tuning control (T1, Advanced+): the chat's Mode (kernel thread type — interactive
 * vs the unattended pair, architecture.md typed threads) plus one switch per harness helper —
 * the stuck detector (introspection), quality gates, and mood sampling (affective). Each control
 * shows the EFFECTIVE stance (this chat's override, else the global Settings default) and a flip
 * writes the per-chat override; the helpers' internals stay in Settings.
 */
export function ComposerFeaturesControl(props: { state: ComposerFeaturesControlState }) {
  const language = useLanguage()
  const [open, setOpen] = createSignal(false)
  const enabledCount = () => COMPOSER_FEATURES.filter((feature) => props.state.current[feature]).length
  const unattended = () => props.state.mode !== "interactive"
  const triggerSuffix = () => {
    const parts: string[] = []
    if (unattended())
      parts.push(language.t(`prompt.mode.short.${props.state.mode}` as Parameters<typeof language.t>[0]))
    if (enabledCount() > 0) parts.push(String(enabledCount()))
    return parts.length ? ` · ${parts.join(" · ")}` : ""
  }
  const close = () => {
    setOpen(false)
    props.state.onClose()
  }
  return (
    <KobaltePopover open={open()} onOpenChange={setOpen} modal={false} placement="top-start" gutter={4}>
      <TooltipV2 placement="top" gutter={4} value={language.t("prompt.features.tooltip")}>
        <KobaltePopover.Trigger
          type="button"
          data-action="prompt-features"
          data-enabled-count={enabledCount() || undefined}
          data-mode={unattended() ? props.state.mode : undefined}
          class="flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] font-[440] leading-5 hover:bg-v2-background-bg-subtle"
          classList={{
            "text-v2-text-text-faint": enabledCount() === 0 && !unattended(),
            "text-v2-text-text-base": enabledCount() > 0 || unattended(),
          }}
          style={props.state.style}
        >
          <Icon
            name="sliders"
            size="small"
            class={enabledCount() > 0 || unattended() ? "text-v2-icon-icon-base" : "text-v2-icon-icon-muted"}
          />
          <span>
            {language.t("prompt.features.label")}
            {triggerSuffix()}
          </span>
        </KobaltePopover.Trigger>
      </TooltipV2>
      <KobaltePopover.Portal>
        <KobaltePopover.Content
          data-component="prompt-features-popover"
          class="w-80 flex flex-col gap-3 p-4 rounded-md border border-border-base bg-surface-raised-stronger-non-alpha shadow-md z-50 outline-none"
          onEscapeKeyDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
            close()
          }}
          onPointerDownOutside={() => setOpen(false)}
        >
          <div class="flex flex-col gap-1">
            <span class="text-[13px] font-[560] text-v2-text-text-base">
              {language.t("prompt.features.popover.title")}
            </span>
            <span class="text-[12px] leading-4 text-v2-text-text-faint">
              {language.t("prompt.features.popover.description")}
            </span>
          </div>
          {/* The chat's Mode — plain radio rows (a Kobalte Select re-emits onChange; see the
              per-session-toggle template notes), and the unattended options explain their
              guardrails inline so the switch teaches what it does. */}
          <div class="flex flex-col gap-1.5" data-section="mode">
            <span class="text-[13px] font-[560] text-v2-text-text-base">{language.t("prompt.mode.title")}</span>
            <div role="radiogroup" aria-label={language.t("prompt.mode.title")} class="flex flex-col gap-1">
              {COMPOSER_MODES.map((mode) => (
                <button
                  type="button"
                  role="radio"
                  data-mode-option={mode}
                  aria-checked={props.state.mode === mode}
                  onClick={() => props.state.setMode(mode)}
                  class="flex items-start justify-between gap-3 rounded-md border px-2.5 py-1.5 text-left hover:bg-v2-background-bg-subtle"
                  classList={{
                    "border-v2-border-border-focus bg-v2-background-bg-layer-01": props.state.mode === mode,
                    "border-transparent": props.state.mode !== mode,
                  }}
                >
                  <span class="flex flex-col gap-0.5">
                    <span class="text-[13px] text-v2-text-text-base">
                      {language.t(`prompt.mode.${mode}.title` as Parameters<typeof language.t>[0])}
                    </span>
                    <span class="text-[12px] leading-4 text-v2-text-text-faint">
                      {language.t(`prompt.mode.${mode}.description` as Parameters<typeof language.t>[0])}
                    </span>
                  </span>
                  {props.state.mode === mode && (
                    <Icon name="check" size="small" class="mt-0.5 shrink-0 text-v2-icon-icon-accent" />
                  )}
                </button>
              ))}
            </div>
          </div>
          {COMPOSER_FEATURES.map((feature) => (
            <div class="flex items-start justify-between gap-3" data-feature={feature}>
              <div class="flex flex-col gap-0.5">
                <span class="text-[13px] text-v2-text-text-base">
                  {language.t(`prompt.features.${feature}.title` as Parameters<typeof language.t>[0])}
                </span>
                <span class="text-[12px] leading-4 text-v2-text-text-faint">
                  {language.t(`prompt.features.${feature}.description` as Parameters<typeof language.t>[0])}
                </span>
              </div>
              <SwitchToggle
                checked={props.state.current[feature]}
                onChange={(checked) => props.state.set(feature, checked)}
                hideLabel
              >
                {language.t(`prompt.features.${feature}.title` as Parameters<typeof language.t>[0])}
              </SwitchToggle>
            </div>
          ))}
        </KobaltePopover.Content>
      </KobaltePopover.Portal>
    </KobaltePopover>
  )
}
