import { Tag } from "@novaclaw/ui/v2/badge-v2"
import { Icon as IconV2 } from "@novaclaw/ui/v2/icon"
import { IconButtonV2 } from "@novaclaw/ui/v2/icon-button-v2"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { useDialog } from "@novaclaw/ui/context/dialog"
import fuzzysort from "fuzzysort"
import { type Component, For, Show, createMemo, createResource } from "solid-js"
import { createStore } from "solid-js/store"
import { ServerRowMenu } from "@/components/server/server-row-menu"
import { ServerHealthIndicator } from "@/components/server/server-row"
import { useLanguage } from "@/context/language"
import { ServerConnection, normalizeServerUrl, serverName } from "@/context/server"
import { discoverInstances } from "@/utils/instance-discovery"
import { useServerManagementController } from "../dialog-select-server"
import { DialogServerV2 } from "./dialog-server-v2"
import { InstancesAccess } from "./instances-access"
import { SettingsListV2 } from "./parts/list"
import { AddServerMenu, isWslServer, useFilteredWslServers, WslServerSettings } from "@/wsl/settings"
import "./settings-v2.css"

export const SettingsServersV2: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const controller = useServerManagementController()
  const [store, setStore] = createStore({ filter: "" })
  const wslServers = useFilteredWslServers(() => store.filter)

  const showSearch = createMemo(
    () => controller.sortedItems().filter((item) => !isWslServer(item)).length + wslServers().length > 1,
  )

  const filtered = createMemo(() => {
    const items = controller.sortedItems().filter((item) => !isWslServer(item))
    const query = store.filter.trim()
    if (!query) return items
    return fuzzysort
      .go(query, items, {
        keys: [(item) => serverName(item), (item) => item.http.url],
      })
      .map((result) => result.obj)
  })

  const openAdd = () => {
    dialog.push(() => <DialogServerV2 mode="add" />)
  }

  const openEdit = (server: ServerConnection.Http) => {
    dialog.push(() => <DialogServerV2 mode="edit" server={server} />)
  }

  // R7: the LAN scan runs on an INSTANCE (the UI can't open multicast sockets) — prefer the
  // local one (it shares the user's network); any known instance works as a fallback.
  const scanner = createMemo(() => {
    const candidates = controller.sortedItems().filter((item) => !isWslServer(item))
    return candidates.find((item) => ServerConnection.local(item)) ?? candidates[0]
  })
  const [discovered, discoveredActions] = createResource(
    () => scanner(),
    (conn) => discoverInstances(conn.http).catch(() => []),
    { initialValue: [] },
  )
  const knownUrls = createMemo(
    () =>
      new Set(controller.sortedItems().flatMap((item) => (item.http.url ? [normalizeServerUrl(item.http.url)] : []))),
  )
  const discoverable = createMemo(() =>
    discovered.latest.filter((instance) => !instance.self && !knownUrls().has(normalizeServerUrl(instance.url))),
  )

  const openAddDiscovered = (url: string) => {
    dialog.push(() => <DialogServerV2 mode="add" presetUrl={url} />)
  }

  return (
    <>
      <div
        class="settings-v2-tab-header settings-v2-servers-header"
        classList={{ "settings-v2-tab-header--stacked": showSearch() }}
      >
        <div class="settings-v2-tab-header-row">
          <h2 class="settings-v2-tab-title">{language.t("settings.tab.instances")}</h2>
          <AddServerMenu onAddServer={openAdd} />
        </div>
        <Show when={showSearch()}>
          <div class="settings-v2-tab-search">
            <TextInputV2
              type="search"
              appearance="base"
              value={store.filter}
              onInput={(event) => setStore("filter", event.currentTarget.value)}
              placeholder={language.t("dialog.server.search.placeholder")}
              spellcheck={false}
              autocorrect="off"
              autocomplete="off"
              autocapitalize="off"
              aria-label={language.t("dialog.server.search.placeholder")}
            />
            <Show when={store.filter}>
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="small"
                class="settings-v2-tab-search-clear"
                icon={<IconV2 name="close" size="large" class="text-v2-icon-icon-muted" />}
                onClick={() => setStore("filter", "")}
              />
            </Show>
          </div>
        </Show>
      </div>

      <div class="settings-v2-tab-body settings-v2-servers">
        <InstancesAccess />
        <Show
          when={filtered().length > 0 || wslServers().length > 0}
          fallback={
            <div class="settings-v2-servers-status">
              <span>{store.filter ? language.t("palette.empty") : language.t("dialog.server.empty")}</span>
              <Show when={store.filter}>
                <span class="settings-v2-servers-status-filter">&quot;{store.filter}&quot;</span>
              </Show>
            </div>
          }
        >
          <SettingsListV2>
            <WslServerSettings controller={controller} servers={wslServers} />
            <For each={filtered()}>
              {(item) => {
                const key = ServerConnection.key(item)
                const health = () => controller.status()[key]
                const isDefault = () => controller.defaultKey() === key
                return (
                  <div class="settings-v2-servers-row">
                    <div class="settings-v2-servers-lead">
                      <ServerHealthIndicator health={health()} />
                      <div class="settings-v2-servers-copy">
                        <span class="settings-v2-servers-name">{serverName(item)}</span>
                        <span class="settings-v2-servers-meta">
                          {/* From-source instances report the literal version "local" — render it
                              as a label instead of the nonsense "vlocal". */}
                          <Show when={health()?.version}>
                            {(v) => (v() === "local" ? language.t("server.row.devBuild") : `v${v()}`)}
                          </Show>
                          <Show when={health()?.version && item.type === "http"}> • </Show>
                          <Show
                            when={item.type === "http" && item.http.username}
                            fallback={<Show when={item.type === "http"}>{language.t("server.row.noUsername")}</Show>}
                          >
                            {item.http.username}
                          </Show>
                        </span>
                      </div>
                    </div>
                    <div class="settings-v2-servers-actions">
                      <Show when={controller.canDefault() && isDefault()}>
                        <Tag>{language.t("dialog.server.status.default")}</Tag>
                      </Show>
                      <ServerRowMenu server={item} controller={controller} onEdit={openEdit} />
                    </div>
                  </div>
                )
              }}
            </For>
          </SettingsListV2>
        </Show>

        {/* R7: NovaClaw instances advertising on the LAN (serve --mdns) — add one without typing
            an address. Hidden while the scan finds nothing beyond what's already saved. */}
        <Show when={discoverable().length > 0}>
          <div class="settings-v2-servers-discovered">
            <div class="settings-v2-tab-header-row">
              <h3 class="settings-v2-section-title">{language.t("settings.instances.discovered.title")}</h3>
              <IconButtonV2
                type="button"
                variant="ghost-muted"
                size="small"
                disabled={discovered.loading}
                icon={<IconV2 name="refresh" size="large" class="text-v2-icon-icon-muted" />}
                aria-label={language.t("settings.instances.discovered.rescan")}
                onClick={() => void discoveredActions.refetch()}
              />
            </div>
            <SettingsListV2>
              <For each={discoverable()}>
                {(instance) => (
                  <div class="settings-v2-servers-row">
                    <div class="settings-v2-servers-lead">
                      <div class="settings-v2-servers-copy">
                        <span class="settings-v2-servers-name">{instance.name}</span>
                        <span class="settings-v2-servers-meta">
                          {instance.url.replace(/^https?:\/\//, "")}
                          <Show when={instance.version}>
                            {(v) => <> • {v() === "local" ? language.t("server.row.devBuild") : `v${v()}`}</>}
                          </Show>
                        </span>
                      </div>
                    </div>
                    <div class="settings-v2-servers-actions">
                      <IconButtonV2
                        type="button"
                        variant="ghost-muted"
                        size="small"
                        icon={<IconV2 name="plus" size="large" class="text-v2-icon-icon-muted" />}
                        aria-label={language.t("settings.instances.discovered.add")}
                        onClick={() => openAddDiscovered(instance.url)}
                      />
                    </div>
                  </div>
                )}
              </For>
            </SettingsListV2>
          </div>
        </Show>
      </div>
    </>
  )
}
