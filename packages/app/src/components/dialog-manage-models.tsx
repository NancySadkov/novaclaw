import { Dialog } from "@novaclaw/ui/dialog"
import { List } from "@novaclaw/ui/list"
import { Switch } from "@novaclaw/ui/switch"
import { Tooltip } from "@novaclaw/ui/tooltip"
import { Button } from "@novaclaw/ui/button"
import type { Component } from "solid-js"
import { useLocal } from "@/context/local"
import { useServer } from "@/context/server"
import { popularProviders } from "@/hooks/use-providers"
import { useLanguage } from "@/context/language"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { decode64 } from "@/utils/base64"

export const DialogManageModels: Component = () => {
  const local = useLocal()
  const server = useServer()
  const language = useLanguage()
  const dialog = useDialog()
  const directory = () => decode64(local.slug())

  // Provider-import P3: the Add-models flow owns provider onboarding; without a live
  // server + directory, degrade to Settings → Models (which resolves its own routing).
  const handleConnectProvider = () => {
    const http = server.current?.http
    const dir = directory()
    if (http && dir) {
      void import("./settings-v2/dialog-new-model").then((x) => {
        dialog.show(() => <x.DialogNewModel http={http} directory={dir} />)
      })
      return
    }
    void import("./settings-v2").then((x) => {
      dialog.show(() => <x.DialogSettings defaultTab="models" />)
    })
  }
  const providerRank = (id: string) => popularProviders.indexOf(id)
  const providerList = (providerID: string) => local.model.list().filter((x) => x.provider.id === providerID)
  const providerVisible = (providerID: string) =>
    providerList(providerID).every((x) => local.model.visible({ modelID: x.id, providerID: x.provider.id }))
  const setProviderVisibility = (providerID: string, checked: boolean) => {
    providerList(providerID).forEach((x) => {
      local.model.setVisibility({ modelID: x.id, providerID: x.provider.id }, checked)
    })
  }

  return (
    <Dialog
      title={language.t("dialog.model.manage")}
      description={language.t("dialog.model.manage.description")}
      action={
        <Button class="h-7 -my-1 text-14-medium" icon="plus-small" tabIndex={-1} onClick={handleConnectProvider}>
          {language.t("command.provider.connect")}
        </Button>
      }
    >
      <List
        class="px-3"
        search={{ placeholder: language.t("dialog.model.search.placeholder"), autofocus: true }}
        emptyMessage={language.t("dialog.model.empty")}
        key={(x) => `${x?.provider?.id}:${x?.id}`}
        items={local.model.list()}
        filterKeys={["provider.name", "name", "id"]}
        sortBy={(a, b) => a.name.localeCompare(b.name)}
        groupBy={(x) => x.provider.id}
        groupHeader={(group) => {
          const provider = group.items[0].provider
          return (
            <>
              <span>{provider.name}</span>
              <Tooltip
                placement="top"
                value={language.t("dialog.model.manage.provider.toggle", { provider: provider.name })}
              >
                <Switch
                  class="-mr-1"
                  checked={providerVisible(provider.id)}
                  onChange={(checked) => setProviderVisibility(provider.id, checked)}
                  hideLabel
                >
                  {provider.name}
                </Switch>
              </Tooltip>
            </>
          )
        }}
        sortGroupsBy={(a, b) => {
          const aRank = providerRank(a.items[0].provider.id)
          const bRank = providerRank(b.items[0].provider.id)
          const aPopular = aRank >= 0
          const bPopular = bRank >= 0
          // The list only carries connected providers, so the old source==="config"
          // first-clause was a no-op; popularity is the remaining rank.
          if (aPopular && !bPopular) return -1
          if (!aPopular && bPopular) return 1
          return aRank - bRank
        }}
        onSelect={(x) => {
          if (!x) return
          const key = { modelID: x.id, providerID: x.provider.id }
          local.model.setVisibility(key, !local.model.visible(key))
        }}
      >
        {(i) => (
          <div class="w-full flex items-center justify-between gap-x-3">
            <span>{i.name}</span>
            <div onClick={(e) => e.stopPropagation()}>
              <Switch
                checked={!!local.model.visible({ modelID: i.id, providerID: i.provider.id })}
                onChange={(checked) => {
                  local.model.setVisibility({ modelID: i.id, providerID: i.provider.id }, checked)
                }}
              />
            </div>
          </div>
        )}
      </List>
    </Dialog>
  )
}
