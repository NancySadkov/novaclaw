import { createMemo } from "solid-js"
import { RemoteChatSection, type ComposerRemoteChatState } from "@/components/composer/features-control"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useServer } from "@/context/server"
import { useSettingsDialog } from "@/components/settings-dialog"
import { createSettledResource } from "@/utils/settled-resource"
import {
  MessengerApiError,
  messengerAccountChats,
  messengerAccounts,
  messengerBindings,
  messengerCreateBinding,
  messengerDrivers,
  messengerRemoveBinding,
} from "@/utils/messenger-api"
import { showToast } from "@/utils/toast"

export function AgentRemoteChat(props: {
  sessionID: () => string | undefined
  ensureSession: () => Promise<string | undefined>
}) {
  const language = useLanguage()
  const server = useServer()
  const global = useGlobal()
  const openSettings = useSettingsDialog("messengers")
  const connection = createMemo(() => server.current ?? global.servers.list()[0])
  const http = () => connection()?.http
  const [drivers] = createSettledResource(http, messengerDrivers)
  const [accounts, accountActions] = createSettledResource(http, messengerAccounts)
  const [bindings, bindingActions] = createSettledResource(http, messengerBindings)
  const driverName = (id: string) => (drivers() ?? []).find((driver) => driver.id === id)?.name ?? id
  const failed = (error: unknown) =>
    showToast({
      variant: "error",
      title: language.t("prompt.remote.toast.failed"),
      description: error instanceof Error ? error.message : String(error),
    })

  const state = createMemo<ComposerRemoteChatState>(() => {
    const sessionID = props.sessionID()
    const accountRows = accounts() ?? []
    const bindingRows = bindings() ?? []
    const row = sessionID ? bindingRows.find((entry) => entry.binding.sessionID === sessionID) : undefined
    const account = row ? accountRows.find((entry) => entry.account.id === row.binding.accountID) : undefined
    return {
      availability:
        accounts.failed || bindings.failed ? "failed" : accounts.loading || bindings.loading ? "loading" : "ready",
      // Connecting may create the colleague's canonical chat first; the user never has to know an id.
      bindable: true,
      accounts: accountRows
        .filter((entry) => entry.account.enabled)
        .map((entry) => ({
          id: entry.account.id,
          label: entry.account.label,
          driverName: driverName(entry.account.driverID),
          state: entry.status.state,
        })),
      binding: row
        ? {
            id: row.binding.id,
            driverName: driverName(account?.account.driverID ?? row.binding.accountID),
            chatTitle: row.chatTitle ?? row.binding.chatID,
            trust: row.binding.trust,
            accountState: account?.status.state ?? "disabled",
          }
        : undefined,
      loadChats: (accountID) => {
        const target = http()
        if (!target) return Promise.resolve({ ok: false, chats: [], reason: "No instance is connected" })
        return messengerAccountChats(target, accountID).catch((error: unknown) => ({
          ok: false,
          chats: [],
          reason: error instanceof Error ? error.message : String(error),
        }))
      },
      connect: async (input) => {
        const target = http()
        const sessionID = props.sessionID() ?? (await props.ensureSession())
        if (!target || !sessionID) return "failed"
        try {
          await messengerCreateBinding(target, { ...input, sessionID })
          void bindingActions.refetch()
          void accountActions.refetch()
          return "ok"
        } catch (error) {
          if (error instanceof MessengerApiError && error.kind === "messenger_chat_bound" && !input.steal)
            return "bound"
          failed(error)
          return "failed"
        }
      },
      disconnect: async () => {
        const target = http()
        const sessionID = props.sessionID()
        const bound = sessionID ? (bindings() ?? []).find((entry) => entry.binding.sessionID === sessionID) : undefined
        if (!target || !bound) return
        try {
          await messengerRemoveBinding(target, bound.binding.id)
          void bindingActions.refetch()
        } catch (error) {
          failed(error)
        }
      },
      openSettings,
    }
  })

  return <RemoteChatSection remote={state()} />
}
