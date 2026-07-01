import { Component, type ComponentProps, createSignal, For } from "solid-js"
import { Dialog } from "@opencode-ai/ui/v2/dialog-v2"
import { Icon } from "@opencode-ai/ui/icon"
import { useDialog } from "@opencode-ai/ui/context/dialog"

// First-run tour of NovaClaw — a friendly, plain-language intro for new users. Auto-opened once by the
// home screen (guarded by HELP_SEEN_KEY) and reopenable anytime from the Help app tile. Deliberately
// non-technical: no "sessions", "tokens", or "spawn" jargon on the surface.
export const HELP_SEEN_KEY = "novaclaw.help.seen"

type Step = { readonly icon: string; readonly accent: string; readonly title: string; readonly body: string }

const STEPS: readonly Step[] = [
  {
    icon: "status",
    accent: "#8b5cf6",
    title: "Welcome to NovaClaw",
    body: "Your private AI workspace — an operating system where AI helpers work for you like apps. It runs on your own hardware, so your conversations and data stay with you.",
  },
  {
    icon: "grid-plus",
    accent: "#22d3ee",
    title: "A home screen of apps",
    body: "Tap a tile to open an app. Chats is where you talk with AI, Notes keeps your everyday things, Files lets AI work on your folders, and Processes shows what the AI is doing right now.",
  },
  {
    icon: "menu",
    accent: "#e6b422",
    title: "Chat, and let AI help",
    body: "Open Chats to start a conversation. A helper can break a big job into smaller ones, use tools on your behalf, and hand back the result — you can watch it happen in Processes.",
  },
  {
    icon: "folder-add-left",
    accent: "#3b82f6",
    title: "Your data is yours — and safe",
    body: "Notes are shared with your AI helpers so they know your context. When AI edits or removes files, deletions go to a Trash you can restore from — nothing is lost by accident.",
  },
  {
    icon: "check",
    accent: "#34d399",
    title: "You're all set",
    body: "Open Chats and say hi. You can drag the tiles to rearrange them, and reopen this tour anytime from the Help app.",
  },
]

export const HelpTour: Component = () => {
  const dialog = useDialog()
  const [i, setI] = createSignal(0)
  const step = () => STEPS[i()]!
  const last = () => i() === STEPS.length - 1

  return (
    <Dialog size="large">
      <div class="flex flex-col items-center gap-5 px-8 py-10 min-w-[24rem] max-w-[30rem] text-center">
        <div
          class="flex items-center justify-center size-16 rounded-[1.375rem] shadow-[var(--v2-elevation-floating)] ring-1 ring-white/10"
          style={{ "background-image": `linear-gradient(150deg, ${step().accent}, color-mix(in oklab, ${step().accent} 62%, black))` }}
        >
          <Icon name={step().icon as ComponentProps<typeof Icon>["name"]} class="size-9 text-white/95" />
        </div>
        <div class="flex flex-col gap-2">
          <span class="text-base font-semibold text-v2-text-text-base">{step().title}</span>
          <span class="text-sm text-v2-text-text-muted leading-relaxed">{step().body}</span>
        </div>
        <div class="flex items-center gap-1.5 pt-1">
          <For each={STEPS}>
            {(_, d) => (
              <div
                class="size-1.5 rounded-full transition-all"
                classList={{ "bg-v2-text-text-base scale-125": d() === i(), "bg-v2-border-border-strong": d() !== i() }}
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
            <button
              type="button"
              class="text-sm font-medium text-white px-4 py-1.5 rounded-lg shadow-[var(--v2-elevation-raised)] transition-transform active:scale-95"
              style={{ "background-image": "linear-gradient(150deg, #8b5cf6, #6d28d9)" }}
              onClick={() => (last() ? dialog.close() : setI(i() + 1))}
            >
              {last() ? "Get started" : "Next"}
            </button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}
