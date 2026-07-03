import { useFilteredList } from "@novaclaw/ui/hooks"
import { ProviderIcon } from "@novaclaw/ui/provider-icon"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { type Component, For, Show, createMemo, createResource, createSignal } from "solid-js"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { useServer } from "@/context/server"
import { popularProviders } from "@/hooks/use-providers"
import { providerProbe, type ProbeResult } from "@/utils/fs-api"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { DialogModelTier } from "./dialog-model-tier"
import { DialogModelConfig } from "./dialog-model-config"
import "./settings-v2.css"

type ModelItem = ReturnType<ReturnType<typeof useModels>["list"]>[number]

const PROVIDER_ICON_SIZE = 16

// B15 — one-line human rendering of a probe outcome (the config-drift killer: "cannot
// connect" mysteries become "unreachable" / "auth failed" / "not on server" at a glance).
export function probeLabel(result: ProbeResult, t: (key: string) => string): string {
  switch (result.status) {
    case "ok": {
      const latency = result.latencyMs === undefined ? "" : ` · ${result.latencyMs} ms`
      const window = result.window === undefined ? "" : ` · ${t("settings.models.probe.window")} ${Math.round(result.window / 1024)}k`
      return `${t("settings.models.probe.ok")}${latency}${window}`
    }
    case "unreachable":
      return t("settings.models.probe.unreachable")
    case "auth":
      return t("settings.models.probe.auth")
    case "model-missing":
      return t("settings.models.probe.missing")
    case "no-url":
      return t("settings.models.probe.noUrl")
    case "error":
      return `${t("settings.models.probe.error")}${result.detail ? ` (${result.detail})` : ""}`
  }
}

export const SettingsModelsV2: Component = () => {
  const language = useLanguage()
  const models = useModels()
  const global = useGlobal()
  const server = useServer()
  const dialog = useDialog()
  // Dynamic tier i18n keys need the loose-key cast the typed translator otherwise forbids.
  const tk = (key: string) => language.t(key as Parameters<typeof language.t>[0])

  // B15 — probe plumbing. Unlike the global trash store, provider config is DIRECTORY-scoped
  // (a project's novaclaw.jsonc is only visible when the request routes at that project — the
  // M4 learning), so prefer the instance directory over home.
  const conn = createMemo(() => server.current ?? global.servers.list()[0])
  const ctx = createMemo(() => {
    const c = conn()
    return c ? global.ensureServerCtx(c) : undefined
  })
  const [routeDir] = createResource(ctx, async (c) => {
    const p = c.sync.data.path
    if (p && (p.directory || p.home)) return p.directory || p.home
    const got = await c.sdk.client.path
      .get()
      .then((r) => r.data)
      .catch(() => undefined)
    return got?.directory || got?.home || ""
  })
  const [probes, setProbes] = createSignal<Record<string, ProbeResult | "probing" | undefined>>({})

  async function probe(key: { providerID: string; modelID: string }) {
    const cn = conn()
    const d = routeDir()
    if (!cn || !d) return
    const id = `${key.providerID}:${key.modelID}`
    setProbes((prev) => ({ ...prev, [id]: "probing" }))
    const result = await providerProbe(cn.http, {
      directory: d,
      providerID: key.providerID,
      modelID: key.modelID,
    }).catch((error): ProbeResult => ({ status: "error", detail: String(error).slice(0, 120) }))
    setProbes((prev) => ({ ...prev, [id]: result }))
  }

  const list = useFilteredList<ModelItem>({
    items: (_filter) => models.list(),
    key: (x) => `${x.provider.id}:${x.id}`,
    filterKeys: ["provider.name", "name", "id"],
    sortBy: (a, b) => a.name.localeCompare(b.name),
    groupBy: (x) => x.provider.id,
    sortGroupsBy: (a, b) => {
      const aIndex = popularProviders.indexOf(a.category)
      const bIndex = popularProviders.indexOf(b.category)
      const aPopular = aIndex >= 0
      const bPopular = bIndex >= 0

      if (aPopular && !bPopular) return -1
      if (!aPopular && bPopular) return 1
      if (aPopular && bPopular) return aIndex - bIndex

      const aName = a.items[0].provider.name
      const bName = b.items[0].provider.name
      return aName.localeCompare(bName)
    },
  })

  return (
    <>
      <div class="settings-v2-tab-header">
        <h2 class="settings-v2-tab-title">{language.t("settings.models.title")}</h2>
      </div>

      <div class="settings-v2-tab-body settings-v2-models">
        <Show
          when={!list.grouped.loading}
          fallback={
            <div class="settings-v2-models-status">
              {language.t("common.loading")}
              {language.t("common.loading.ellipsis")}
            </div>
          }
        >
          <Show
            when={list.flat().length > 0}
            fallback={
              <div class="settings-v2-models-status">
                <span>{language.t("dialog.model.empty")}</span>
              </div>
            }
          >
            <For each={list.grouped.latest}>
              {(group) => (
                <div class="settings-v2-section" data-component="settings-models-provider">
                  <div class="settings-v2-models-group-header">
                    <ProviderIcon
                      id={group.category}
                      width={PROVIDER_ICON_SIZE}
                      height={PROVIDER_ICON_SIZE}
                      class="settings-v2-models-provider-icon shrink-0"
                    />
                    <h3 class="settings-v2-section-title">{group.items[0].provider.name}</h3>
                  </div>
                  <SettingsListV2>
                    <For each={group.items}>
                      {(item) => {
                        const key = { providerID: item.provider.id, modelID: item.id }
                        const probeState = () => probes()[`${key.providerID}:${key.modelID}`]
                        const probeResult = () => {
                          const state = probeState()
                          return state && state !== "probing" ? state : undefined
                        }
                        return (
                          <SettingsRowV2 title={item.name} description="">
                            <div class="settings-v2-models-row-actions">
                              <ButtonV2
                                size="small"
                                variant="neutral"
                                aria-label={language.t("settings.models.tier.pick")}
                                onClick={() =>
                                  dialog.show(() => (
                                    <DialogModelTier
                                      modelName={item.name}
                                      current={models.tier.get(key)}
                                      onSelect={(tier) => models.tier.set(key, tier)}
                                    />
                                  ))
                                }
                              >
                                {tk(`settings.models.tier.${models.tier.get(key)}.name`)}
                              </ButtonV2>
                              <ButtonV2
                                size="small"
                                variant="ghost-muted"
                                aria-label={language.t("settings.models.config.open")}
                                onClick={() =>
                                  dialog.show(() => (
                                    <DialogModelConfig
                                      providerID={key.providerID}
                                      modelID={key.modelID}
                                      modelName={item.name}
                                      defaults={{
                                        reasoning: (item as { reasoning?: boolean }).reasoning,
                                        tool_call: (item as { tool_call?: boolean }).tool_call,
                                        limit: (item as { limit?: { context?: number; output?: number } }).limit,
                                        modalities: (item as { modalities?: { input?: string[]; output?: string[] } })
                                          .modalities,
                                      }}
                                    />
                                  ))
                                }
                              >
                                {language.t("settings.models.config.open")}
                              </ButtonV2>
                              <Show when={probeResult()}>
                                {(result) => (
                                  <span
                                    class="settings-v2-models-probe-result"
                                    data-status={result().status}
                                    title={result().detail ?? ""}
                                  >
                                    {probeLabel(result(), language.t)}
                                  </span>
                                )}
                              </Show>
                              <ButtonV2
                                size="small"
                                variant="neutral"
                                disabled={probeState() === "probing"}
                                onClick={() => void probe(key)}
                              >
                                {probeState() === "probing"
                                  ? language.t("settings.models.probe.probing")
                                  : language.t("settings.models.probe.test")}
                              </ButtonV2>
                              <Switch
                                checked={models.visible(key)}
                                onChange={(checked) => {
                                  models.setVisibility(key, checked)
                                }}
                                hideLabel
                              >
                                {item.name}
                              </Switch>
                            </div>
                          </SettingsRowV2>
                        )
                      }}
                    </For>
                  </SettingsListV2>
                </div>
              )}
            </For>
          </Show>
        </Show>
      </div>
    </>
  )
}
