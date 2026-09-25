import { useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { createMemo, Show } from "solid-js"
import { AppPage } from "@/components/app-page"
import { TeamChatScreen } from "@/components/team-chat-screen"
import { useGlobal } from "@/context/global"
import { useServer } from "@/context/server"

export function TeamChatPage() {
  const params = useParams<{ agentID: string }>()
  const [query] = useSearchParams<{ returnTo?: string }>()
  const navigate = useNavigate()
  const global = useGlobal()
  const server = useServer()
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
      <Show when={`${server.key}\n${params.agentID}`} keyed>
        {(_identity) => <TeamChatScreen agentID={params.agentID} roster={roster()} onBack={back} />}
      </Show>
    </AppPage>
  )
}
