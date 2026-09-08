import { createEffect, createSignal, on, onCleanup } from "solid-js"
import { makeEventListener } from "@solid-primitives/event-listener"
import type { SessionPresenceSnapshot } from "@novaclaw/sdk/v2/client"
import { HEARTBEAT_SECONDS } from "./session-presence"

const VIEWER_STORAGE_KEY = "novaclaw.presence.viewer"

/**
 * This surface's viewer id.
 *
 * ⚠️ **`sessionStorage`, not `localStorage`, and that choice IS the feature.** `sessionStorage` is
 * per browser TAB, so two tabs are honestly two viewers while a reload of one tab stays the same
 * viewer. `localStorage` is shared across a whole browser profile, which would have made the two
 * tabs this component exists to tell apart look like one.
 */
export const viewerID = () => {
  try {
    const existing = sessionStorage.getItem(VIEWER_STORAGE_KEY)
    if (existing) return existing
    const created = `vw_${crypto.randomUUID()}`
    sessionStorage.setItem(VIEWER_STORAGE_KEY, created)
    return created
  } catch {
    // Private modes and embedded webviews can refuse storage. A per-load id still describes one
    // surface correctly; it just forgets itself across a reload, which the TTL cleans up.
    return `vw_${Math.random().toString(36).slice(2)}`
  }
}

export interface PresenceReport {
  sessionID: string
  viewerID: string
  label: string
  kind?: "human" | "agent" | "peer"
  writing?: boolean
  action?: "report" | "claim" | "detach"
}

/**
 * Keep this surface's presence current for as long as the chat is on screen.
 *
 * Three things drive a report: opening the chat, a heartbeat every {@link HEARTBEAT_SECONDS}
 * seconds, and the draft box going from empty to non-empty or back (so a brewing conflict is
 * visible on the other screen before anything is sent).
 *
 * ⚠️ **A hidden tab detaches.** Browsers throttle a background tab's timers to about one tick a
 * minute, which is slower than the instance's expiry budget — so a backgrounded tab left "attached"
 * would expire, reappear on focus, and flicker in everyone else's list. Detaching on hide is also
 * the more honest reading of the word: *attached* means a surface that is actually showing this
 * chat. It re-attaches the moment the tab comes back.
 */
export const createSessionPresence = (input: {
  sessionID: () => string | undefined
  label: () => string
  writing: () => boolean
  report: (report: PresenceReport) => Promise<SessionPresenceSnapshot | undefined>
}) => {
  const self = viewerID()
  const [visible, setVisible] = createSignal(typeof document === "undefined" || document.visibilityState !== "hidden")

  if (typeof document !== "undefined") {
    makeEventListener(document, "visibilitychange", () => setVisible(document.visibilityState !== "hidden"))
  }

  const send = (sessionID: string, action: PresenceReport["action"], writing: boolean) =>
    void input.report({ sessionID, viewerID: self, label: input.label(), writing, action })

  createEffect(
    on([input.sessionID, visible], ([sessionID, isVisible], previous) => {
      const previousID = previous?.[0]
      // Leaving a chat (or hiding the tab) says goodbye rather than waiting out the timeout — the
      // timeout is the backstop for a surface that vanished without the chance to.
      if (previousID && (previousID !== sessionID || !isVisible)) send(previousID, "detach", false)
      if (!sessionID || !isVisible) return
      send(sessionID, "report", input.writing())
      const timer = setInterval(() => send(sessionID, "report", input.writing()), HEARTBEAT_SECONDS * 1000)
      onCleanup(() => clearInterval(timer))
    }),
  )

  // A draft appearing or disappearing is news; a keystroke inside an existing draft is not. Gating
  // on the boolean keeps this to two extra requests per drafting session rather than one per key.
  createEffect(
    on(
      () => (input.sessionID() && visible() ? input.writing() : undefined),
      (writing, previous) => {
        if (writing === undefined || previous === undefined || writing === previous) return
        const sessionID = input.sessionID()
        if (sessionID) send(sessionID, "report", writing)
      },
    ),
  )

  onCleanup(() => {
    const sessionID = input.sessionID()
    if (sessionID) send(sessionID, "detach", false)
  })

  return {
    viewerID: self,
    /** Take the driving seat. Deliberate, announced to everyone attached, and never a refusal. */
    takeOver: () => {
      const sessionID = input.sessionID()
      if (sessionID) send(sessionID, "claim", input.writing())
    },
  }
}
