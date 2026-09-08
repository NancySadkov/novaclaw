import { Component, For, Show } from "solid-js"
import { Dialog } from "@novaclaw/ui/v2/dialog-v2"
import { Icon } from "@novaclaw/ui/v2/icon"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { TIERS } from "@/apps/agent-model"
import type { ModelTier } from "@/context/models"

// The capability-tier picker as a MODAL (uix.md — phone-friendly, and the rich per-tier blurbs need
// room a droplist can't give without rendering the description over the label). Coarsest→finest by
// parameter count; "guess" lets NovaClaw estimate it later (notes/guesstimation.md). Picking a card
// commits immediately and closes — same one-tap pattern as the expertise dialog.
//
// ⚠️ The ORDER is `AgentModelFit.LADDER` and is not re-spelled here: this copy used to be the one
// nothing pinned, so a tier added to the schema and to the config dialog still could not be picked
// from this screen. `"guess"` is this picker's own addition and the only part it owns.
const TIER_CARDS: readonly ModelTier[] = ["guess", ...TIERS]

export const DialogModelTier: Component<{
  modelName: string
  current: ModelTier
  onSelect: (tier: ModelTier) => void
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()

  const pick = (tier: ModelTier) => {
    props.onSelect(tier)
    dialog.close()
  }

  return (
    <Dialog size="content">
      <div class="flex w-[min(32rem,calc(100vw-32px))] max-w-full flex-col gap-4 px-7 py-7">
        <div class="flex flex-col gap-1 text-center">
          <span class="text-[17px] font-semibold text-v2-text-text-base">
            {language.t("settings.models.tier.dialog.title")}
          </span>
          <span class="text-[13px] font-medium text-v2-text-text-muted">
            {language.t("settings.models.tier.dialog.description", { model: props.modelName })}
          </span>
        </div>

        <div class="-mx-1 flex max-h-[60vh] flex-col gap-2 overflow-y-auto overflow-x-hidden px-1">
          <For each={TIER_CARDS}>
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
                    {language.t(`settings.models.tier.${tier}.name`)}
                  </span>
                  <span class="text-[11px] font-medium text-v2-text-text-faint rounded-full ring-1 ring-v2-border-border-base px-2 py-0.5">
                    {language.t(`settings.models.tier.${tier}.range`)}
                  </span>
                  <Show when={tier === props.current}>
                    <Icon name="check" size="normal" class="ml-auto text-v2-icon-icon-accent" />
                  </Show>
                </div>
                <span class="text-[12px] text-v2-text-text-muted leading-snug">
                  {language.t(`settings.models.tier.${tier}.blurb`)}
                </span>
              </button>
            )}
          </For>
        </div>
      </div>
    </Dialog>
  )
}
