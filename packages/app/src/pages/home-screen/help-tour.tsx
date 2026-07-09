import { Component, type ComponentProps, createSignal, For, Show } from "solid-js"
import { Dialog } from "@novaclaw/ui/v2/dialog-v2"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { Icon } from "@novaclaw/ui/icon"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { useLanguage } from "@/context/language"

// First-run tour of NovaClaw — a friendly, plain-language intro for new users. Auto-opened once by the
// home screen (guarded by HELP_SEEN_KEY) and reopenable anytime from the Help app tile. Deliberately
// non-technical: no "sessions", "tokens", or "spawn" jargon on the surface. The steps double as the
// capability catalog — each one teaches something the user can actually do next. Strings are i18n'd
// (O4); the "Set up your models" step points to Settings, the bootstrap pillar a new user needs (O3).
export const HELP_SEEN_KEY = "novaclaw.help.seen"

type Step = {
  readonly icon: string
  readonly accent: string
  readonly glyphTone?: "light" | "dark" // "dark" for light accents (gold), same vocabulary as HomeApp
  readonly image?: string // when set, the badge shows this image (e.g. the logo) instead of an icon
  readonly key: string // i18n key stem: help.tour.step.<key>.title / .body
}

const STEPS: readonly Step[] = [
  { icon: "speech-bubble", accent: "#e7b62f", glyphTone: "dark", key: "welcome" },
  { icon: "dot-grid", accent: "#8b5cf6", key: "apps" },
  { icon: "grid-plus", accent: "#a78bfa", image: "/logo.png", key: "home" },
  { icon: "brain", accent: "#22d3ee", key: "chat" },
  { icon: "plus", accent: "#34d399", key: "build" },
  { icon: "settings-gear", accent: "#8d8fa6", key: "settings" },
  { icon: "shield", accent: "#3b82f6", key: "data" },
  { icon: "check", accent: "#8b5cf6", key: "done" },
]

export const HelpTour: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const [i, setI] = createSignal(0)
  const step = () => STEPS[i()]!
  const last = () => i() === STEPS.length - 1
  const title = () => language.t(`help.tour.step.${step().key}.title` as Parameters<typeof language.t>[0])
  const body = () => language.t(`help.tour.step.${step().key}.body` as Parameters<typeof language.t>[0])

  return (
    <Dialog size="content">
      <div class="flex flex-col items-center gap-5 px-8 py-10 min-w-[24rem] max-w-[30rem] text-center">
        <Show
          when={step().image}
          fallback={
            <div
              class="flex items-center justify-center size-[4.5rem] rounded-[1.375rem] shadow-[var(--v2-elevation-floating)] ring-1 ring-white/15"
              style={{
                "background-image": `linear-gradient(155deg, color-mix(in oklab, ${step().accent} 88%, white) -8%, ${step().accent} 42%, color-mix(in oklab, ${step().accent} 58%, black) 105%)`,
                "--icon-base":
                  step().glyphTone === "dark"
                    ? "color-mix(in srgb, var(--nc-ink, #1a1135) 92%, transparent)"
                    : "rgba(255,255,255,0.96)",
              }}
            >
              <Icon name={step().icon as ComponentProps<typeof Icon>["name"]} size="2xl" />
            </div>
          }
        >
          {(image) => (
            <div class="flex size-[4.5rem] items-center justify-center rounded-[1.375rem] bg-v2-background-bg-layer-02 shadow-[var(--v2-elevation-floating)] ring-1 ring-white/15">
              <img src={image()} alt="" draggable={false} class="size-14 select-none" />
            </div>
          )}
        </Show>
        {/* min-h fits the tallest step so the card keeps ONE size across the tour — the Next
            button must not hop under the cursor between steps. */}
        <div class="flex flex-col gap-2 min-h-[8rem]">
          <span class="text-[17px] font-semibold text-v2-text-text-base">{title()}</span>
          <span class="text-sm text-v2-text-text-muted leading-relaxed">{body()}</span>
        </div>
        <div class="flex items-center gap-1.5 pt-1">
          <For each={STEPS}>
            {(_, d) => (
              <div
                class="size-1.5 rounded-full transition-all"
                classList={{ "bg-v2-text-text-accent scale-125": d() === i(), "bg-v2-border-border-strong": d() !== i() }}
              />
            )}
          </For>
        </div>
        <div class="flex items-center justify-between w-full gap-3 pt-1">
          <button
            type="button"
            class="text-sm font-medium text-v2-text-text-faint px-2 py-1.5 rounded-lg transition-colors hover:text-v2-text-text-muted"
            onClick={() => dialog.close()}
          >
            {language.t("help.tour.skip")}
          </button>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="text-sm font-medium text-v2-text-text-muted px-3 py-1.5 rounded-lg transition-colors hover:bg-v2-background-bg-layer-02 disabled:opacity-40 disabled:pointer-events-none"
              onClick={() => setI(Math.max(0, i() - 1))}
              disabled={i() === 0}
            >
              {language.t("help.tour.back")}
            </button>
            <ButtonV2
              variant="gold"
              size="normal"
              class="px-4"
              onClick={() => (last() ? dialog.close() : setI(i() + 1))}
            >
              {last() ? language.t("help.tour.getStarted") : language.t("help.tour.next")}
            </ButtonV2>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
