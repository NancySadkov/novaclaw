import type { ServerConnection } from "./server"
import type { Tab } from "./tabs"

/**
 * Index of the tab already open for `agent`, or -1.
 *
 * 🔴 **ONE TAB PER COLLEAGUE** (owner, 2026-08-28: *"under no circumstances there can be two or more
 * tabs from the same agent, and instead of opening a new one, the Nova switches to the existing
 * tab"*). A colleague has ONE chat, so two tabs bearing one name are always the app disagreeing with
 * its own kernel — and they are indistinguishable in the strip, because both are labelled with that
 * colleague's name. Four tabs all reading "Nova" were open when this was reported.
 *
 * ⚠️ Keyed on the COLLEAGUE, not the session id. Session-id dedupe already existed in the tab store
 * and was not enough: it is precisely what allowed those four, each holding a different session the
 * same colleague owns. Where the two keys disagree the colleague wins — that is the identity the
 * user is looking at.
 *
 * ⚠️ `agent: undefined` finds NOTHING, deliberately. A chat with no colleague opts out rather than
 * colliding every anonymous session into a single tab; that is also what a tab persisted before the
 * field existed looks like, until the strip fills it in.
 *
 * ⚠️ Its own MODULE, not a function in `tabs.tsx`. Importing `tabs.tsx` pulls in the router, which
 * needs a DOM to load at all — fine under the unit suite's `happydom` preload, and an instant death
 * outside it. Keeping the rule where it can be read without a DOM means the one thing worth pinning
 * does not depend on the harness that surrounds it.
 */
export function findAgentTab(
  tabs: readonly Tab[],
  server: ServerConnection.Key,
  agent: string | undefined,
  exceptSession?: string,
) {
  if (agent === undefined) return -1
  return tabs.findIndex(
    (tab) =>
      tab.type === "session" &&
      tab.worker !== true &&
      tab.server === server &&
      tab.agent === agent &&
      tab.sessionId !== exceptSession,
  )
}

/**
 * Which COLLEAGUE owns the session a route names, or `undefined` for a chat with no colleague.
 *
 * 🔴 **This is the key that makes a GONE session id recoverable** (owner, 2026-09-26). The tab strip
 * and the route used to be keyed on the session id alone, so once "Clear chat" removed an officer's
 * transcript — or the sidecar restarted mid-clear and the replacement was never opened — the route
 * named an id the server no longer had and rendered *"This chat was deleted or has expired"*. That
 * card is impossible by design here: a colleague is an ENTITY and its chat is a COMPONENT reached
 * through it, so an officer route must follow the colleague to whatever chat it holds NOW, and never
 * be retired because one transcript id went away. `undefined` keeps that policy off worker and
 * anonymous chats, which genuinely have no entity to follow.
 */
export function officerTabAgent(
  tabs: readonly Tab[],
  server: ServerConnection.Key,
  sessionID: string | undefined,
): string | undefined {
  if (sessionID === undefined) return undefined
  const tab = tabs.find(
    (item): item is Extract<Tab, { type: "session" }> =>
      item.type === "session" && item.server === server && item.sessionId === sessionID,
  )
  if (tab === undefined || tab.worker === true) return undefined
  return tab.agent
}
