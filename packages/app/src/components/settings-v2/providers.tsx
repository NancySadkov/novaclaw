import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { Tag } from "@novaclaw/ui/v2/badge-v2"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { ProviderIcon } from "@novaclaw/ui/provider-icon"
import { showToast } from "@/utils/toast"
import { popularProviders, useProviders } from "@/hooks/use-providers"
import { createMemo, type Component, For, Show } from "solid-js"
import type { Config } from "@novaclaw/sdk/v2/client"
import { useLanguage } from "@/context/language"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { DialogConnectProvider } from "../dialog-connect-provider"
import { DialogSelectProvider } from "../dialog-select-provider"
import { DialogCustomProvider } from "../dialog-custom-provider"
import { SettingsListV2 } from "./parts/list"
import "./settings-v2.css"

type ProviderSource = "env" | "api" | "config" | "custom"
type ProviderItem = ReturnType<ReturnType<typeof useProviders>["connected"]>[number]

const PROVIDER_NOTES = [
  { match: (id: string) => id === "anthropic", key: "dialog.provider.anthropic.note" },
  { match: (id: string) => id.startsWith("github-copilot"), key: "dialog.provider.copilot.note" },
  { match: (id: string) => id === "openai", key: "dialog.provider.openai.note" },
  { match: (id: string) => id === "google", key: "dialog.provider.google.note" },
  { match: (id: string) => id === "openrouter", key: "dialog.provider.openrouter.note" },
  { match: (id: string) => id === "vercel", key: "dialog.provider.vercel.note" },
] as const

const PROVIDER_ICON_SIZE = 16

export const SettingsProvidersV2: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const serverSdk = useServerSDK()
  const serverSync = useServerSync()
  const providers = useProviders()

  const connected = createMemo(() => {
    return providers.connected()
  })

  const popular = createMemo(() => {
    const connectedIDs = new Set(connected().map((p) => p.id))
    const items = providers
      .popular()
      .filter((p) => !connectedIDs.has(p.id))
      .slice()
    items.sort((a, b) => popularProviders.indexOf(a.id) - popularProviders.indexOf(b.id))
    return items
  })

  const source = (item: ProviderItem): ProviderSource | undefined => {
    if (!("source" in item)) return
    const value = item.source
    if (value === "env" || value === "api" || value === "config" || value === "custom") return value
    return
  }

  const type = (item: ProviderItem) => {
    const current = source(item)
    if (current === "env") return language.t("settings.providers.tag.environment")
    if (current === "api") return language.t("provider.connect.method.apiKey")
    if (current === "config") {
      if (isConfigCustom(item.id)) return language.t("settings.providers.tag.custom")
      return language.t("settings.providers.tag.config")
    }
    if (current === "custom") return language.t("settings.providers.tag.custom")
    return language.t("settings.providers.tag.other")
  }

  const canDisconnect = (item: ProviderItem) => source(item) !== "env"

  const note = (id: string) => PROVIDER_NOTES.find((item) => item.match(id))?.key

  const isConfigCustom = (providerID: string) => {
    const provider = serverSync().data.config.provider?.[providerID]
    if (!provider) return false
    if (provider.npm !== "@ai-sdk/openai-compatible") return false
    if (!provider.models || Object.keys(provider.models).length === 0) return false
    return true
  }

  const disableProvider = async (providerID: string, name: string) => {
    const before = serverSync().data.config.disabled_providers ?? []
    const next = before.includes(providerID) ? before : [...before, providerID]
    serverSync().set("config", "disabled_providers", next)

    await serverSync()
      .updateConfig({ disabled_providers: next })
      .then(() => {
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("provider.disconnect.toast.disconnected.title", { provider: name }),
          description: language.t("provider.disconnect.toast.disconnected.description", { provider: name }),
        })
      })
      .catch((err: unknown) => {
        serverSync().set("config", "disabled_providers", before)
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
  }

  const disconnect = async (providerID: string, name: string) => {
    if (isConfigCustom(providerID)) {
      await serverSdk()
        .client.auth.remove({ providerID })
        .catch(() => undefined)
      await disableProvider(providerID, name)
      return
    }
    await serverSdk()
      .client.auth.remove({ providerID })
      .then(async () => {
        await serverSdk().client.global.dispose()
        showToast({
          variant: "success",
          icon: "circle-check",
          title: language.t("provider.disconnect.toast.disconnected.title", { provider: name }),
          description: language.t("provider.disconnect.toast.disconnected.description", { provider: name }),
        })
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err)
        showToast({ title: language.t("common.requestFailed"), description: message })
      })
  }

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.providers.title")}</h2>
        <div style="display:flex;gap:8px;margin-top:12px">
          <ButtonV2 size="small" variant="neutral" icon="download"
            onClick={async () => {
              const cfg = serverSync().data.config
              const jsonc = generateConfigTemplate(cfg)
              const api = (window as any).api
              if (!api?.saveFilePicker || !api?.writeFile) return
              const path = await api.saveFilePicker({ title: "Export novaclaw.jsonc", defaultPath: "novaclaw.jsonc" })
              if (!path) return
              await api.writeFile(path, jsonc)
              showToast({ variant: "success", icon: "circle-check", title: "Config exported", description: path })
            }}
          >Export</ButtonV2>
          <ButtonV2 size="small" variant="neutral" icon="upload"
            onClick={async () => {
              const api = (window as any).api
              if (!api?.openFilePicker || !api?.readPickedFile) return
              const result = await api.openFilePicker({ title: "Import novaclaw.jsonc", extensions: ["jsonc", "json"] })
              if (!result?.files?.length) return
              const buf = await api.readPickedFile(result.token, result.files[0].path)
              const content = new TextDecoder().decode(buf)
              const parsed = parseJSONC(content)
              if (!parsed) {
                showToast({ variant: "error", title: "Invalid JSONC", description: "Could not parse the config file." })
                return
              }
              // Persist via the server (updateGlobal patch-merges into the global
              // novaclaw.jsonc and refetches the config query). A bare set() is a
              // no-op here: globalStore.config is a getter over the config query.
              const ok = await serverSync()
                .updateConfig(parsed as unknown as Config)
                .then(() => true)
                .catch((err: unknown) => {
                  showToast({
                    variant: "error",
                    title: "Import failed",
                    description: err instanceof Error ? err.message : String(err),
                  })
                  return false
                })
              if (!ok) return
              showToast({ variant: "success", icon: "circle-check", title: "Config imported" })
            }}
          >Import</ButtonV2>
        </div>
      </div>

      <div class="settings-v2-tab-body settings-v2-providers">
        <div class="settings-v2-section" data-component="connected-providers-section">
          <h3 class="settings-v2-section-title">{language.t("settings.providers.section.connected")}</h3>
          <SettingsListV2>
            <Show
              when={connected().length > 0}
              fallback={
                <div class="settings-v2-provider-empty">{language.t("settings.providers.connected.empty")}</div>
              }
            >
              <For each={connected()}>
                {(item) => (
                  <div class="settings-v2-provider-row group">
                    <div class="settings-v2-provider-lead">
                      <ProviderIcon
                        id={item.id}
                        width={PROVIDER_ICON_SIZE}
                        height={PROVIDER_ICON_SIZE}
                        class="settings-v2-provider-icon shrink-0"
                      />
                      <div class="settings-v2-provider-main">
                        <span class="settings-v2-provider-name truncate">{item.name}</span>
                        <Tag>{type(item)}</Tag>
                      </div>
                    </div>
                    <Show
                      when={canDisconnect(item)}
                      fallback={
                        <span class="settings-v2-provider-env-hint">
                          {language.t("settings.providers.connected.environmentDescription")}
                        </span>
                      }
                    >
                      <ButtonV2 size="normal" variant="ghost-muted" onClick={() => void disconnect(item.id, item.name)}>
                        {language.t("common.disconnect")}
                      </ButtonV2>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </SettingsListV2>
        </div>

        <div class="settings-v2-section">
          <h3 class="settings-v2-section-title">{language.t("settings.providers.section.popular")}</h3>
          <SettingsListV2>
            <For each={popular()}>
              {(item) => (
                <div class="settings-v2-provider-row">
                  <div class="settings-v2-provider-lead">
                    <ProviderIcon
                      id={item.id}
                      width={PROVIDER_ICON_SIZE}
                      height={PROVIDER_ICON_SIZE}
                      class="settings-v2-provider-icon shrink-0"
                    />
                    <div class="settings-v2-provider-copy">
                      <div class="settings-v2-provider-main">
                        <span class="settings-v2-provider-name">{item.name}</span>
                      </div>
                      <Show when={note(item.id)}>
                        {(key) => <p class="settings-v2-provider-description">{language.t(key())}</p>}
                      </Show>
                    </div>
                  </div>
                  <ButtonV2
                    size="normal"
                    variant="neutral"
                    icon="plus"
                    onClick={() => {
                      dialog.show(() => <DialogConnectProvider provider={item.id} />)
                    }}
                  >
                    {language.t("common.connect")}
                  </ButtonV2>
                </div>
              )}
            </For>

            <div class="settings-v2-provider-row" data-component="custom-provider-section">
              <div class="settings-v2-provider-lead">
                <ProviderIcon
                  id="synthetic"
                  width={PROVIDER_ICON_SIZE}
                  height={PROVIDER_ICON_SIZE}
                  class="settings-v2-provider-icon shrink-0"
                />
                <div class="settings-v2-provider-copy">
                  <div class="settings-v2-provider-main">
                    <span class="settings-v2-provider-name">{language.t("provider.custom.title")}</span>
                    <Tag>{language.t("settings.providers.tag.custom")}</Tag>
                  </div>
                  <p class="settings-v2-provider-description">{language.t("settings.providers.custom.description")}</p>
                </div>
              </div>
              <ButtonV2
                size="normal"
                variant="neutral"
                icon="plus"
                onClick={() => {
                  dialog.show(() => <DialogCustomProvider back="close" />)
                }}
              >
                {language.t("common.connect")}
              </ButtonV2>
            </div>
          </SettingsListV2>

          <button
            type="button"
            class="settings-v2-providers-view-all"
            onClick={() => {
              dialog.show(() => <DialogSelectProvider />)
            }}
          >
            {language.t("dialog.provider.viewAll")}
          </button>
        </div>
      </div>
    </>
  )
}

function generateConfigTemplate(current: Record<string, unknown>): string {
  const out: Record<string, unknown> = { "$schema": "https://opencode.ai/config.json" }
  if (current.model) out.model = current.model
  if (current.shell) out.shell = current.shell
  if (current.default_agent) out.default_agent = current.default_agent
  if (current.small_model) out.small_model = current.small_model
  if (current.username) out.username = current.username
  if (current.provider) out.provider = current.provider
  if (current.mcp) out.mcp = current.mcp
  if (current.agent) out.agent = current.agent
  if (current.permission) out.permission = current.permission
  return JSON.stringify(out, null, 2) + "\n"
}

function parseJSONC(content: string): Record<string, unknown> | null {
  try {
    // Strip single-line comments but not URLs (don't match ://)
    const stripped = content
      .replace(/(?<!:)\/\/.*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
    return JSON.parse(stripped)
  } catch {
    return null
  }
}
