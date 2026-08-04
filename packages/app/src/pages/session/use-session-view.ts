import { createMemo, type Accessor } from "solid-js"
import { base64Encode } from "@novaclaw/core/util/encode"
import { useSDK } from "@/context/sdk"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { Persist } from "@/utils/persist"
import { SessionRouteKey, SessionStateKey } from "@/utils/server-scope"

/**
 * The ONE per-session client facade (ui-arch P5). Every per-session question a view
 * component has — the live record, working state, the canonical scope/key, where its
 * persisted state lives — is answered here, so no consumer hand-assembles a scope or
 * picks between sync/serverSync/serverCtx by folklore (the 2026-07-14 draft-seed bug
 * wrote a sibling localStorage key exactly that way).
 *
 * - `record` reads the SERVER-scoped session store (`serverSync().session`) — the
 *   canonical, P2-live-folded record. Deliberately NOT the directory store's
 *   directory-guarded getter: the record survives a folder move mid-rebind.
 * - `persistTarget` is the single answer to "the persisted key for session X"
 *   (workspace-scoped while the id is undefined, session-scoped once it exists).
 *   Draft-tab state is keyed by draftID via `Persist.draft` — a different lifetime
 *   (deleted with the tab), owned by the prompt/tabs contexts.
 */
export function useSessionView(sessionID: Accessor<string | undefined>) {
  const sdk = useSDK()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()

  const scope = createMemo(() => serverSDK().scope)
  const directory = createMemo(() => sdk().directory)
  const sessionKey = createMemo(() =>
    SessionStateKey.from(scope(), SessionRouteKey.fromRoute(base64Encode(directory()), sessionID())),
  )
  const record = createMemo(() => {
    const id = sessionID()
    return id ? serverSync().session.get(id) : undefined
  })
  const working = createMemo(() => {
    const id = sessionID()
    return id ? serverSync().session.data.session_working(id) : false
  })
  const persistTarget = (key: string, legacy?: string[]) =>
    Persist.serverScoped(scope(), directory(), sessionID(), key, legacy)

  return { sessionID, scope, directory, sessionKey, record, working, persistTarget }
}

export type SessionView = ReturnType<typeof useSessionView>
