import { Component, For, Show } from "solid-js"
import { Dialog } from "@novaclaw/ui/v2/dialog-v2"
import { Icon } from "@novaclaw/ui/icon"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { useLanguage } from "@/context/language"
import type { ModelTier } from "@/context/models"

// The capability-tier picker as a MODAL (uix.md — phone-friendly, and the rich per-tier blurbs need
// room a droplist can't give without rendering the description over the label). Coarsest→finest by
// parameter count; "guess" lets NovaClaw estimate it later (notes/guesstimation.md). Picking a card
// commits immediately and closes — same one-tap pattern as the expertise dialog.
const TIERS: readonly ModelTier[] = ["guess", "micro", "tiny", "small", "medium", "large", "frontier"]

export const DialogModelTier: Component<{
  modelName: string
  current: ModelTier
  onSelect: (tier: ModelTier) => void
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  // Dynamic tier i18n keys need the loose-key cast the typed translator otherwise forbids.
  const tk = (key: string) => language.t(key as Parameters<typeof language.t>[0])

  const pick = (tier: ModelTier) => {
    props.onSelect(tier)
    dialog.close()
  }

  return (
    <Dialog size="content">
      <div class="flex flex-col gap-4 px-7 py-7 min-w-[20rem] max-w-[32rem]">
        <div class="flex flex-col gap-1 text-center">
          <span class="text-[17px] font-semibold text-v2-text-text-base">
            {language.t("settings.models.tier.dialog.title")}
          </span>
          <span class="text-[13px] font-medium text-v2-text-text-muted">
            {language.t("settings.models.tier.dialog.description", { model: props.modelName })}
          </span>
        </div>

        <div class="flex flex-col gap-2 max-h-[60vh] overflow-y-auto -mx-1 px-1">
          <For each={TIERS}>
            {(tier) => (
              <button
                type="button"
                class="flex flex-col gap-1 rounded-2xl p-3.5 text-left ring-1 transition-colors"
                classList={{
                  "ring-v2-text-text-accent bg-v2-background-bg-layer-02": tier === props.current,
                  "ring-v2-border-border-base hover:bg-v2-background-bg-layer-01": tier !== props.current,
                }}
                aria-pressed={tier === props.current}
                onClick={() => pick(tier)}
              >
                <div class="flex items-center gap-2">
                  <span class="text-sm font-semibold text-v2-text-text-base">
                    {tk(`settings.models.tier.${tier}.name`)}
                  </span>
                  <span class="text-[11px] font-medium text-v2-text-text-faint rounded-full ring-1 ring-v2-border-border-base px-2 py-0.5">
                    {tk(`settings.models.tier.${tier}.range`)}
                  </span>
                  <Show when={tier === props.current}>
                    <Icon name="check" size="small" class="ml-auto text-v2-icon-icon-accent" />
                  </Show>
                </div>
                <span class="text-[12px] text-v2-text-text-muted leading-snug">
                  {tk(`settings.models.tier.${tier}.blurb`)}
                </span>
              </button>
            )}
          </For>
        </div>
      </div>
    </Dialog>
  )
}
