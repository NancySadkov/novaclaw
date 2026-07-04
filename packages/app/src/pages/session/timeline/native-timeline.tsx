import { createEffect, createMemo, createSignal } from "solid-js"
import { NativeTranscript } from "@novaclaw/session-ui/v2/native-transcript"
import { useServerSync } from "@/context/server-sync"

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

  // Own the load (message-timeline's load effect never runs while it is unmounted).
  createEffect(() => {
    const sid = props.sessionID
    if (sid) void serverSync().nativeMessages.load(sid)
  })

  return (
    <div class="h-full overflow-y-auto" data-component="native-timeline">
      <NativeTranscript messages={messages()} />
    </div>
  )
}
