import { Component } from "solid-js"
import { Dialog } from "@opencode-ai/ui/v2/dialog-v2"

// A minimal "coming soon" panel for apps whose rich surface isn't built yet (Search / Terminal /
// Devices). Keeps every home tile launchable so the grid is real, not decorative.
export const AppPlaceholder: Component<{ title: string }> = (props) => (
  <Dialog size="large">
    <div class="flex flex-col items-center justify-center gap-2 px-10 py-14 min-w-[22rem] text-center">
      <span class="text-14-medium text-v2-text-text-base">{props.title}</span>
      <span class="text-12-medium text-v2-text-text-muted">This app is coming soon.</span>
    </div>
  </Dialog>
)
