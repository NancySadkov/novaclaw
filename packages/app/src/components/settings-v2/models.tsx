import { useFilteredList } from "@novaclaw/ui/hooks"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { IconButtonV2 } from "@novaclaw/ui/v2/icon-button-v2"
import { Icon } from "@novaclaw/ui/icon"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { type Component, For, Show, createMemo, createResource, createSignal } from "solid-js"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { useModels } from "@/context/models"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { popularProviders } from "@/hooks/use-providers"
import { providerProbe, type ProbeResult } from "@/utils/fs-api"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { DialogModelTier } from "./dialog-model-tier"
import { DialogModelConfig } from "./dialog-model-config"
import { DialogNewModel } from "./dialog-new-model"
import { ModelBundleIO } from "./models-io"
import { useConfirm } from "@/components/dialog-confirm"
import "./settings-v2.css"

type ModelItem = ReturnType<ReturnType<typeof useModels>["list"]>[number]

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
  const serverSync = useServerSync()
  const dialog = useDialog()
  const confirm = useConfirm()
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

  const openNewModel = () => {
    const cn = conn()
    const d = routeDir()
    if (!cn || !d) return
    // push (not show) so the dialog STACKS over Settings instead of disposing it — see dialog.tsx.
    dialog.push(() => <DialogNewModel http={cn.http} directory={d} />)
  }

  // Clone a model into a second catalog entry you can tune independently — the sanctioned way to run
  // the same upstream model under two different local configs (e.g. one with thinking budgeted and one
  // without, to compare them on the same task).
  //
  // The subtlety: a model's LOCAL catalog key doubles as its wire name (`api.id` defaults to the key,
  // and the runner sends `.model({ id: resolved.api.id })`). A clone under a new key would therefore
  // ask the provider for a model that does not exist upstream — so the clone pins `api.id` to the
  // ORIGINAL's wire name explicitly.
  const cloneModel = async (key: { providerID: string; modelID: string }, name: string) => {
    const providers = serverSync().data.config?.providers as
      | Record<string, { models?: Record<string, Record<string, unknown>> }>
      | undefined
    const provider = providers?.[key.providerID] ?? {}
    const source = provider.models?.[key.modelID] ?? {}
    const taken = new Set(Object.keys(provider.models ?? {}))
    let cloneID = `${key.modelID}-copy`
    for (let n = 2; taken.has(cloneID); n += 1) cloneID = `${key.modelID}-copy-${n}`
    const sourceApi = source.api as { id?: string } | undefined
    const entry = {
      ...source,
      name: `${name} (copy)`,
      api: { ...(sourceApi ?? {}), id: sourceApi?.id ?? key.modelID },
    }
    try {
      await serverSync().updateConfig({
        providers: {
          [key.providerID]: { ...provider, models: { ...(provider.models ?? {}), [cloneID]: entry } },
        },
      } as never)
      showToast({
        variant: "success",
        icon: "circle-check",
        title: language.t("settings.models.clone.toast.done", { model: entry.name }),
      })
    } catch (error) {
      showToast({
        title: language.t("settings.models.clone.toast.failed"),
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const removeModel = async (key: { providerID: string; modelID: string }, name: string) => {
    const ok = await confirm({
      title: language.t("settings.models.remove.confirm.title", { model: name }),
      description: language.t("settings.models.remove.confirm.description"),
      confirmLabel: language.t("settings.models.remove.confirm.action"),
      destructive: true,
    })
    if (!ok) return
    models.remove(key)
  }

  const list = useFilteredList<ModelItem>({
    items: (_filter) => models.list(),
    key: (x) => `${x.provider.id}:${x.id}`,
    filterKeys: ["provider.name", "name", "id"],
    // Flat list (no provider headers): keep same-provider models adjacent, then sort by name.
    sortBy: (a, b) => a.provider.name.localeCompare(b.provider.name) || a.name.localeCompare(b.name),
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
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <h2 class="settings-v2-tab-title">{language.t("settings.models.title")}</h2>
          <div class="flex items-center gap-2 flex-wrap justify-end">
            {/* The whole-config Export/Import moved to Settings → General (owner 2026-07-22) —
                it is instance configuration, not a models tool. */}
            <ModelBundleIO />
            <ButtonV2 size="small" variant="neutral" onClick={openNewModel}>
              {language.t("settings.models.new.open")}
            </ButtonV2>
          </div>
        </div>
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
            <SettingsListV2>
              <For each={list.flat()}>
                      {(item) => {
                        const key = { providerID: item.provider.id, modelID: item.id }
                        const probeState = () => probes()[`${key.providerID}:${key.modelID}`]
                        const probeResult = () => {
                          const state = probeState()
                          return state && state !== "probing" ? state : undefined
                        }
                        return (
                          <SettingsRowV2 title={item.name} description={item.provider.name}>
                            <div class="settings-v2-models-row-actions">
                              <ButtonV2
                                size="small"
                                variant="neutral"
                                aria-label={language.t("settings.models.tier.pick")}
                                onClick={() =>
                                  dialog.push(() => (
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
                                  dialog.push(() => (
                                    <DialogModelConfig
                                      providerID={key.providerID}
                                      modelID={key.modelID}
                                      modelName={item.name}
                                      defaults={{
                                        reasoning: item.variants.length > 0,
                                        tool_call: item.capabilities.tools,
                                        limit: item.limit,
                                        modalities: {
                                          input: [...item.capabilities.input],
                                          output: [...item.capabilities.output],
                                        },
                                      }}
                                    />
                                  ))
                                }
                              >
                                {language.t("settings.models.config.open")}
                              </ButtonV2>
                              <ButtonV2
                                size="small"
                                variant="ghost-muted"
                                aria-label={language.t("settings.models.clone.action")}
                                onClick={() => void cloneModel(key, item.name)}
                              >
                                {language.t("settings.models.clone.action")}
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
                              <IconButtonV2
                                size="small"
                                variant="ghost-muted"
                                aria-label={language.t("settings.models.remove.confirm.action")}
                                icon={<Icon name="trash" size="small" />}
                                onClick={() => void removeModel(key, item.name)}
                              />
                            </div>
                          </SettingsRowV2>
                        )
                      }}
              </For>
            </SettingsListV2>
          </Show>
        </Show>
      </div>
    </>
  )
}
