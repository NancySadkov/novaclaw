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
    (tab) => tab.type === "session" && tab.server === server && tab.agent === agent && tab.sessionId !== exceptSession,
  )
}
