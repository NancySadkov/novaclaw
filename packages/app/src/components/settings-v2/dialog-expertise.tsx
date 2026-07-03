import { Component, For, Show, createSignal, type ComponentProps } from "solid-js"
import { Dialog } from "@novaclaw/ui/v2/dialog-v2"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { Icon } from "@novaclaw/ui/icon"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useExpertise } from "@/context/expertise"
import { EXPERTISE_ORDER, type ExpertiseLevel } from "@/context/settings"

// The unlock UX (uix.md §6.2). Three cards, friendliest first; the current level is badged. Choosing a
// HIGHER level shows plain-language consequences + a confirm — and escalating to Developer requires
// typing the word (arm-to-confirm, mirroring Recovery), auto-skipped on the dev channel. Downgrades are
// a single click with a note that advanced settings stay saved (hiding is pure render-gating).
type LevelCard = {
  readonly level: ExpertiseLevel
  readonly icon: ComponentProps<typeof Icon>["name"]
  readonly accent: string // cool hue — gold stays reserved for the Chats hero
}

const CARDS: readonly LevelCard[] = [
  { level: "normal", icon: "speech-bubble", accent: "#8b5cf6" },
  { level: "advanced", icon: "sliders", accent: "#3b82f6" },
  { level: "developer", icon: "code-lines", accent: "#64748b" },
]

const DEV_CONFIRM_WORD = "developer"

export const DialogExpertise: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const { level, setLevel } = useExpertise()

  // The level whose confirmation panel is open (undefined = the three-card chooser).
  const [pending, setPending] = createSignal<ExpertiseLevel>()
  const [typed, setTyped] = createSignal("")

  const isEscalation = (target: ExpertiseLevel) => EXPERTISE_ORDER[target] > EXPERTISE_ORDER[level()]
  const devChannel = import.meta.env.VITE_NOVACLAW_CHANNEL === "dev"
  const needsType = (target: ExpertiseLevel) => target === "developer" && isEscalation(target) && !devChannel

  const choose = (target: ExpertiseLevel) => {
    if (target === level()) return
    setTyped("")
    setPending(target)
  }

  const confirm = (target: ExpertiseLevel) => {
    if (needsType(target) && typed().trim().toLowerCase() !== DEV_CONFIRM_WORD) return
    setLevel(target)
    dialog.close()
  }

  const actionLabel = (target: ExpertiseLevel) => {
    if (target === level()) return language.t("settings.expertise.current")
    return isEscalation(target)
      ? language.t("settings.expertise.action.unlock", { level: language.t(`settings.expertise.level.${target}.name`) })
      : language.t("settings.expertise.action.switch", { level: language.t(`settings.expertise.level.${target}.name`) })
  }

  const confirmBody = (target: ExpertiseLevel) => {
    if (!isEscalation(target)) return language.t("settings.expertise.confirm.downgrade")
    return target === "developer"
      ? language.t("settings.expertise.confirm.developer")
      : language.t("settings.expertise.confirm.advanced")
  }

  return (
    <Dialog size="content">
      <div class="flex flex-col gap-5 px-8 py-8 min-w-[26rem] max-w-[32rem]">
        <div class="flex flex-col gap-1 text-center">
          <span class="text-[17px] font-semibold text-v2-text-text-base">{language.t("settings.expertise.title")}</span>
          <span class="text-[13px] font-medium text-v2-text-text-muted">
            {language.t("settings.expertise.description")}
          </span>
        </div>

        <Show
          when={pending()}
          fallback={
            <div class="flex flex-col gap-2.5">
              <For each={CARDS}>
                {(card) => (
                  <div
                    class="flex items-center gap-3.5 rounded-2xl p-3.5 ring-1 transition-colors"
                    classList={{
                      "ring-v2-text-text-accent bg-v2-background-bg-layer-02": card.level === level(),
                      "ring-v2-border-border-base": card.level !== level(),
                    }}
                  >
                    <div
                      class="flex items-center justify-center size-11 shrink-0 rounded-[0.9rem] ring-1 ring-white/15"
                      style={{
                        "background-image": `linear-gradient(155deg, color-mix(in oklab, ${card.accent} 88%, white) -8%, ${card.accent} 42%, color-mix(in oklab, ${card.accent} 58%, black) 105%)`,
                        "--icon-base": "rgba(255,255,255,0.96)",
                      }}
                    >
                      <Icon name={card.icon} size="large" />
                    </div>
                    <div class="flex flex-col gap-0.5 min-w-0 flex-1">
                      <span class="text-sm font-semibold text-v2-text-text-base">
                        {language.t(`settings.expertise.level.${card.level}.name`)}
                      </span>
                      <span class="text-[12px] text-v2-text-text-muted leading-snug">
                        {language.t(`settings.expertise.level.${card.level}.blurb`)}
                      </span>
                    </div>
                    <Show
                      when={card.level !== level()}
                      fallback={
                        <span class="text-[11px] font-medium text-v2-text-text-accent shrink-0 px-2">
                          {language.t("settings.expertise.current")}
                        </span>
                      }
                    >
                      <ButtonV2 size="small" variant="neutral" class="shrink-0" onClick={() => choose(card.level)}>
                        {actionLabel(card.level)}
                      </ButtonV2>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          }
        >
          {(target) => (
            <div class="flex flex-col gap-4">
              <p class="text-sm text-v2-text-text-muted leading-relaxed">{confirmBody(target())}</p>
              <Show when={needsType(target())}>
                <div class="flex flex-col gap-1.5">
                  <label class="text-[12px] font-medium text-v2-text-text-faint">
                    {language.t("settings.expertise.confirm.typePrompt", { word: DEV_CONFIRM_WORD })}
                  </label>
                  <TextInputV2
                    type="text"
                    appearance="base"
                    autofocus
                    value={typed()}
                    onInput={(event) => setTyped(event.currentTarget.value)}
                    placeholder={DEV_CONFIRM_WORD}
                    spellcheck={false}
                    autocorrect="off"
                    autocomplete="off"
                    autocapitalize="off"
                  />
                </div>
              </Show>
              <div class="flex items-center justify-end gap-2 pt-1">
                <ButtonV2 size="normal" variant="ghost-muted" onClick={() => setPending(undefined)}>
                  {language.t("settings.expertise.cancel")}
                </ButtonV2>
                <ButtonV2
                  size="normal"
                  variant={isEscalation(target()) ? "gold" : "neutral"}
                  disabled={needsType(target()) && typed().trim().toLowerCase() !== DEV_CONFIRM_WORD}
                  onClick={() => confirm(target())}
                >
                  {language.t("settings.expertise.confirm.cta")}
                </ButtonV2>
              </div>
            </div>
          )}
        </Show>
      </div>
    </Dialog>
  )
}
