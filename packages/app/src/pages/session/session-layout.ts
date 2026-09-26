import { useParams } from "@solidjs/router"
import { createMemo } from "solid-js"
import { useLayout } from "@/context/layout"
import { useSessionScope } from "@/context/session-scope"
import { SessionRouteKey, SessionStateKey } from "@/utils/server-scope"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { base64Encode } from "@novaclaw/core/util/encode"

export const useSessionKey = () => {
  const params = useParams()
  const scope = useSessionScope()
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const serverScope = createMemo(() => serverSDK().scope)
  const directory = createMemo(() => base64Encode(sdk().directory))
  const workspaceKey = createMemo(() => SessionStateKey.from(serverScope(), SessionRouteKey.fromRoute(directory())))
  // 🔴 The page's session id is the AGENT-RESOLVED one when the route addresses an agent, and the
  // route param otherwise. This is the single seam AGENTS.md's "session is a component on the agent"
  // asks for: the agent can be handed a NEW session (Clear Chat) without the route, the tab or any
  // open dialog changing identity, because none of them names the transcript.
  const sessionID = () => scope?.sessionID() ?? params.id
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
