import { Component, type ComponentProps, createSignal, For } from "solid-js"
import { Dialog } from "@novaclaw/ui/v2/dialog-v2"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { Icon } from "@novaclaw/ui/icon"
import { useDialog } from "@novaclaw/ui/context/dialog"

// First-run tour of NovaClaw — a friendly, plain-language intro for new users. Auto-opened once by the
// home screen (guarded by HELP_SEEN_KEY) and reopenable anytime from the Help app tile. Deliberately
// non-technical: no "sessions", "tokens", or "spawn" jargon on the surface. The steps double as the
// capability catalog — each one teaches something the user can actually do next.
export const HELP_SEEN_KEY = "novaclaw.help.seen"

type Step = {
  readonly icon: string
  readonly accent: string
  readonly glyphTone?: "light" | "dark" // "dark" for light accents (gold), same vocabulary as HomeApp
  readonly title: string
  readonly body: string
}

const STEPS: readonly Step[] = [
  {
    icon: "speech-bubble",
    accent: "#e7b62f",
    glyphTone: "dark",
    title: "Welcome to NovaClaw",
    body: "Your private AI workspace — an operating system where AI helpers work for you like apps. It runs on your own hardware, so your conversations and data stay with you.",
  },
  {
    icon: "dot-grid",
    accent: "#8b5cf6",
    title: "A home screen of apps",
    body: "Tap a tile to open an app. The big gold tile is Chats — that's where everything starts. Notes keeps your everyday things, Files lets AI work on your folders, and Processes shows what the AI is doing right now.",
  },
  {
    icon: "brain",
    accent: "#22d3ee",
    title: "Chat, and let AI help",
    body: "A helper can break a big job into smaller ones, use tools on your behalf, and hand back the result. It can even draw charts and small visualizations right inside the chat — not just text.",
  },
  {
    icon: "plus",
    accent: "#34d399",
    title: "Ask for your own apps",
    body: "Want something this screen doesn't have? Just ask — “make me a stock prices app on the home screen” — and a helper builds it and pins it as a new tile.",
  },
  {
    icon: "shield",
    accent: "#3b82f6",
    title: "Your data is yours — and safe",
    body: "Notes are shared with your AI helpers so they know your context. When AI edits or removes files, deletions go to a Trash you can restore from — nothing is lost by accident.",
  },
  {
    icon: "check",
    accent: "#f472b6",
    title: "You're all set",
    body: "Open Chats and say hi. Hover any tile for a hint of what it does, and reopen this tour anytime from the Help app.",
  },
]

export const HelpTour: Component = () => {
  const dialog = useDialog()
  const [i, setI] = createSignal(0)
  const step = () => STEPS[i()]!
  const last = () => i() === STEPS.length - 1

  return (
    <Dialog size="content">
      <div class="flex flex-col items-center gap-5 px-8 py-10 min-w-[24rem] max-w-[30rem] text-center">
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
        {/* min-h fits the tallest step so the card keeps ONE size across the tour — the Next
            button must not hop under the cursor between steps. */}
        <div class="flex flex-col gap-2 min-h-[8rem]">
          <span class="text-[17px] font-semibold text-v2-text-text-base">{step().title}</span>
          <span class="text-sm text-v2-text-text-muted leading-relaxed">{step().body}</span>
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
            Skip
          </button>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="text-sm font-medium text-v2-text-text-muted px-3 py-1.5 rounded-lg transition-colors hover:bg-v2-background-bg-layer-02 disabled:opacity-40 disabled:pointer-events-none"
              onClick={() => setI(Math.max(0, i() - 1))}
              disabled={i() === 0}
            >
              Back
            </button>
            <ButtonV2
              variant="gold"
              size="normal"
              class="px-4"
              onClick={() => (last() ? dialog.close() : setI(i() + 1))}
            >
              {last() ? "Get started" : "Next"}
            </ButtonV2>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
