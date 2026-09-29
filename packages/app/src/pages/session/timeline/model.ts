import type { SessionMessage, SessionMessageUser } from "@novaclaw/sdk/v2/client"
import { createEffect, createMemo, createSignal, type Accessor } from "solid-js"
import { useServerSync } from "@/context/server-sync"
import { selectVisibleMessages } from "@/pages/session/revert-view"
import { same } from "@/utils/same"

const emptyUserMessages: SessionMessageUser[] = []

/** What the transcript knows about its own history, as a value the view can read. */
export interface TimelineOutcome {
  /** A read is in flight. */
  readonly loading: boolean
  /** Why the last read failed, or `undefined` if it has not failed. */
  readonly error: unknown
}

export function createTimelineModel(input: {
  sessionID: Accessor<string | undefined>
  revertMessageID: Accessor<string | undefined>
}) {
  const serverSync = useServerSync()

  /**
   * 🔴 **A FAILED READ IS A STATE. IT IS NOT THE ABSENCE OF ONE.**
   *
   * Measured on the owner's own 0.1.81, 2026-09-29: clicking an officer in the roster left the
   * client a permanently blank window — not a spinner, not an error, an empty void with the tab
   * strip still drawn above it, for 25+ minutes at 0% CPU, while the window stayed responsive to
   * Windows. Three things had to be true at once, and only the first was anyone's fault:
   *
   *  1. `nativeMessages.load` rejected. The one place that learned this was
   *     `console.error("timeline message load failed", { sessionID, error })` — an OBJECT, so the
   *     renderer log wrote `[object Object]` and the single line naming the cause was unreadable.
   *  2. `ready` was `messages(id) !== undefined`, so a failed load and a not-yet-attempted one were
   *     the SAME value. Nothing could tell them apart, so nothing could recover.
   *  3. `session.tsx` gated the transcript on that flag with a `<Show>` that has no fallback, and
   *     the `ErrorBoundary` sat INSIDE the gate — so the empty state could not even be caught, let
   *     alone reported. The composer reads the same flag, so the whole conversation went with it.
   *
   * The effect below also only re-ran when `sessionID` changed, so one failure was permanent for
   * the life of the view: no retry, no recovery, no user-reachable control. `read()` is therefore
   * a real operation with a recorded outcome and a `retry` the view can offer, and the failure is
   * logged AS the error so the next occurrence names its own cause.
   */
  const [outcome, setOutcome] = createSignal<TimelineOutcome>({ loading: false, error: undefined })
  // A late rejection must not describe a session the user has already navigated away from.
  let run = 0

  const read = async (id: string): Promise<void> => {
    const mine = ++run
    setOutcome({ loading: true, error: undefined })
    try {
      await serverSync().nativeMessages.load(id)
      if (mine !== run) return
      setOutcome({ loading: false, error: undefined })
    } catch (error) {
      if (mine !== run) return
      console.error("timeline message load failed", error)
      setOutcome({ loading: false, error: error ?? new Error("This conversation could not be read.") })
    }
  }

  createEffect(() => {
    const id = input.sessionID()
    if (!id) return
    void read(id)
  })

  const messages = createMemo<readonly SessionMessage[]>(() => {
    const id = input.sessionID()
    return id ? (serverSync().nativeMessages.messages(id) ?? []) : []
  })
  const ready = createMemo(() => {
    const id = input.sessionID()
    return !id || serverSync().nativeMessages.messages(id) !== undefined
  })
  const userMessages = createMemo(() => selectUserMessages(messages()), emptyUserMessages, { equals: same })
  const visibleUserMessages = createMemo(
    () => selectVisibleUserMessages(userMessages(), input.revertMessageID()),
    emptyUserMessages,
    { equals: same },
  )

  const retry = () => {
    const id = input.sessionID()
    if (!id) return
    void read(id)
  }

  return {
    history: {
      loadOlder: async (_options?: { before?: () => void; after?: (done: boolean) => void }) => {},
      loading: () => false,
      more: () => false,
    },
    lastUserMessage: createMemo(() => visibleUserMessages().at(-1)),
    messages,
    ready,
    userMessages,
    visibleUserMessages,
    /**
     * The read's own outcome. `ready` alone cannot express "this failed", which is the whole
     * reason a dead transcript used to be indistinguishable from one still being fetched.
     */
    outcome,
    failed: createMemo(() => outcome().error !== undefined),
    retry,
  }
}

export function selectUserMessages(messages: readonly SessionMessage[]) {
  return messages.filter((message): message is SessionMessageUser => message.type === "user")
}

/**
 * User-message navigation under a staged revert. Delegates to the shared rule in
 * `session/revert-view.ts` — the transcript, the dock and the `/undo` commands all read that ONE
 * partition, so a message can never be hidden here while still drawn there (the 2026-07-29 bug).
 */
export function selectVisibleUserMessages(messages: readonly SessionMessageUser[], revertMessageID?: string) {
  return selectVisibleMessages(messages, revertMessageID)
}
