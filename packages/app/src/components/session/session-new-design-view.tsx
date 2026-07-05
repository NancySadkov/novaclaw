import type { JSX } from "solid-js"
import { NEW_SESSION_CONTENT_WIDTH } from "@/pages/session/new-session-layout"

export function NewSessionDesignView(props: { children: JSX.Element }) {
  return (
    <div data-component="session-new-design" class="relative size-full overflow-hidden bg-v2-background-bg-deep ">
      <div class="absolute inset-x-0 top-[25.375%] flex justify-center px-6">
        <div class={NEW_SESSION_CONTENT_WIDTH}>
          {/* NovaClaw brand lockup (icon + wordmark). The badge's ground is black; on the app's
              near-black deep background it blends so the mark appears to float. */}
          <img
            src="/novaclaw-logo.png"
            alt="NovaClaw"
            width="160"
            height="160"
            draggable={false}
            class="mx-auto size-40 rounded-2xl select-none"
          />
          <div class="mt-6">{props.children}</div>
        </div>
      </div>
    </div>
  )
}
