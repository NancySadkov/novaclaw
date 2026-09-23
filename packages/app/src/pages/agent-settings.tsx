import { useNavigate, useParams, useSearchParams } from "@solidjs/router"
import { AgentConfigScreen } from "@/components/agent-config-dialog"
import { useGlobal } from "@/context/global"
import { useServer } from "@/context/server"
import { AppPage } from "@/components/app-page"
import { Show } from "solid-js"

export function AgentSettingsPage() {
  const params = useParams<{ agentID: string }>()
  const [query] = useSearchParams<{ returnTo?: string }>()
  const navigate = useNavigate()
  const global = useGlobal()
  const server = useServer()
  const dismiss = () => {
    const target = query.returnTo
    navigate(target?.startsWith("/") && !target.startsWith("//") ? target : "/tasks")
  }
  return (
    <AppPage class="flex flex-col overflow-hidden">
      <Show when={`${server.key}\n${params.agentID}`} keyed>
        {(_identity) => (
          <AgentConfigScreen
            agentID={params.agentID}
            onDismiss={dismiss}
            onChanged={() => {
              const conn = server.current ?? global.servers.list()[0]
              if (conn) global.ensureServerCtx(conn).agents.refetch()
            }}
          />
        )}
      </Show>
    </AppPage>
  )
}
