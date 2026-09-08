import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { NativeTranscript } from "@novaclaw/session-ui/v2/native-transcript"
import type { ReasoningFoldMode } from "@novaclaw/session-ui/v2/reasoning-fold"
import { useExpertise } from "@/context/expertise"
import { useServerSync } from "@/context/server-sync"
import { useServer } from "@/context/server"
import { selectVisibleMessages } from "@/pages/session/revert-view"
import { fetchPendingPrompts, pendingPromptsKick, type PendingPrompt } from "@/utils/session-pending-api"
import { useSettings } from "@/context/settings"
import { createBottomPinController, navigationTargetIndex } from "./native-scroll"
import { keepEqualRows, startPendingPoll } from "./pending-poll"
import { isInFlightAssistant } from "@novaclaw/session-ui/v2/message-fold"

export type NativeTimelineController = {
  navigateUser: (offset: number) => void
  scrollToUser: (messageID: string | undefined) => void
  scrollToBottom: () => void
}

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
  onRetry?: (messageID: string) => void | Promise<void>
  onChooseModel?: () => void
  onUnpinDevice?: (sessionID: string) => void | Promise<void>
  onStopCommand?: (reason: string) => void | Promise<void>
  /**
   * The staged-revert boundary (`session.revert.messageID`). The boundary message and everything
   * after it leave the transcript — a staged revert is a reversible HIDE, so the rows stay in the
   * store and the revert dock names them with Restore / Discard.
   *
   * ⚠️ This is the render path. Until 2026-07-29 nothing here consulted the boundary at all: the
   * only filter in the app (`timeline/model.ts`) feeds message NAVIGATION, so a staged revert left
   * every message on screen and the owner reported it twice. Ruling 2 — a fault is never described
   * falsely — cuts both ways: the transcript must not keep asserting that a rolled-back turn is
   * still part of the conversation.
   */
  revertMessageID?: string
  /** The session's working directory — needed for the directory-scoped pending-prompt fetch. */
  directory?: string
  setController?: (controller: NativeTimelineController | undefined) => void
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
  // `stored` is everything the native store holds; `messages` is what a staged revert leaves on
  // screen. Liveness reads `stored` (the server is still running that turn whether or not a revert
  // hides it); rendering and auto-scroll read `messages`.
  const stored = createMemo(() => serverSync().nativeMessages.messages(props.sessionID) ?? [])
  const messages = createMemo(() => selectVisibleMessages(stored(), props.revertMessageID))

  // Prompts the user sent that the agent has not read yet. They live in the durable input queue, not the
  // transcript, so they are invisible to the message stream and have to be polled. Always make one read
  // on mount: a worker can fail before promotion and leave a durable queued prompt while no assistant
  // message says the session is working. Once found, keep polling; one trailing poll after a healthy turn
  // settles clears the last bubble the moment its input is promoted.
  const [pending, setPending] = createSignal<readonly PendingPrompt[]>([])
  const updatePending = (rows: readonly PendingPrompt[]) =>
    setPending((current) =>
      keepEqualRows(
        current,
        rows,
        (a, b) => a.id === b.id && a.text === b.text && a.delivery === b.delivery && a.timeCreated === b.timeCreated,
      ),
    )
  /**
   * 🔴 `time?.completed`, not `time.completed` — this line put a shipped renderer on the floor.
   *
   * Measured 0.1.67, live: an assistant row reached the store WITHOUT its `time` struct, which the
   * schema declares required. This memo is read by a `<Show>`'s `when`, so the throw propagated out
   * of the getter to the app's SINGLE root ErrorBoundary and replaced the entire UI with a fatal
   * error — `TypeError: Cannot read properties of undefined (reading 'time')`.
   *
   * ⚠️ **A row the UI cannot fully read is a normal event, not a fault** (owner, 2026-08-27). The
   * question this memo answers is "is the agent still working", and a message with no completion
   * stamp has plainly not completed — so the malformed row gets the honest answer rather than
   * taking the transcript down with it. `native-timeline.tsx` is also not the place that decides
   * this: `isInFlightAssistant` in `message-fold.ts` is the same predicate, and both are hardened.
   */
  const working = createMemo(() => {
    const list = stored()
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const message = list[i]!
      if (message.type === "assistant") return isInFlightAssistant(message)
    }
    return false
  })
  createEffect(() => {
    const directory = server.current?.http ? sessionDirectory() : undefined
    const conn = server.current
    if (!conn || !directory) return
    // Read so a submit can re-run this effect and poll AT ONCE. Without it the dependencies below
    // never change when the user presses Enter, so a mid-turn prompt stayed invisible for up to a
    // full 2 s tick — long enough to read as "it disappeared" and retype it.
    pendingPromptsKick()
    const repeat = working() || pending().length > 0
    onCleanup(
      startPendingPoll({
        repeat,
        fetch: () =>
          fetchPendingPrompts(conn.http, { directory, sessionID: props.sessionID }).catch(() => [] as PendingPrompt[]),
        // Preserve the signal identity when a one-shot idle read returns the same rows. Otherwise
        // an empty `[]` response would retrigger this effect forever and turn "read once" into a
        // tight request loop.
        update: updatePending,
      }),
    )
  })

  let scroller: HTMLDivElement | undefined
  let content: HTMLDivElement | undefined
  // Chat auto-scroll: keep the newest content in view while the user is at the bottom;
  // unpin once they scroll up. Reactive so the scroll-to-bottom affordance can show when
  // unpinned. (F-b's virtualizer.scrollToEnd later supersedes the stick mechanism.)
  const [pinned, setPinned] = createSignal(true)
  let pinController: ReturnType<typeof createBottomPinController> | undefined
  const stick = () => {
    pinController?.stick()
  }
  const scrollToBottom = () => {
    if (pinController) pinController.scrollToBottom()
    else setPinned(true)
  }
  // Solid reuses this component when one chat route changes to another, so its signal is not a
  // per-chat value unless we make it one. A reader who scrolled up in chat A must not make chat B's
  // asynchronous history load start unpinned and strand it at B's first message.
  let pinnedSession: string | undefined
  createEffect(() => {
    const sid = props.sessionID
    if (sid === pinnedSession) return
    pinnedSession = sid
    scrollToBottom()
    queueMicrotask(scrollToBottom)
  })

  const navigateUser = (offset: number) => {
    const root = scroller
    if (!root) return
    const rows = [...root.querySelectorAll<HTMLElement>("[data-slot='native-user']:not([data-queued])")]
    if (!rows.length) return
    const box = root.getBoundingClientRect()
    const line = box.top + 100
    const hit = rows.findIndex((row) => {
      const rect = row.getBoundingClientRect()
      return rect.top <= line && rect.bottom >= line
    })
    const before = rows.findLastIndex((row) => row.getBoundingClientRect().top <= line)
    const current = hit >= 0 ? hit : before >= 0 ? before : rows.length
    const target = navigationTargetIndex(current, rows.length, offset)
    if (target === undefined) return
    if (target === rows.length) {
      scrollToBottom()
      return
    }
    const row = rows[target]
    if (!row) return
    setPinned(false)
    const rect = row.getBoundingClientRect()
    root.scrollTo({ top: Math.max(0, rect.top - box.top + root.scrollTop), behavior: "auto" })
  }

  const scrollToUser = (messageID: string | undefined) => {
    if (!messageID) {
      scrollToBottom()
      return
    }
    const root = scroller
    if (!root) return
    const row = [...root.querySelectorAll<HTMLElement>("[data-message-id]")].find(
      (item) => item.dataset.messageId === messageID,
    )
    if (!row) return
    setPinned(false)
    const box = root.getBoundingClientRect()
    const rect = row.getBoundingClientRect()
    root.scrollTo({ top: Math.max(0, rect.top - box.top + root.scrollTop), behavior: "auto" })
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
      void serverSync()
        .nativeMessages.load(sid)
        .catch(() => {})
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
    props.setController?.({ navigateUser, scrollToUser, scrollToBottom })
    onCleanup(() => props.setController?.(undefined))
    if (!content || !scroller) return
    pinController = createBottomPinController({ scroller, content, pinned, setPinned })
    onCleanup(() => {
      pinController?.dispose()
      pinController = undefined
    })
    // Re-entering Chat mounts an already-populated list: the length effect may have run before the
    // refs existed, so establish the pin here rather than waiting for content to change.
    stick()
  })

  return (
    <div style={{ position: "relative", height: "100%" }} data-component="native-timeline-wrap">
      {/* 🔴 **DO NOT SET `overflow-anchor: none` HERE.** It is the obvious hardening — the browser
          moving `scrollTop` on its own sounds like something a pin-to-bottom chat should forbid —
          and measuring it in a real Chromium on 2026-09-04 showed it does the exact opposite.

          The case is content ABOVE the viewport growing while the reader is pinned at the bottom (a
          turn expanding, a reconcile inserting rows). Four configurations, same content, nobody
          scrolling, `scrollTop` starting at 894 of a 1110px transcript that grows to 2273:

            · anchoring ON  + ResizeObserver  →  top 2057, gap 0,    pinned   ← what ships
            · anchoring ON  + no observer     →  top 2057, gap 0,    pinned
            · anchoring OFF + ResizeObserver  →  top  894, gap 1163, UNPINNED
            · anchoring OFF + no observer     →  top  894, gap 1163, and ZERO scroll events

          Scroll anchoring is what holds the pin, not the observer — the second row proves it alone.
          Turning it off manufactures the very fault it looks like it prevents, and the fourth row is
          why it would be so hard to find afterwards: `scrollTop` never changes, so no scroll event
          fires and nothing in this file can notice the drift.

          The `overflow-anchor: none` that used to sit in `session-ui/src/components/session-turn.css`
          was not a counter-example either. That sheet WAS imported and did ship — through
          `styles/index.css`, which is the part a search for `.tsx` imports misses — but no component
          ever set the `data-component` every one of its rules was scoped under, so not a single one
          could match. It is deleted now. Citing it as precedent is what nearly put this rule in:
          a stylesheet with no reachable selector still reads exactly like a decision somebody made
          on purpose. */}
      <div ref={(el) => (scroller = el)} class="h-full overflow-y-auto" data-component="native-timeline">
        <div ref={(el) => (content = el)}>
          <NativeTranscript
            messages={messages()}
            reasoningFold={reasoningFold()}
            toolFold={toolFold()}
            developer={expertise.level() === "developer"}
            pending={pending()}
            onRevert={props.onRevert}
            onRetry={props.onRetry}
            onChooseModel={props.onChooseModel}
            onUnpinDevice={props.onUnpinDevice}
            onStopCommand={props.onStopCommand}
            status={serverSync().session.data.session_status[props.sessionID]}
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
