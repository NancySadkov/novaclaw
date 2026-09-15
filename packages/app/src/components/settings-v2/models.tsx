import { useFilteredList } from "@novaclaw/ui/hooks"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { Switch } from "@novaclaw/ui/v2/switch-v2"
import { IconButtonV2 } from "@novaclaw/ui/v2/icon-button-v2"
import { Icon } from "@novaclaw/ui/v2/icon"
import { useDialog } from "@novaclaw/ui/context/dialog"
import {
  DragDropProvider,
  DragDropSensors,
  SortableProvider,
  closestCenter,
  createSortable,
  type DragEvent,
} from "@thisbeyond/solid-dnd"
import * as Timestamp from "@novaclaw/schema/time"
import { type Component, For, Show, createEffect, createMemo, createResource, createSignal, onCleanup } from "solid-js"
import type { JSX } from "solid-js"
import { useGlobal } from "@/context/global"
import { useLanguage, type Translator } from "@/context/language"
import { useModels } from "@/context/models"
import { useServer } from "@/context/server"
import { useServerSync } from "@/context/server-sync"
import { formatTokensPerSecond } from "@/utils/token-rate"
import { popularProviders } from "@/hooks/use-providers"
import { providerProbe, type ProbeResult } from "@/utils/fs-api"
import { reportedWrite } from "@/utils/config-write"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { DialogModelConfig } from "./dialog-model-config"
import { DialogModelStats } from "./dialog-model-stats"
import { DialogNewModel } from "./dialog-new-model"
import { ModelBundleIO } from "./models-io"
import { useConfirm } from "@/components/dialog-confirm"
import { scopedDirectory } from "@/utils/routing-directory"
import { applyModelOrder, modelOrderRef, moveModelOrder } from "./model-list-order"

type ModelItem = ReturnType<ReturnType<typeof useModels>["list"]>[number]

const naturalModelSort = (a: ModelItem, b: ModelItem) => {
  const aPopular = popularProviders.indexOf(a.provider.id)
  const bPopular = popularProviders.indexOf(b.provider.id)
  if (aPopular >= 0 || bPopular >= 0) {
    if (aPopular < 0) return 1
    if (bPopular < 0) return -1
    if (aPopular !== bPopular) return aPopular - bPopular
  }
  return a.provider.name.localeCompare(b.provider.name) || a.name.localeCompare(b.name)
}

/** Keep the overview human: endpoint URLs belong in Configure, not in every model row. */
export const modelProviderLabel = (name: string): string | undefined => {
  const label = name.trim()
  return /^https?:\/\//i.test(label) ? undefined : label || undefined
}

const SortableModelRow: Component<{
  item: ModelItem
  isDefault: boolean
  saving: boolean
  dragLabel: string
  dragHint: string
  defaultLabel: string
  onKeyboardMove: (direction: -1 | 1) => void
  /** Live generation readout for this model (t/s + sessions on it). A thunk so it stays reactive. */
  live?: () => JSX.Element
  children: JSX.Element
}> = (props) => {
  // eslint-disable-next-line solid/reactivity -- a catalog key is stable for this keyed row's lifetime
  const sortable = createSortable(modelOrderRef(props.item))
  let dragTarget: HTMLButtonElement | undefined

  // The model name is the drag target: it is already the object the user means to move. Keeping the
  // activator off the row protects Configure/Test/Switch, without asking anyone to decipher a dot
  // glyph or hold a tiny handle.
  createEffect(() => {
    if (!dragTarget) return
    const activators = sortable.dragActivators
    const listeners = Object.entries(activators).map(
      ([name, listener]) => [name.startsWith("on") ? name.slice(2) : name, listener as EventListener] as const,
    )
    for (const [name, listener] of listeners) dragTarget.addEventListener(name, listener)
    onCleanup(() => {
      if (!dragTarget) return
      for (const [name, listener] of listeners) dragTarget.removeEventListener(name, listener)
    })
  })

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
    event.preventDefault()
    props.onKeyboardMove(event.key === "ArrowUp" ? -1 : 1)
  }

  return (
    <div
      ref={sortable.ref}
      data-component="settings-v2-model-sortable"
      data-default={props.isDefault ? "true" : undefined}
      data-dragging={sortable.isActiveDraggable ? "true" : undefined}
      style={{ transform: `translate3d(${sortable.transform.x}px, ${sortable.transform.y}px, 0)` }}
    >
      <SettingsRowV2
        title={
          <div class="settings-v2-models-identity">
            <button
              ref={dragTarget}
              type="button"
              class="settings-v2-models-drag-target"
              aria-label={props.dragLabel}
              title={props.dragHint}
              disabled={props.saving}
              onKeyDown={onKeyDown}
            >
              <span class="settings-v2-models-name">{props.item.name}</span>
              <Show when={props.isDefault}>
                <span class="settings-v2-models-default-badge">
                  <Icon name="circle-check" size="small" />
                  {props.defaultLabel}
                </span>
              </Show>
            </button>
            <Show when={props.live}>
              <span class="settings-v2-models-live" data-slot="settings-v2-models-live">
                {props.live?.()}
              </span>
            </Show>
          </div>
        }
        description={modelProviderLabel(props.item.provider.name)}
      >
        {props.children}
      </SettingsRowV2>
    </div>
  )
}

// B15 — one-line human rendering of a probe outcome (the config-drift killer: "cannot
// connect" mysteries become "unreachable" / "auth failed" / "not on server" at a glance).
export function probeLabel(result: ProbeResult, t: Translator): string {
  const detail = result.detail ? ` · ${result.detail}` : ""
  switch (result.status) {
    case "ok": {
      const latency = result.latencyMs === undefined ? "" : ` · ${result.latencyMs} ms`
      const window =
        result.window === undefined
          ? ""
          : ` · ${t("settings.models.probe.window")} ${Math.round(result.window / 1024)}k`
      const attempts =
        result.completionAttempts && result.completionAttempts > 1 ? ` · ${result.completionAttempts} attempts` : ""
      const tools = result.capabilities
        ? ` · ${t(`settings.models.probe.tools.${result.capabilities.choice}` as never)}`
        : ""
      return `${t("settings.models.probe.ok")}${latency}${window}${attempts}${tools}${detail}`
    }
    case "unreachable":
      return `${t("settings.models.probe.unreachable")}${detail}`
    case "auth":
      return `${t("settings.models.probe.auth")}${detail}`
    case "model-missing":
      return `${t("settings.models.probe.missing")}${detail}`
    case "no-url":
      return `${t("settings.models.probe.noUrl")}${detail}`
    case "error":
      return `${t("settings.models.probe.error")}${detail}`
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
    if (p && scopedDirectory(p)) return scopedDirectory(p)
    const got = await c.sdk.client.path
      .get()
      .then((r) => r.data)
      .catch(() => undefined)
    return scopedDirectory(got)
  })
  /**
   * Per-model live activity: tokens/s generated right now, and how many sessions are on that model.
   *
   * Both come from the already-synced session store — `session_live(id).tps` is the renderer's own
   * delta accumulator, `session_working(id)` is the one busy predicate — so this adds a readout, not
   * a poll. A session is attributed to the model it will RUN on: the session's own pin first, then
   * its officer's configured model, then the instance default. That mirrors the client resolution
   * chain, and a session with none of the three has nothing honest to attribute it to, so it is
   * skipped rather than guessed.
   */
  const modelActivity = createMemo(() => {
    const sessionStore = serverSync().session
    const defaultRef = serverSync().data.config?.model
    const roster = new Map((ctx()?.agents.list() ?? []).map((agent) => [agent.id, agent]))
    const out = new Map<string, { tps: number; agents: number }>()
    for (const id of Object.keys(sessionStore.data.info)) {
      const info = sessionStore.data.info[id]
      if (!info) continue
      let providerID = info.model?.providerID
      let modelID = info.model?.id
      if ((!providerID || !modelID) && info.agent) {
        const bound = roster.get(info.agent)?.model
        if (bound) {
          providerID = bound.providerID
          modelID = bound.id
        }
      }
      if ((!providerID || !modelID) && defaultRef) {
        const [provider, model] = defaultRef.split("/")
        providerID = provider
        modelID = model
      }
      if (!providerID || !modelID) continue
      const key = `${providerID}:${modelID}`
      const entry = out.get(key) ?? { tps: 0, agents: 0 }
      entry.tps += sessionStore.data.session_live(id)?.tps ?? 0
      if (sessionStore.data.session_working(id)) entry.agents += 1
      out.set(key, entry)
    }
    return out
  })

  /** "12 t/s · 2 using", or "idle" — read at render, so it tracks the live store. */
  const liveLabel = (item: ModelItem): string => {
    const activity = modelActivity().get(`${item.provider.id}:${item.id}`)
    if (!activity || (activity.tps <= 0 && activity.agents === 0)) return language.t("settings.models.live.idle")
    const rate = formatTokensPerSecond(activity.tps) ?? language.t("settings.models.live.idle")
    return `${rate} t/s · ${language.t("settings.models.live.using", { count: activity.agents })}`
  }

  const [probes, setProbes] = createSignal<Record<string, ProbeResult | "probing" | undefined>>({})
  const [pendingOrder, setPendingOrder] = createSignal<string[] | undefined>()
  const [savingOrder, setSavingOrder] = createSignal(false)

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
      // The ordinary Test owns endpoint capability negotiation too. Keeping a second tool-channel
      // test inside Configure made the same health check look like two unrelated chores.
      capabilities: true,
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
      const refreshed = await serverSync().refetchProviders()
      const visible = refreshed?.models.get(key.providerID) ?? []
      if (!visible.some((model) => model.id === cloneID)) {
        throw new Error(language.t("settings.models.new.refreshMissing", { count: 1 }))
      }
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
    // Two writes, and both are needed for different reasons.
    //
    // ① The SERVER delete is the real one. Until 2026-08-06 this button wrote ONLY the client store,
    //    so a destructive confirm dialog performed a per-browser-profile hide while stating an
    //    instance-wide fact: an agent choosing a model, a second device, and any headless instance
    //    all still saw the entry. That is ruling 2, and it defeated the point of a prune.
    // ② The CLIENT hide stays as an immediate-feedback cover, NOT as the mechanism.
    //    ⚠️ **Its reason CHANGED on 2026-08-06 and the old one is gone.** It used to cover a
    //    server-side staleness: the live per-location catalog snapshot served the old list until the
    //    next `serve` boot. That is fixed — the handler now fires the same `catalog` domain refresh
    //    a `PATCH /config` does, and it is proven end to end against a running instance (9 models →
    //    DELETE 204 → 8 models on `/api/model`, no restart between the reads).
    //    What this line still covers is only the CLIENT hop: whether `serverSync` pushes the
    //    re-materialised catalog to an open tab promptly. That is unverified, not known-broken, and
    //    the window is at worst a sync tick rather than a reboot. ⏳ Verify it and this line goes —
    //    keeping a cover for a fault that no longer exists is the cruft the vision rules against, so
    //    it stays only until someone checks the push.
    //
    // ⚠️ A failed delete must not hide the row: that would recreate exactly the local-only illusion
    // this change exists to remove. So the local write happens only after the server confirms.
    const c = ctx()
    const dir = routeDir()
    if (!c) return
    // ⚠️ And a refused delete must SAY SO (ruling 2). It used to end at `.catch(() => false)`: the
    // row correctly stayed, and nothing anywhere told the user why — leaving "the delete failed" and
    // "the button is broken" indistinguishable after a destructive confirm they had just answered.
    // The verdict is a VALUE now (`utils/config-write.ts`), so the local hide sits behind a check the
    // type puts in front of it rather than behind a boolean this function had to remember to test.
    const deleted = await reportedWrite(
      () =>
        c.sdk.client.v2.provider.removeModel({
          providerID: key.providerID,
          modelID: key.modelID,
          ...(dir ? { location: { directory: dir } } : {}),
        }),
      (error) =>
        showToast({
          variant: "error",
          title: language.t("settings.models.remove.toast.failed", { model: name }),
          description: error,
        }),
    )
    if (!deleted.ok) return
    models.remove(key)
  }

  const storedOrder = () => serverSync().data.config.model_order ?? []
  const displayedItems = () =>
    applyModelOrder([...models.list()].sort(naturalModelSort), pendingOrder() ?? storedOrder())

  const list = useFilteredList<ModelItem>({
    items: (_filter) => displayedItems(),
    key: (x) => `${x.provider.id}:${x.id}`,
    filterKeys: ["provider.name", "name", "id"],
  })

  // `catalog.model.default()` first honours the stored ref, then falls back to the newest usable
  // model. Mirror that exact rule so the badge always states what a fresh unpinned session will use,
  // including on an untouched install where no explicit `model` row exists yet.
  const effectiveDefault = createMemo(() => {
    const configured = serverSync().data.config.model
    const exact = configured ? models.list().find((item) => modelOrderRef(item) === configured) : undefined
    if (exact && models.enabled({ providerID: exact.provider.id, modelID: exact.id })) return configured

    let newest: ModelItem | undefined
    let newestAt = Number.NEGATIVE_INFINITY
    for (const item of models.list()) {
      if (!models.enabled({ providerID: item.provider.id, modelID: item.id })) continue
      const released = Timestamp.toEpochMillis(item.time.released) ?? Number.NEGATIVE_INFINITY
      if (released <= newestAt) continue
      newest = item
      newestAt = released
    }
    return newest ? modelOrderRef(newest) : undefined
  })

  const persistOrder = async (refs: string[]) => {
    if (savingOrder()) return
    setPendingOrder(refs)
    setSavingOrder(true)
    try {
      // `model_order` is a Config.Info settings key, so ConfigStoreWrite stores this whole array in
      // runtime_setting (SQLite). It is deliberately not localStorage: the instance has one model
      // catalog and every client must see the same arrangement.
      await serverSync().updateConfig({ model_order: refs }, { refetch: false })
      await serverSync().refetchConfig()
      setPendingOrder(undefined)
    } catch (error) {
      setPendingOrder(undefined)
      showToast({
        variant: "error",
        title: language.t("settings.models.order.failed"),
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setSavingOrder(false)
    }
  }

  const moveByKeyboard = (ref: string, direction: -1 | 1) => {
    if (savingOrder()) return
    const refs = list.flat().map(modelOrderRef)
    const at = refs.indexOf(ref)
    const target = at + direction
    if (at < 0 || target < 0 || target >= refs.length) return
    const next = moveModelOrder(refs, ref, refs[target]!)
    if (next) void persistOrder(next)
  }

  const onDragEnd = (event: DragEvent) => {
    if (savingOrder()) return
    const { draggable, droppable } = event
    if (!draggable || !droppable) return
    const next = moveModelOrder(list.flat().map(modelOrderRef), String(draggable.id), String(droppable.id))
    if (next) void persistOrder(next)
  }

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
            <DragDropProvider onDragEnd={onDragEnd} collisionDetector={closestCenter}>
              <DragDropSensors />
              <SortableProvider ids={list.flat().map(modelOrderRef)}>
                <SettingsListV2>
                  <For each={list.flat()}>
                    {(item) => {
                      const key = { providerID: item.provider.id, modelID: item.id }
                      const ref = modelOrderRef(item)
                      const probeState = () => probes()[`${key.providerID}:${key.modelID}`]
                      const configuredModel = () =>
                        (
                          serverSync().data.config?.providers as
                            | Record<
                                string,
                                {
                                  models?: Record<
                                    string,
                                    {
                                      benchmark?: { name: string; score: number; source: string }
                                      prefixCache?: { enabled: boolean; ttlMinutes?: number }
                                    }
                                  >
                                }
                              >
                            | undefined
                        )?.[key.providerID]?.models?.[key.modelID]
                      const probeResult = () => {
                        const state = probeState()
                        return state && state !== "probing" ? state : undefined
                      }
                      return (
                        <SortableModelRow
                          item={item}
                          isDefault={effectiveDefault() === ref}
                          saving={savingOrder()}
                          dragLabel={language.t("settings.models.order.drag", { model: item.name })}
                          dragHint={language.t("settings.models.order.hint")}
                          defaultLabel={language.t("settings.models.default.badge")}
                          onKeyboardMove={(direction) => moveByKeyboard(ref, direction)}
                          live={() => liveLabel(item)}
                        >
                          <div class="settings-v2-models-row-actions">
                            <div class="settings-v2-models-row-controls">
                              <ButtonV2
                                size="small"
                                variant="ghost-muted"
                                aria-label={language.t("settings.models.stats.open")}
                                onClick={() => {
                                  const cn = conn()
                                  if (!cn) return
                                  dialog.push(() => (
                                    <DialogModelStats
                                      http={cn.http}
                                      modelRef={ref}
                                      modelName={item.name}
                                      benchmark={configuredModel()?.benchmark ?? item.benchmark}
                                      prefixCache={configuredModel()?.prefixCache ?? item.prefixCache}
                                    />
                                  ))
                                }}
                              >
                                {language.t("settings.models.stats.open")}
                              </ButtonV2>
                              <ButtonV2
                                size="small"
                                variant="ghost-muted"
                                aria-label={language.t("settings.models.config.open")}
                                onClick={() => {
                                  const cn = conn()
                                  const dir = routeDir()
                                  // The same guard the sibling openers use: without a connection and a
                                  // directory the dialog cannot probe, and pushing it anyway would offer a
                                  // Test button that fails for a reason the user cannot see.
                                  if (!cn || !dir) return
                                  dialog.push(() => (
                                    <DialogModelConfig
                                      http={cn.http}
                                      directory={dir}
                                      providerID={key.providerID}
                                      modelID={key.modelID}
                                      modelName={item.name}
                                      apiModelID={item.api.id}
                                      providerApi={item.provider.api}
                                      defaults={{
                                        capabilities: {
                                          tools: item.capabilities.tools,
                                          input: [...item.capabilities.input],
                                          output: [...item.capabilities.output],
                                        },
                                      }}
                                    />
                                  ))
                                }}
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
                                checked={models.enabled(key)}
                                onChange={(checked) => {
                                  // 🔴 This switch ENABLES/DISABLES the model for the whole instance — it
                                  // writes config, and the server rebuilds its catalog on the spot. It is
                                  // not the picker's show/hide preference, which lives in this browser and
                                  // which the server cannot see; wiring that one here is what made a
                                  // switched-off model carry on answering prompts.
                                  void models
                                    .setEnabled(key, checked)
                                    .then(() =>
                                      showToast({
                                        variant: "success",
                                        icon: "circle-check",
                                        title: checked
                                          ? language.t("settings.models.enable.toast.on", { model: item.name })
                                          : language.t("settings.models.enable.toast.off", { model: item.name }),
                                      }),
                                    )
                                    .catch((error: unknown) =>
                                      showToast({
                                        variant: "error",
                                        title: language.t("settings.models.enable.toast.failed", {
                                          model: item.name,
                                          error: error instanceof Error ? error.message : String(error),
                                        }),
                                      }),
                                    )
                                }}
                                hideLabel
                              >
                                {item.name}
                              </Switch>
                              <IconButtonV2
                                size="small"
                                variant="ghost-muted"
                                aria-label={language.t("settings.models.remove.confirm.action")}
                                icon={<Icon name="trash" size="normal" />}
                                onClick={() => void removeModel(key, item.name)}
                              />
                            </div>
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
                          </div>
                        </SortableModelRow>
                      )
                    }}
                  </For>
                </SettingsListV2>
              </SortableProvider>
            </DragDropProvider>
          </Show>
        </Show>
      </div>
    </>
  )
}
