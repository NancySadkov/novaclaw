import { createEffect, createMemo, createSignal, onCleanup, onMount, Show } from "solid-js"
import { NativeTranscript } from "@novaclaw/session-ui/v2/native-transcript"
import type { ReasoningFoldMode } from "@novaclaw/session-ui/v2/reasoning-fold"
import { useExpertise } from "@/context/expertise"
import { useServerSync } from "@/context/server-sync"
import { useServer } from "@/context/server"
import { selectVisibleMessages } from "@/pages/session/revert-view"
import {
  cancelPendingPrompt,
  fetchPendingPrompts,
  kickPendingPrompts,
  pendingPromptsKick,
  type PendingPrompt,
} from "@/utils/session-pending-api"
import { useSettings } from "@/context/settings"
import { createBottomPinController, navigationTargetIndex } from "./native-scroll"
import { keepEqualRows, startPendingPoll } from "./pending-poll"
import { showToast } from "@/utils/toast"
import { isInFlightAssistant } from "@novaclaw/session-ui/v2/message-fold"
import { harnessWaitLabel, type HarnessWaitAttempt } from "../session-harness-wait"

export type NativeTimelineController = {
  navigateUser: (offset: number) => void
  scrollToUser: (messageID: string | undefined) => void
  scrollToBottom: () => void
}

export type NativeTimelineViewport = {
  ready: () => boolean
  read: () => { y: number; anchor?: { id: string; offset: number } } | undefined
  write: (position: { y: number; anchor?: { id: string; offset: number } } | undefined) => void
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
  /** Durable unfinished work; survives the gap between process boot and live-status recovery. */
  executionOpen?: boolean
  /** The persisted execution boundary that explains what unfinished work is waiting on. */
  executionAttempt?: HarnessWaitAttempt
  onRevert?: (messageID: string) => void
  onRetry?: (messageID: string) => void | Promise<void>
  onChooseModel?: () => void
  onUnpinDevice?: (sessionID: string) => void | Promise<void>
  onStopCommand?: (callID: string, reason: string) => void | Promise<void>
  /** Put a successfully cancelled queued prompt back in the composer. */
  onEditQueued?: (messageID: string, text: string) => void
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
  /** Effective officer ceiling used by command/wait progress labels. */
  maxToolTimeoutMs?: number
  viewport?: NativeTimelineViewport
  setController?: (controller: NativeTimelineController | undefined) => void
}) {
  // This component is keyed by chat. Capture its viewport owner once so route parameters changing
  // before teardown cannot redirect the departing chat's final save into the arriving chat.
  const viewport = props.viewport
  const serverSync = useServerSync()
  const server = useServer()
  const sessionDirectory = () => props.directory
  const expertise = useExpertise()
  const settings = useSettings()
  // The user's explicit Settings pref wins over the expertise-level default ("auto") — the
  // feed-display selects in Settings → Appearance (owner 2026-07-22: the level default alone left
  // no way to keep reasoning/tool cards collapsed as a Developer, and the old shell/edit
  // switches were dead V1-path settings).
  const levelFold = () => REASONING_FOLD[expertise.level()] ?? "collapsed"
  const applyPref = (pref: "auto" | "expanded" | "collapsed"): ReasoningFoldMode =>
    pref === "expanded" ? "open" : pref === "collapsed" ? "collapsed" : levelFold()
  const reasoningFold = createMemo<ReasoningFoldMode>(() => applyPref(settings.appearance.feedReasoningDisplay()))
  const toolFold = createMemo<ReasoningFoldMode>(() => applyPref(settings.appearance.feedToolDisplay()))
  // `stored` is everything the native store holds; `messages` is what a staged revert leaves on
  // screen. Liveness reads `stored` (the server is still running that turn whether or not a revert
  // hides it); rendering and auto-scroll read `messages`.
  const stored = createMemo(() => serverSync().nativeMessages.messages(props.sessionID) ?? [])
  const messages = createMemo(() => selectVisibleMessages(stored(), props.revertMessageID))
  const reconciling = () => serverSync().nativeMessages.reconciling(props.sessionID)
  const waitLabel = () => harnessWaitLabel(props.executionAttempt, { transcriptReconciliation: reconciling() })

  // Prompts the user sent that the agent has not read yet. They live in the durable input queue, not the
  // transcript, so they are invisible to the message stream and have to be polled. Always make one read
  // on mount: a worker can fail before promotion and leave a durable queued prompt while no assistant
  // message says the session is working. Once found, keep polling; one trailing poll after a healthy turn
  // settles clears the last bubble the moment its input is promoted.
  const [pending, setPending] = createSignal<readonly PendingPrompt[]>([])
  const updatePending = (rows: readonly PendingPrompt[]) =>
    setPending((current) => {
      return keepEqualRows(
        current,
        rows.filter((row) => row.delivery === "queue"),
        (a, b) =>
          a.id === b.id &&
          a.text === b.text &&
          a.delivery === b.delivery &&
          a.editable === b.editable &&
          a.timeCreated === b.timeCreated,
      )
    })
  const cancelQueued = async (messageID: string, edit = false) => {
    const conn = server.current
    const directory = sessionDirectory()
    if (!conn || !directory) return
    const row = pending().find((item) => item.id === messageID)
    try {
      const cancelled = await cancelPendingPrompt(conn.http, {
        directory,
        sessionID: props.sessionID,
        messageID,
      })
      if (!cancelled) {
        // Promotion may have won the race. Keep the waiting projection until the canonical read
        // succeeds; dropping it first would recreate the very ownerless-frame ghost this path fixes.
        await serverSync().nativeMessages.load(props.sessionID)
        kickPendingPrompts()
        return
      }
      // The durable cancellation committed, so both local projections can disappear immediately.
      setPending((items) => items.filter((item) => item.id !== messageID))
      serverSync().nativeMessages.forget(props.sessionID, messageID)
      if (edit && row) props.onEditQueued?.(row.id, row.text)
    } catch (error) {
      showToast({
        title: "Could not cancel this queued message",
        description: error instanceof Error ? error.message : String(error),
        variant: "error",
      })
    }
  }
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
        fetch: async () => {
          const rows = await fetchPendingPrompts(conn.http, { directory, sessionID: props.sessionID }).catch(() =>
            pending(),
          )
          const next = new Set(rows.map((row) => row.id))
          const disappeared = pending().some((row) => !next.has(row.id))
          // Promotion and cancellation both remove an input row. Reconcile the canonical transcript
          // before handing either transition to the renderer, so there is never a frame in which a
          // prompt is owned by neither projection. If the read fails, retain the last truthful list.
          if (disappeared) await serverSync().nativeMessages.load(props.sessionID)
          return rows
        },
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
  // A missing saved position means the natural chat edge: the latest message. While the persisted
  // layout is still hydrating, start unpinned so a premature mount cannot paint the bottom and then
  // jump back to the reader's saved place.
  //
  // Viewport invariants (owner, 2026-09-18):
  // 1. At the bottom the view is pinned there (the default for new chats) until the user moves it
  //    above via wheel, swipe or scrollbar.
  // 2. At offset N the view stays at offset N until the chat is cleared or the user moves it.
  // The second one is what a tab switch must not break: a reconcile can empty the rows (Chromium
  // clamps scrollTop to 0 while the content is absent) and streaming can grow the content box after
  // the first restore. A single apply-on-mount then leaves the reader at the start of the chat, so
  // the saved position is re-applied until it holds, and a clamped intermediate never overwrites it.
  const initialPosition = viewport?.ready() ? viewport.read() : undefined
  const [pinned, setPinned] = createSignal(viewport?.ready() === false ? false : !initialPosition)
  let viewportInitialized = false
  let restoreFrame: number | undefined
  let pinController: ReturnType<typeof createBottomPinController> | undefined
  // A saved offset still waiting to hold. Set on restore; cleared on user intent, on reaching the
  // bottom pin, or once the content is tall enough to actually hold it.
  let pendingRestore: { y: number; anchor?: { id: string; offset: number } } | undefined = initialPosition
    ? { y: initialPosition.y, ...(initialPosition.anchor ? { anchor: initialPosition.anchor } : {}) }
    : undefined
  // Tallest content box seen. A reconcile empties the rows in one rendering turn; the clamped
  // scrollTop it produces must not be saved as the reader's place.
  let contentHighWater = 0
  const stick = () => {
    pinController?.stick()
  }
  const scrollToBottom = () => {
    pendingRestore = undefined
    if (pinController) pinController.scrollToBottom()
    else setPinned(true)
  }

  const captureAnchor = (root: HTMLElement) => {
    const box = root.getBoundingClientRect()
    const rows = [...root.querySelectorAll<HTMLElement>("[data-message-id]")]
    const row = rows.findLast((item) => item.getBoundingClientRect().top <= box.top) ?? rows[0]
    if (!row?.dataset.messageId) return
    return { id: row.dataset.messageId, offset: box.top - row.getBoundingClientRect().top }
  }

  const saveViewport = (position = { y: scroller?.scrollTop ?? 0, pinned: pinned() }) => {
    if (!viewportInitialized || !viewport?.ready()) return
    const root = scroller
    if (root) contentHighWater = Math.max(contentHighWater, root.scrollHeight)
    if (position.pinned) {
      pendingRestore = undefined
      viewport.write(undefined)
      return
    }
    // While a restore is still pending the scroll events are programmatic echoes (a clamped
    // intermediate included) — saving them would overwrite the reader's real place with 0.
    if (pendingRestore) return
    // A reconcile collapse: the rows are briefly absent and Chromium clamps scrollTop. The content
    // box gives it away — much shorter than what this mount already showed.
    if (root && root.scrollHeight < contentHighWater - 200) return
    pendingRestore = undefined
    viewport.write(
      position.pinned
        ? undefined
        : {
            y: position.y,
            ...(scroller ? { anchor: captureAnchor(scroller) } : {}),
          },
    )
  }

  const applySavedViewport = (saved: NonNullable<ReturnType<NativeTimelineViewport["read"]>>) => {
    const root = scroller
    if (!root) return false
    contentHighWater = Math.max(contentHighWater, root.scrollHeight)
    const row = saved.anchor
      ? [...root.querySelectorAll<HTMLElement>("[data-message-id]")].find(
          (item) => item.dataset.messageId === saved.anchor?.id,
        )
      : undefined
    if (!row || !saved.anchor) {
      // Without its rows the content cannot hold the offset yet — keep the pending restore for the
      // messages-length effect below instead of painting the clamped top.
      if (root.scrollHeight < saved.y + root.clientHeight) return false
      root.scrollTop = saved.y
      return Math.abs(root.scrollTop - saved.y) <= 2
    }
    const box = root.getBoundingClientRect()
    const rect = row.getBoundingClientRect()
    root.scrollTop = Math.max(0, root.scrollTop + rect.top - box.top + saved.anchor.offset)
    return true
  }

  const restoreViewport = () => {
    if (viewportInitialized || !pinController) return
    if (!viewport) {
      viewportInitialized = true
      scrollToBottom()
      return
    }
    if (!viewport.ready()) return
    viewportInitialized = true
    const saved = viewport.read()
    if (!saved) {
      scrollToBottom()
      return
    }
    // A cleared chat reuses the colleague's canonical id, so a stale offset can outlive the
    // transcript it measured. An empty transcript has no offset to keep — it starts pinned.
    if (messages().length === 0) {
      viewport.write(undefined)
      scrollToBottom()
      return
    }

    pendingRestore = { y: saved.y, ...(saved.anchor ? { anchor: saved.anchor } : {}) }
    setPinned(false)
    applySavedViewport(saved)
    // Markdown and custom message cards can finish their first layout after onMount. Re-apply once
    // after that paint, but only until the first explicit user input changes the saved position.
    restoreFrame = requestAnimationFrame(() => {
      restoreFrame = undefined
      if (!pinned() && pendingRestore) {
        if (applySavedViewport(saved)) pendingRestore = undefined
      }
    })
  }

  const cancelViewportRestore = () => {
    pendingRestore = undefined
    if (restoreFrame === undefined) return
    cancelAnimationFrame(restoreFrame)
    restoreFrame = undefined
  }

  createEffect(() => {
    viewport?.ready()
    restoreViewport()
  })

  const navigateUser = (offset: number) => {
    cancelViewportRestore()
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
    cancelViewportRestore()
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
    // A failed refresh keeps the resident transcript; stream recovery owns the retry.
    if (sid)
      void serverSync()
        .nativeMessages.load(sid)
        .catch(() => {})
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
  // While unpinned the same growth must NOT move the reader: if a reconcile clamped the view to
  // the top while the rows were absent, re-apply the reader's saved offset once the rows are back.
  createEffect(() => {
    messages().length
    if (scroller) contentHighWater = Math.max(contentHighWater, scroller.scrollHeight)
    if (pinned()) {
      stick()
      return
    }
    if (pendingRestore && viewport?.ready()) {
      const saved = viewport.read()
      if (!saved) {
        pendingRestore = undefined
        return
      }
      if (applySavedViewport(saved)) pendingRestore = undefined
      return
    }
    if (pendingRestore || !viewport?.ready()) return
    const saved = viewport.read()
    const root = scroller
    if (!saved || !root) return
    if (root.scrollHeight < saved.y + root.clientHeight) return
    if (Math.abs(root.scrollTop - saved.y) > 50) applySavedViewport(saved)
  })

  onMount(() => {
    props.setController?.({ navigateUser, scrollToUser, scrollToBottom })
    onCleanup(() => props.setController?.(undefined))
    if (!content || !scroller) return
    pinController = createBottomPinController({
      scroller,
      content,
      pinned,
      setPinned,
      onPositionChange: saveViewport,
      onUserIntent: cancelViewportRestore,
    })
    restoreViewport()
    onCleanup(() => {
      saveViewport()
      if (restoreFrame !== undefined) cancelAnimationFrame(restoreFrame)
      pinController?.dispose()
      pinController = undefined
    })
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
      {/* ⚠️ `overflow-x-hidden` is load-bearing, not decoration. `overflow-y-auto` alone computes
          `overflow-x: auto` (the other axis may not stay `visible`), so ONE unbreakable line in a
          message — an OS path in a permission-denied notice was the observed case — drew a
          horizontal scrollbar across the whole chat. NovaClaw runs on phones, so the chat must
          narrow its content to the viewport instead; the transcript's own rules make that content
          wrap (`native-transcript.css`), and this clips any residue that still would not. */}
      <div
        ref={(el) => (scroller = el)}
        class="h-full overflow-y-auto overflow-x-hidden"
        data-component="native-timeline"
      >
        <div ref={(el) => (content = el)}>
          <NativeTranscript
            messages={messages()}
            foldStateKey={props.sessionID}
            directory={props.directory}
            liveGeneratedTokens={serverSync().session.data.session_live(props.sessionID)?.approxTokens}
            maxToolTimeoutMs={props.maxToolTimeoutMs}
            executionOpen={props.executionOpen || reconciling()}
            waitLabel={waitLabel()}
            reasoningFold={reasoningFold()}
            toolFold={toolFold()}
            showCommandTiming={settings.appearance.commandTiming()}
            developer={expertise.level() === "developer"}
            pending={pending()}
            onRevert={props.onRevert}
            onRetry={props.onRetry}
            onChooseModel={props.onChooseModel}
            onUnpinDevice={props.onUnpinDevice}
            onStopCommand={props.onStopCommand}
            onCancelQueued={(messageID) => cancelQueued(messageID)}
            onEditQueued={(messageID) => cancelQueued(messageID, true)}
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
