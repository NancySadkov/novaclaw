import type { ServerConnection } from "./server"

/**
 * A CHAT THE SERVER NO LONGER HAS — retire every client-side trace in ONE place.
 *
 * 🔴 **The class, measured on the owner's live instance 2026-09-22 (`ses_daedalus`).** A deleted
 * chat left three client-side copies alive and each observer retired only its own slice:
 *
 *   · `message-v2-store` evicted the transcript it had just failed to read;
 *   · the session route closed the tab — but only when its lineage cache was EMPTY;
 *   · the composer's send path retired nothing and dead-ended on a toast.
 *
 * So a long-lived renderer that missed the `session.deleted` event (the sidecar restarted under it)
 * kept the session in `data.info`, the route rendered a chat that was gone, and every send failed
 * with `Session not found: <id>`. Restarting the app hid it, because a cold cache re-resolves —
 * which is exactly why it looked like a ghost rather than a bug.
 *
 * ⚠️ **One policy, called by every observer of GONE.** The tab closes with `stay`, so the route
 * renders its own "this chat is gone" card instead of navigating on the user's behalf; and the
 * CACHED RECORD is dropped, or the route would keep trusting it and never re-resolve.
 */
export function forgetGoneSession(input: {
  readonly session: { readonly forget: (sessionID: string) => void }
  readonly tabs: {
    readonly removeSessionTab: (tab: { readonly server: ServerConnection.Key; readonly sessionId: string }) => void
  }
  readonly server: ServerConnection.Key
  readonly sessionID: string
}): void {
  input.session.forget(input.sessionID)
  input.tabs.removeSessionTab({ server: input.server, sessionId: input.sessionID })
}
