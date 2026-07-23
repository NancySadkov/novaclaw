import { For, type Component, type ComponentProps } from "solid-js"
import { Dialog } from "@novaclaw/ui/v2/dialog-v2"
import { Icon } from "@novaclaw/ui/icon"
import { usePlatform } from "@/context/platform"

// The Social app: where the other humans are. A normal person who gets stuck at 11pm should be one
// click from someone who can help — that is the whole tile. It teaches rather than dumps links:
// each place says what it is FOR, so nobody has to guess where a bug report belongs.
//
// These are brand facts, not operational config: they are hardcoded like the docs link in
// Settings → Appearance. (The self-healing law is about facts an OUTAGE hinges on — a provider
// URL an agent must be able to repair — not about where our community lives.)
const PLACES = [
  {
    id: "discord",
    name: "Discord",
    icon: "discord",
    accent: "#5865f2",
    blurb: "Chat with other users and the people building NovaClaw. Best for questions, bug reports and ideas.",
    url: "https://discord.gg/QShqKW56JM",
  },
  {
    id: "reddit",
    name: "r/novaclaw",
    icon: "bubble-5",
    accent: "#7c8cf8",
    blurb: "Longer posts, guides and discussion that stays put — easier to find later than chat.",
    url: "https://www.reddit.com/r/novaclaw/",
  },
  {
    id: "site",
    name: "novaclaw.app",
    icon: "link",
    accent: "#38bdf8",
    blurb: "Downloads, release notes and the documentation.",
    url: "https://novaclaw.app",
  },
] as const

export const SocialPanel: Component = () => {
  const platform = usePlatform()

  return (
    <Dialog size="content">
      <div class="flex min-w-[22rem] max-w-[30rem] flex-col gap-5 px-8 py-9">
        <div class="flex flex-col gap-1.5 text-center">
          <span class="text-[17px] font-semibold text-v2-text-text-base">Community</span>
          <span class="text-[13px] font-medium text-v2-text-text-muted">
            Stuck, or want to show what you built? Other people run NovaClaw too.
          </span>
        </div>
        <div class="flex flex-col gap-2">
          <For each={PLACES}>
            {(place) => (
              <button
                type="button"
                class="flex w-full items-center gap-3 rounded-xl bg-v2-background-bg-layer-02 px-3 py-3 text-left transition-colors hover:bg-v2-background-bg-layer-03"
                onClick={() => platform.openLink(place.url)}
              >
                <span
                  class="flex size-9 shrink-0 items-center justify-center rounded-[0.75rem] ring-1 ring-white/15"
                  style={{
                    "background-image": `linear-gradient(155deg, color-mix(in oklab, ${place.accent} 88%, white) -8%, ${place.accent} 42%, color-mix(in oklab, ${place.accent} 58%, black) 105%)`,
                    "--icon-base": "rgba(255,255,255,0.96)",
                  }}
                >
                  <Icon name={place.icon as ComponentProps<typeof Icon>["name"]} size="medium" />
                </span>
                <span class="flex min-w-0 flex-col gap-0.5">
                  <span class="text-sm font-medium text-v2-text-text-base">{place.name}</span>
                  <span class="text-[12px] leading-snug text-v2-text-text-muted">{place.blurb}</span>
                </span>
                <Icon name="square-arrow-top-right" size="small" class="ml-auto shrink-0 text-v2-text-text-muted" />
              </button>
            )}
          </For>
        </div>
        {/* Honest about what leaves the machine: opening one of these is the user's own step out
            to the public internet, and nothing about their instance goes with it. */}
        <p class="text-center text-[12px] leading-relaxed text-v2-text-text-muted">
          These open in your browser. Nothing from your instance is sent — your chats and files stay here.
        </p>
      </div>
    </Dialog>
  )
}
