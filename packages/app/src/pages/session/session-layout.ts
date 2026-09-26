import { useParams } from "@solidjs/router"
import { createMemo } from "solid-js"
import { useLayout } from "@/context/layout"
import { useSessionScope } from "@/context/session-scope"
import { SessionRouteKey, SessionStateKey } from "@/utils/server-scope"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { base64Encode } from "@novaclaw/core/util/encode"

/**
 * 🔴 **THE ONE ANSWER to "which session is this page showing".**
 *
 * A route may address a chat (`/server/<key>/session/<id>`) or a COLLEAGUE
 * (`/server/<key>/agent/<agentID>`), and under the colleague there is no `id` param at all — the
 * chat is a component reached through the agent (`context/session-scope.ts`). So a component that
 * reads `useParams().id` is not reading "the session"; it is reading "the session, when the URL
 * happens to name one", and under a colleague it silently reads `undefined`.
 *
 * That is not hypothetical. Measured live in the packaged desktop app, 2026-09-26: the composer's
 * Stop click ran `abort()`, `abort()` read `params.id`, got `undefined`, and returned — no request,
 * no spinner, no error, while the button read Stop and the agent streamed. Esc worked because the
 * session PAGE's own keyboard controller passes its own `stop`, not the composer's. The button took
 * its "is it working" from `controls.session.id` (right) and its "which session to stop" from the
 * route (absent): one fact, two sources, and the two are allowed to disagree.
 *
 * Every read of a session identity in the session tree goes through here. `useSessionKey` is its
 * first consumer, not its owner.
 */
export const useResolvedSessionID = () => {
  const params = useParams<{ id?: string }>()
  const scope = useSessionScope()
  return (): string | undefined => scope?.sessionID() ?? params.id
}

export const useSessionKey = () => {
  const params = useParams()
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const serverScope = createMemo(() => serverSDK().scope)
  const directory = createMemo(() => base64Encode(sdk().directory))
  const workspaceKey = createMemo(() => SessionStateKey.from(serverScope(), SessionRouteKey.fromRoute(directory())))
  // 🔴 The page's session id is the AGENT-RESOLVED one when the route addresses an agent, and the
  // route param otherwise. This is the single seam AGENTS.md's "session is a component on the agent"
  // asks for: the agent can be handed a NEW session (Clear Chat) without the route, the tab or any
  // open dialog changing identity, because none of them names the transcript.
  const sessionID = useResolvedSessionID()
  // `params.id` is read as a PROPERTY all over the session tree, so the proxy keeps that spelling
  // reactive while it answers with the resolved id. Other params pass through untouched.
  const scopedParams = new Proxy(params as Record<string, unknown>, {
    get: (target, key) => (key === "id" ? sessionID() : Reflect.get(target, key)),
  }) as typeof params
  const sessionKey = createMemo(() =>
    SessionStateKey.from(serverScope(), SessionRouteKey.fromRoute(directory(), sessionID())),
  )
  return { params: scopedParams, sessionKey, workspaceKey }
}

export const useSessionLayout = () => {
  const layout = useLayout()
  const { params, sessionKey, workspaceKey } = useSessionKey()
  return {
    params,
    sessionKey,
    workspaceKey,
    tabs: createMemo(() => layout.tabs(sessionKey)),
    view: createMemo(() => layout.view(sessionKey)),
  }
}
