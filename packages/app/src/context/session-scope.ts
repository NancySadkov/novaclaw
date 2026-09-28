import { createContext, useContext, type Accessor } from "solid-js"
import { useParams } from "@solidjs/router"

/**
 * The session a page is currently showing, RESOLVED THROUGH ITS AGENT.
 *
 * 🔴 AGENTS.md's OS idiom: an agent session is a PROCESS and the agent is the entity it runs as. A
 * route therefore addresses the AGENT (`/server/<key>/agent/<agentID>`), and the session id is a
 * component reached THROUGH it — never a first-class address. Clear Chat then changes the component,
 * not the place: the route, the tab and anything open on it (a context inspector, a composer draft)
 * keep their identity, because none of them ever named the transcript.
 *
 * `undefined` means this page is NOT agent-addressed — a worker, an anonymous chat, or a legacy
 * `session/<id>` deep link. Those genuinely ARE addressed by a session id, and `useSessionKey` falls
 * back to the route param for them.
 */
export interface SessionScope {
  /** The resolved session id for this page, or `undefined` while it is still resolving. */
  readonly sessionID: Accessor<string | undefined>
  /**
   * Ask the agent route to re-resolve the colleague's CURRENT session — used after Clear Chat, so the
   * page follows the colleague to its new transcript WITHOUT navigating anywhere.
   */
  readonly refresh: () => void
}

const SessionScopeContext = createContext<SessionScope>()

export const SessionScopeProvider = SessionScopeContext.Provider

export const useSessionScope = (): SessionScope | undefined => useContext(SessionScopeContext)

export const useResolvedSessionID = () => {
  const params = useParams<{ id?: string }>()
  const scope = useSessionScope()
  return (): string | undefined => (scope ? scope.sessionID() : params.id)
}
