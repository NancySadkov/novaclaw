import { type Component } from "solid-js"
import { Dialog } from "@novaclaw/ui/v2/dialog-v2"
import { CommunityNetwork } from "./community-network"

export const SocialPanel: Component = () => (
  <Dialog size="content">
    <div class="flex w-[min(94vw,54rem)] max-h-[min(88dvh,54rem)] min-w-0 flex-col gap-4 overflow-y-auto px-4 py-5 sm:px-7 sm:py-7">
      <header class="rounded-2xl border border-amber-300/20 bg-[radial-gradient(ellipse_at_top_left,rgba(210,165,76,0.15),transparent_60%),linear-gradient(140deg,rgba(62,39,89,0.85),rgba(20,14,33,0.9))] px-5 py-4 shadow-[inset_0_1px_rgba(255,240,205,0.12)]">
        <div class="mb-1 text-[10px] font-semibold uppercase tracking-[0.2em] text-amber-200/70">NovaClaw network</div>
        <h1 class="text-xl font-semibold tracking-tight text-amber-100">Swarm</h1>
        <p class="mt-1 max-w-[42rem] text-[13px] leading-relaxed text-v2-text-text-muted">
          Connect your instance to other Novas. Find peers through your local network, introductions, or the public DHT; exchange knowledge and work directly between agents.
        </p>
      </header>
      <CommunityNetwork />
    </div>
  </Dialog>
)
