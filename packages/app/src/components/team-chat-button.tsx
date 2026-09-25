import { createMemo, Show } from "solid-js"
import { Icon } from "@novaclaw/ui/v2/icon"
import { IconButtonV2 } from "@novaclaw/ui/v2/icon-button-v2"
import { TooltipV2 } from "@novaclaw/ui/v2/tooltip-v2"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { TeamChatDialog } from "@/components/team-chat-dialog"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useSync } from "@/context/sync"

export function TeamChatButton(props: { sessionID: string }) {
  const dialog = useDialog()
  const global = useGlobal()
  const language = useLanguage()
  const server = useServer()
  const sync = useSync()

  const session = createMemo(() => sync().session.get(props.sessionID))
  const roster = createMemo(() => {
    const current = server.current
    return current ? global.ensureServerCtx(current).agents.list() : []
  })
  const officer = createMemo(() => {
    const info = session()
    if (!info?.agent || info.parentID) return
    const match = roster().find((agent) => agent.id === info.agent)
    if (!match || match.mode === "subagent" || match.hidden) return
    const kind = match.config?.["kind"]
    if (kind === "chat" || kind === "human" || match.config?.["shortChat"] === true) return
    return match
  })

  const open = () => {
    const current = officer()
    if (!current) return
    void dialog.showScoped(() => <TeamChatDialog agentID={current.id} roster={roster()} />)
  }

  return (
    <Show when={officer()}>
      <TooltipV2 placement="top" gutter={4} value={language.t("teamChat.open")}>
        <IconButtonV2
          type="button"
          variant="ghost-muted"
          size="large"
          icon={<Icon name="chats" class="size-4 text-v2-icon-icon-accent" />}
          onClick={open}
          aria-label={language.t("teamChat.open")}
          data-action="team-chat"
        />
      </TooltipV2>
    </Show>
  )
}
