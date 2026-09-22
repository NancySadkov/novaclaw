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

/**
 * RE-VALIDATE the sessions the tab strip is holding, and retire the ones the server no longer has.
 *
 * 🔴 **Reconnect is the one moment a deletion can be missed for good.** `session.deleted` is an
 * EVENT, so a chat deleted by ANOTHER client (or the CLI) while this renderer was disconnected never
 * reports itself — and the tab pointing at it lingers until the user happens to open it. Owner,
 * 2026-09-22: *"better be safe than sorry and confused."*
 *
 * Bounded by the TABS, not the session cache: a reconnect costs one read per open tab, not one per
 * session ever fetched. Only an explicit not-found retires anything (`session.revalidate`), so a
 * flaky reconnect can never delete a live chat from the UI. Resolves to the ids it retired, and never
 * rejects — it runs on the connection barrier, where a rejection would keep the client offline.
 */
export function revalidateSessionTabs(input: {
  readonly session: {
    readonly revalidate: (sessionIDs: readonly string[], signal?: AbortSignal) => Promise<readonly string[]>
    readonly forget: (sessionID: string) => void
  }
  readonly tabs: {
    readonly ready: () => boolean
    readonly store: ReadonlyArray<
      | { readonly type: "session"; readonly server: ServerConnection.Key; readonly sessionId: string }
      | { readonly type: string; readonly server: ServerConnection.Key }
    >
    readonly removeSessionTab: (tab: { readonly server: ServerConnection.Key; readonly sessionId: string }) => void
  }
  readonly server: ServerConnection.Key
  readonly signal?: AbortSignal
}): Promise<readonly string[]> {
  // An un-hydrated strip has nothing to validate; the next connect re-runs this.
  if (!input.tabs.ready()) return Promise.resolve([])
  const sessionIDs = input.tabs.store
    .filter(
      (tab): tab is { readonly type: "session"; readonly server: ServerConnection.Key; readonly sessionId: string } =>
        tab.type === "session" && tab.server === input.server,
    )
    .map((tab) => tab.sessionId)
  if (sessionIDs.length === 0) return Promise.resolve([])
  return input.session
    .revalidate(sessionIDs, input.signal)
    .then((gone) => {
      for (const sessionID of gone)
        forgetGoneSession({ session: input.session, tabs: input.tabs, server: input.server, sessionID })
      return gone
    })
    .catch(() => [])
}
