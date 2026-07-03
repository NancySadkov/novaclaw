import { Component, Show, type ComponentProps } from "solid-js"
import { useNavigate } from "@solidjs/router"
import { Dialog } from "@novaclaw/ui/v2/dialog-v2"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { Icon } from "@novaclaw/ui/icon"
import { useDialog } from "@novaclaw/ui/context/dialog"

// The panel behind apps whose rich surface isn't built yet (Notes / Search / Terminal). Not a bare
// "coming soon": it teaches the chat-first model — anything an app would do, an agent can already do
// in Chats, and an agent can even pack that ability into a home-screen app on request. Every tile
// stays launchable AND self-documenting.
export const AppPlaceholder: Component<{
  title: string
  icon?: string
  accent?: string
  subtitle?: string
}> = (props) => {
  const dialog = useDialog()
  const navigate = useNavigate()
  const accent = () => props.accent ?? "#8b5cf6"

  return (
    <Dialog size="content">
      <div class="flex flex-col items-center gap-5 px-10 py-12 min-w-[24rem] max-w-[30rem] text-center">
        <Show when={props.icon}>
          <div
            class="flex items-center justify-center size-16 rounded-[1.375rem] shadow-[var(--v2-elevation-floating)] ring-1 ring-white/15"
            style={{
              "background-image": `linear-gradient(155deg, color-mix(in oklab, ${accent()} 88%, white) -8%, ${accent()} 42%, color-mix(in oklab, ${accent()} 58%, black) 105%)`,
              "--icon-base": "rgba(255,255,255,0.96)",
            }}
          >
            <Icon name={props.icon as ComponentProps<typeof Icon>["name"]} size="xl" />
          </div>
        </Show>
        <div class="flex flex-col gap-1.5">
          <span class="text-[17px] font-semibold text-v2-text-text-base">{props.title}</span>
          <Show when={props.subtitle}>
            <span class="text-[13px] font-medium text-v2-text-text-muted">{props.subtitle}</span>
          </Show>
        </div>
        <p class="text-sm text-v2-text-text-muted leading-relaxed">
          This app's own screen is still on the way — but the AI in{" "}
          <span class="text-v2-text-text-accent font-medium">Chats</span> can already do all of this for you. You can even
          ask it to build a{" "}
          {props.title.toLowerCase()} app for your home screen.
        </p>
        <ButtonV2
          variant="gold"
          size="large"
          class="px-5"
          onClick={() => {
            dialog.close()
            navigate("/chats")
          }}
        >
          Open Chats
        </ButtonV2>
      </div>
    </Dialog>
  )
}
