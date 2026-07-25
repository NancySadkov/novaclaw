import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { NativeTranscript } from "@novaclaw/session-ui/v2/native-transcript"
import type { ReasoningFoldMode } from "@novaclaw/session-ui/v2/reasoning-fold"
import { useExpertise } from "@/context/expertise"
import { useServerSync } from "@/context/server-sync"
import { useServer } from "@/context/server"
import { fetchPendingPrompts, type PendingPrompt } from "@/utils/session-pending-api"
import { useSettings } from "@/context/settings"
import { nextPinned } from "./native-scroll"

// Level-aware reasoning fold (UIX residue b / C4, uix.md §6 teach-don't-gatekeep): a non-expert
// sees the answer with reasoning folded; Advanced watches it think then it tidies away; a
// Developer keeps the full trace open.
const REASONING_FOLD: Record<string, ReasoningFoldMode> = {
  normal: "collapsed",
  advanced: "live",
  developer: "open",
}

/**
 * F1e — the native `SessionMessage[]` timeline: the SOLE render path (F-d/F-e, owner-approved
 * 2026-07-05, replacing the deleted V1 `MessageTimeline`). Reads the native store
 * (`nativeMessages`) through `NativeTranscript` and owns chat auto-scroll — pin-to-bottom while
 * the user is at the bottom + a scroll-to-bottom button. (Hash-scroll deep-link + history
 * pagination + virtualization are deferred long-session hardening.)
 */
export function NativeTimeline(props: {
  sessionID: string
  onRevert?: (messageID: string) => void
  /** The session's working directory — needed for the directory-scoped pending-prompt fetch. */
  directory?: string
}) {
  const serverSync = useServerSync()
  const server = useServer()
  const sessionDirectory = () => props.directory
  const expertise = useExpertise()
  const settings = useSettings()
  // The user's explicit Settings pref wins over the expertise-level default ("auto") — the
  // feed-display selects in Settings → General (owner 2026-07-22: the level default alone left
  // no way to keep reasoning/tool cards collapsed as a Developer, and the old shell/edit
  // switches were dead V1-path settings).
  const levelFold = () => REASONING_FOLD[expertise.level()] ?? "collapsed"
  const applyPref = (pref: "auto" | "expanded" | "collapsed"): ReasoningFoldMode =>
    pref === "expanded" ? "open" : pref === "collapsed" ? "collapsed" : levelFold()
  const reasoningFold = createMemo<ReasoningFoldMode>(() => applyPref(settings.general.feedReasoningDisplay()))
  const toolFold = createMemo<ReasoningFoldMode>(() => applyPref(settings.general.feedToolDisplay()))
  const messages = createMemo(() => serverSync().nativeMessages.messages(props.sessionID) ?? [])

  // Prompts the user sent that the agent has not read yet. They live in the durable input queue, not the
  // transcript, so they are invisible to the message stream and have to be polled. Polling only while a
  // turn is in flight keeps it to the window where a queue can exist at all; one trailing poll after the
  // turn settles clears the last bubble the moment its input is promoted.
  const [pending, setPending] = createSignal<readonly PendingPrompt[]>([])
  const working = createMemo(() => {
    const list = messages()
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const message = list[i]!
      if (message.type === "assistant") return !message.time.completed
    }
    return false
  })
  createEffect(() => {
    const directory = server.current?.http ? sessionDirectory() : undefined
    const conn = server.current
    if (!conn || !directory) return
    if (!working() && pending().length === 0) return
    let stop = false
    const tick = async () => {
      if (stop) return
      const rows = await fetchPendingPrompts(conn.http, { directory, sessionID: props.sessionID }).catch(
        () => [] as PendingPrompt[],
      )
      if (!stop) setPending(rows)
    }
    void tick()
    const timer = setInterval(() => void tick(), 2000)
    onCleanup(() => {
      stop = true
      clearInterval(timer)
    })
  })

  let scroller: HTMLDivElement | undefined
  let content: HTMLDivElement | undefined
  // Chat auto-scroll: keep the newest content in view while the user is at the bottom;
  // unpin once they scroll up. Reactive so the scroll-to-bottom affordance can show when
  // unpinned. (F-b's virtualizer.scrollToEnd later supersedes the stick mechanism.)
  const [pinned, setPinned] = createSignal(true)
  const stick = () => {
    const el = scroller
    if (pinned() && el) el.scrollTop = el.scrollHeight
  }
  const scrollToBottom = () => {
    setPinned(true)
    if (scroller) scroller.scrollTop = scroller.scrollHeight
  }

  // Own the load (message-timeline's load effect never runs while it is unmounted).
  createEffect(() => {
    const sid = props.sessionID
    if (sid) void serverSync().nativeMessages.load(sid)
  })

  // Self-heal missed live events: the SSE event stream can drop a turn's events when it
  // reconnects during a heartbeat gap (an idle tab that then submits) — including the
  // `step.started` that creates the assistant message, so the reply never renders live. When
  // the session settles back to idle (turn complete), reconcile the native store from the
  // server so the completed reply still renders without a manual reload. Idempotent — the
  // history fetch + `mergeNativeMessages` dedups against what streamed in.
  let prevWorking: { sid: string; working: boolean } | undefined
  createEffect(() => {
    const sid = props.sessionID
    if (!sid) {
      prevWorking = undefined
      return
    }
    const working = serverSync().session.data.session_working(sid)
    if (prevWorking?.sid === sid && prevWorking.working && !working) {
      void serverSync().nativeMessages.load(sid).catch(() => {})
    }
    prevWorking = { sid, working }
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
    <div style={{ position: "relative", height: "100%" }} data-component="native-timeline-wrap">
      <div
        ref={(el) => (scroller = el)}
        class="h-full overflow-y-auto"
        data-component="native-timeline"
        onScroll={() => {
          if (scroller) setPinned(nextPinned(pinned(), scroller))
        }}
      >
        <div ref={(el) => (content = el)}>
          <NativeTranscript
            messages={messages()}
            reasoningFold={reasoningFold()}
            toolFold={toolFold()}
            pending={pending()}
            onRevert={props.onRevert}
          />
        </div>
      </div>
      <Show when={!pinned()}>
        <button
          type="button"
          aria-label="Scroll to latest"
          data-slot="native-scroll-bottom"
          onClick={scrollToBottom}
          style={{
            position: "absolute",
            bottom: "1rem",
            left: "50%",
            transform: "translateX(-50%)",
            "z-index": "10",
            display: "grid",
            "place-items": "center",
            width: "2.25rem",
            height: "2.25rem",
            "border-radius": "9999px",
            cursor: "pointer",
            "font-size": "1.1rem",
            "line-height": "1",
            background: "var(--v2-background-bg-layer-02)",
            border: "1px solid var(--v2-border-border-muted)",
            color: "var(--v2-text-text-base)",
            "box-shadow": "0 2px 8px rgba(0, 0, 0, 0.25)",
          }}
        >
          ↓
        </button>
      </Show>
    </div>
  )
}
