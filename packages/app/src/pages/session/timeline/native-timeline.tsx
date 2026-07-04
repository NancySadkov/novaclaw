import { createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { NativeTranscript } from "@novaclaw/session-ui/v2/native-transcript"
import { useServerSync } from "@/context/server-sync"
import { nextPinned } from "./native-scroll"

/**
 * F1e S4-v3 — DEV-only A/B harness for the native `SessionMessage[]` render path.
 *
 * `NativeTimeline` renders the parallel native store (`nativeMessages`) through
 * `NativeTranscript` INSTEAD of the V1 virtualized `MessageTimeline`, gated on the
 * `nativeRenderEnabled` signal so it can be toggled live in the web preview without a
 * reload (V1 stays the default; nothing here ships enabled). Toggle from the preview:
 *
 *   window.__novaNativeRender()      // flip
 *   window.__novaNativeRender(true)  // force native on
 *
 * Removed once the render flip lands and native becomes the sole path (S4-v3 tail).
 */
const [nativeRenderEnabled, setNativeRenderEnabled] = createSignal(false)
export { nativeRenderEnabled }

if (import.meta.env.DEV && typeof window !== "undefined") {
  ;(window as unknown as { __novaNativeRender?: (on?: boolean) => boolean }).__novaNativeRender = (on) => {
    const next = on ?? !nativeRenderEnabled()
    setNativeRenderEnabled(next)
    return next
  }
}

export function NativeTimeline(props: { sessionID: string }) {
  const serverSync = useServerSync()
  const messages = createMemo(() => serverSync().nativeMessages.messages(props.sessionID) ?? [])

  let scroller: HTMLDivElement | undefined
  let content: HTMLDivElement | undefined
  // Chat auto-scroll: keep the newest content in view while the user is at the bottom;
  // unpin once they scroll up. (F-b's virtualizer.scrollToEnd later supersedes this.)
  let pinned = true
  const stick = () => {
    const el = scroller
    if (pinned && el) el.scrollTop = el.scrollHeight
  }

  // Own the load (message-timeline's load effect never runs while it is unmounted).
  createEffect(() => {
    const sid = props.sessionID
    if (sid) void serverSync().nativeMessages.load(sid)
  })

  // A new turn changes the list length — the store array proxy is reference-stable on
  // push, so track `.length`, not the array. Stick synchronously; the ResizeObserver
  // below then re-sticks once the new/streamed content actually lays out.
  createEffect(() => {
    messages().length
    stick()
  })

  onMount(() => {
    if (!content) return
    // Streaming deltas + async markdown reflow grow the content without changing the
    // message-array length — a ResizeObserver catches those growth events.
    const observer = new ResizeObserver(() => stick())
    observer.observe(content)
    onCleanup(() => observer.disconnect())
  })

  return (
    <div
      ref={(el) => (scroller = el)}
      class="h-full overflow-y-auto"
      data-component="native-timeline"
      onScroll={() => {
        if (scroller) pinned = nextPinned(pinned, scroller)
      }}
    >
      <div ref={(el) => (content = el)}>
        <NativeTranscript messages={messages()} />
      </div>
    </div>
  )
}
