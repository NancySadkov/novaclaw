import { useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { createMemo, Show } from "solid-js"
import { AppPage } from "@/components/app-page"
import { TeamChatScreen } from "@/components/team-chat-screen"
import { useGlobal } from "@/context/global"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { SDKProvider } from "@/context/sdk"

export function TeamChatPage() {
  const params = useParams<{ agentID: string }>()
  const [query] = useSearchParams<{ returnTo?: string }>()
  const navigate = useNavigate()
  const global = useGlobal()
  const server = useServer()
  const sync = useServerSync()
  /**
   * 🔴 The team chat is a full-window ROUTE, so nothing above it supplies the directory-scoped SDK
   * (`SDKProvider` is per-directory, not part of the global shell). Without this it rendered outside
   * its provider and threw "SDK context must be used within a context provider". The instance's own
   * default directory is the scope: the team chat is the officer's whole reporting team, not one
   * chat's folder.
   */
  const directory = createMemo(() => sync().data.path.directory)
  const roster = createMemo(() => {
    const current = server.current
    return current ? global.ensureServerCtx(current).agents.list() : []
  })
  const back = () => {
    const target = query.returnTo
    navigate(target?.startsWith("/") && !target.startsWith("//") ? target : "/tasks")
  }
  return (
    <AppPage class="flex flex-col overflow-hidden">
      <Show when={directory()} keyed>
        {(resolved) => (
          <SDKProvider directory={resolved}>
            <Show when={`${server.key}\n${params.agentID}`} keyed>
              {(_team) => <TeamChatScreen agentID={params.agentID} roster={roster()} onBack={back} />}
            </Show>
          </SDKProvider>
        )}
      </Show>
    </AppPage>
  )
}
